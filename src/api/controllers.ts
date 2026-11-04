import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { verifyAck } from '../alerts/ack-link.js';
import { AuditService } from '../audits/audit.service.js';
import { FlagRepository } from '../audits/flag.repository.js';
import { RulesRepository } from '../audits/rules.repository.js';
import { FLAG_TITLES } from '../alerts/message-format.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { OrgService } from '../org/org.service.js';
import { Public, Roles, type AuthUser } from '../auth/auth.js';
import { JobRunner, JOB_NAMES, type JobName } from '../jobs/job-runner.js';
import { todayInLagos } from '../common/calendar.js';
import { CxService } from '../cx/cx.service.js';

type Req = { user: AuthUser };

const MANAGERS = ['cs_director', 'cs_team_lead', 'viewer'] as const;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#111}
button{font-size:16px;padding:10px 18px;border-radius:6px;border:0;background:#1a56db;color:#fff;cursor:pointer}</style></head>
<body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

@Controller()
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Public()
  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }
}

/**
 * One-click acknowledge from Chat/email. GET shows a confirm button and changes
 * nothing, because mail scanners open links; only the POST acknowledges.
 */
@Controller('ack')
export class AckController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(Database) private readonly db: Database,
  ) {}

  @Public()
  @Get(':id')
  @Header('content-type', 'text/html; charset=utf-8')
  async confirm(@Param('id', ParseIntPipe) id: number, @Query('sig') sig = '') {
    if (!verifyAck(this.cfg.ACK_LINK_SECRET, id, sig)) throw new ForbiddenException('Invalid link');
    const flag = await this.flags.findById(id);
    if (!flag) throw new NotFoundException();
    if (flag.acknowledgedAt) {
      return page('Already acknowledged', `<h2>Already acknowledged</h2><p>${escapeHtml(flag.companyName)}: acknowledged by ${escapeHtml(flag.acknowledgedBy ?? 'someone')}.</p>`);
    }
    return page(
      'Acknowledge alert',
      `<h2>${escapeHtml(FLAG_TITLES[flag.type])}</h2><p><strong>${escapeHtml(flag.companyName)}</strong></p>
<p>${escapeHtml(flag.summary)}</p>
<form method="post" action="/ack/${id}?sig=${encodeURIComponent(sig)}"><button type="submit">I'm on it: acknowledge</button></form>`,
    );
  }

  @Public()
  @Post(':id')
  @HttpCode(200)
  @Header('content-type', 'text/html; charset=utf-8')
  async acknowledge(@Param('id', ParseIntPipe) id: number, @Query('sig') sig = '') {
    if (!verifyAck(this.cfg.ACK_LINK_SECRET, id, sig)) throw new ForbiddenException('Invalid link');
    const flag = await this.flags.findById(id);
    if (!flag) throw new NotFoundException();
    // The link was sent to the flag's CSM, so it acts on their behalf.
    const actor = `${flag.csmEmail ?? 'unassigned'} (via alert link)`;
    const changed = await this.flags.acknowledge(id, actor);
    if (changed) {
      await this.db.query(
        `INSERT INTO action_log (actor, action, object_type, object_id) VALUES ($1, 'flag.acknowledge', 'audit_flag', $2)`,
        [actor, String(id)],
      );
    }
    const next =
      flag.type === 'ENGAGEMENT_DROUGHT'
        ? 'This alert closes once a call, meeting or email with them is logged in HubSpot. Until then it can still escalate to your team lead.'
        : 'It will not escalate. The flag closes automatically once the next audit no longer finds the problem.';
    return page('Acknowledged', `<h2>Thanks, acknowledged</h2><p><strong>${escapeHtml(flag.companyName)}</strong>. ${next}</p>`);
  }
}

@Controller('flags')
export class FlagsController {
  constructor(
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(Database) private readonly db: Database,
    @Inject(CxService) private readonly cx: CxService,
    @Inject(OrgService) private readonly org: OrgService,
  ) {}

  /** Everyone sees their own accounts and those of the people under them. Directors and viewers see all. */
  @Get()
  @Roles('csm', ...MANAGERS)
  async list(
    @Req() req: Req,
    @Query('status') status = 'open',
    @Query('type') type?: string,
    @Query('csm') csm?: string,
    @Query('limit') limit?: string,
    @Query('escalated') escalated?: string,
  ) {
    const scope = await this.org.scopeFor(req.user);
    if (csm && !OrgService.includes(scope, csm)) throw new NotFoundException('Nobody by that email in your team');
    const all = await this.flags.list({
      status: status === 'all' ? undefined : status,
      type,
      csmEmail: csm,
      escalated: escalated === 'true',
      limit: scope.all ? (limit ? Number(limit) : undefined) : 1000,
    });
    if (scope.all) return all;
    const mine = all.filter((f) => OrgService.includes(scope, f.csmEmail));
    return limit ? mine.slice(0, Number(limit)) : mine;
  }

  @Get(':id')
  @Roles('csm', ...MANAGERS)
  async get(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    const flag = await this.flags.findById(id);
    if (!flag || !OrgService.includes(await this.org.scopeFor(req.user), flag.csmEmail)) throw new NotFoundException();
    const { rows: alerts } = await this.db.query(
      'SELECT channel, recipient, kind, status, attempts, error, sent_at FROM alert WHERE flag_id = $1 ORDER BY id',
      [id],
    );
    // US-26: the unblocking playbook Claude wrote for an onboarding alert, when there is one.
    const playbook = flag.type === 'ONBOARDING_STAGNATION' ? await this.cx.latestPlaybook(id) : null;
    return { ...flag, alerts, playbook };
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @Roles('csm', 'cs_director', 'cs_team_lead')
  async acknowledge(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    const flag = await this.flags.findById(id);
    if (!flag || !OrgService.includes(await this.org.scopeFor(req.user), flag.csmEmail)) throw new NotFoundException();
    const changed = await this.flags.acknowledge(id, req.user.email);
    if (changed) {
      await this.db.query(
        `INSERT INTO action_log (actor, action, object_type, object_id) VALUES ($1, 'flag.acknowledge', 'audit_flag', $2)`,
        [req.user.email, String(id)],
      );
    }
    return { acknowledged: true, alreadyAcknowledged: !changed };
  }
}

@Controller('reports')
export class ReportsController {
  constructor(@Inject(AuditService) private readonly audits: AuditService) {}

  /** US-03 reconciliation counts and US-04 sub-account counts from the latest audit run. */
  @Get('latest')
  @Roles(...MANAGERS)
  async latest() {
    const run = await this.audits.latestRunSummary();
    if (!run) throw new NotFoundException('No audit has run yet');
    return run;
  }
}

@Controller('rules')
export class RulesController {
  constructor(@Inject(RulesRepository) private readonly rules: RulesRepository) {}

  @Get()
  @Roles(...MANAGERS)
  list() {
    return this.rules.listWithMeta();
  }

  @Put(':key')
  @Roles('super_admin')
  async update(@Req() req: Req, @Param('key') key: string, @Body() body: { value?: unknown }) {
    if (!body || !('value' in body)) throw new BadRequestException('Body must be { "value": ... }');
    try {
      await this.rules.update(key, body.value, req.user.email);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
    return { key, value: body.value };
  }
}

@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobRunner) private readonly jobs: JobRunner) {}

  /** Manual trigger, same code path as the scheduled Container Apps Jobs. */
  @Post(':name')
  @HttpCode(200)
  @Roles('super_admin')
  run(@Req() req: Req, @Param('name') name: string, @Query('date') date?: string) {
    if (!JOB_NAMES.includes(name as JobName)) throw new BadRequestException(`Unknown job. Use: ${JOB_NAMES.join(', ')}`);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    return this.jobs.run(name as JobName, date ?? todayInLagos(), req.user.email);
  }
}
