import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
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
import { AnalyticsService } from '../analytics/analytics.service.js';
import { Roles, type AuthUser } from '../auth/auth.js';
import { BroadcastService } from '../broadcasts/broadcast.service.js';
import { todayInLagos, type IsoDate } from '../common/calendar.js';
import { AdoptionService } from '../adoption/adoption.service.js';
import { CxService } from '../cx/cx.service.js';
import { OrgService } from '../org/org.service.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { ReportBuilder } from '../reports/report-builder.js';
import { ReportService } from '../reports/report.service.js';
import { AUDIENCES, CADENCES, type Audience, type Cadence } from '../reports/report-types.js';

type Req = { user: AuthUser };

const MANAGERS = ['cs_director', 'cs_team_lead', 'viewer'] as const;

function dateParam(v: string | undefined, name = 'date'): IsoDate {
  if (v === undefined || v === '') return todayInLagos();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  return v;
}

// ====================================================================== phase 3: analytics and reports

@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  /** US-19 (total ARR), 10 (health), 06 (contractor seats), 08 (adoption). */
  @Get('portfolio')
  @Roles(...MANAGERS)
  async portfolio(@Query('date') date?: string) {
    const p = await this.analytics.portfolio(dateParam(date));
    if (!p) throw new NotFoundException('No data has been loaded yet');
    return p;
  }

  /** US-09 (churn), 11 (renewals), 07 (expansion), 12 (tickets) for a period. */
  @Get('period')
  @Roles(...MANAGERS)
  async period(@Query('from') from?: string, @Query('to') to?: string) {
    const toDate = dateParam(to, 'to');
    const fromDate = dateParam(from, 'from');
    if (fromDate > toDate) throw new BadRequestException('from must not be after to');
    const p = await this.analytics.period(fromDate, toDate);
    if (!p) throw new NotFoundException('No data covers that period yet');
    return p;
  }

  /** US-18: each CSM's ARR against the start-of-year baseline. */
  @Get('ledger')
  @Roles(...MANAGERS)
  async ledger(@Query('year') year?: string, @Query('date') date?: string) {
    const y = year ? Number(year) : Number(todayInLagos().slice(0, 4));
    if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new BadRequestException('year must be a four-digit year');
    const l = await this.analytics.ledger(y, dateParam(date));
    if (!l) throw new NotFoundException(`No baseline has been captured for ${y} yet. It is written on 1 January, or run: node dist/cli.js baseline --date ${y}-01-01`);
    return l;
  }
}

/** Who may preview which report. */
const REPORT_ACCESS: Record<string, Audience[]> = {
  super_admin: AUDIENCES, cs_director: AUDIENCES, cs_team_lead: AUDIENCES, viewer: AUDIENCES,
  csm: ['csm'], implementation_manager: ['implementation'], support_specialist: ['support'],
};

@Controller('reports')
export class ReportScheduleController {
  constructor(
    @Inject(ReportBuilder) private readonly builder: ReportBuilder,
    @Inject(ReportService) private readonly reports: ReportService,
    @Inject(OrgService) private readonly org: OrgService,
  ) {}

  @Get('schedules')
  @Roles(...MANAGERS)
  schedules() {
    return this.reports.schedules();
  }

  @Put('schedules/:key')
  @Roles('cs_director')
  async update(@Req() req: Req, @Param('key') key: string, @Body() body: { enabled?: unknown; channels?: unknown }) {
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    if (body?.channels !== undefined && (!Array.isArray(body.channels) || body.channels.some((c) => typeof c !== 'string'))) throw new BadRequestException('channels must be a list');
    try {
      return await this.reports.updateSchedule(key, { enabled: body?.enabled as boolean | undefined, channels: body?.channels as string[] | undefined }, req.user.email);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  /** The report as data, so the web app can draw it. A CSM only ever sees their own portfolio. */
  @Get('preview')
  @Roles('csm', 'implementation_manager', 'support_specialist', ...MANAGERS)
  async preview(@Req() req: Req, @Query('audience') audience = 'executive', @Query('cadence') cadence = 'weekly', @Query('date') date?: string, @Query('csm') csm?: string) {
    if (!AUDIENCES.includes(audience as Audience)) throw new BadRequestException(`audience must be one of: ${AUDIENCES.join(', ')}`);
    if (!CADENCES.includes(cadence as Cadence)) throw new BadRequestException(`cadence must be one of: ${CADENCES.join(', ')}`);
    const allowed = req.user.role === 'super_admin' ? AUDIENCES : (REPORT_ACCESS[req.user.role] ?? []);
    if (!allowed.includes(audience as Audience)) throw new ForbiddenException('Your role cannot view this report');
    let who: string | { emails: string[]; label: string } | undefined;
    if (audience === 'csm') {
      // A person's own portfolio (?csm=<email>), or their whole team: everyone under them, or everyone for a director.
      const scope = await this.org.scopeFor(req.user);
      if (csm) {
        if (!OrgService.includes(scope, csm)) throw new NotFoundException('Nobody by that email in your team');
        who = csm;
      } else if (req.user.role === 'csm' && scope.emails.size <= 1) {
        who = req.user.email;
      } else {
        const csms = (await this.org.csmsIn(scope)).map((u) => u.email);
        if (csms.length === 0) throw new BadRequestException('There are no CSMs in your team yet');
        who = { emails: csms, label: scope.all ? 'all CSMs' : 'your team' };
      }
    }
    const report = await this.builder.build(audience as Audience, cadence as Cadence, dateParam(date), who);
    if (!report) throw new NotFoundException('No data has been loaded yet');
    return report;
  }
}

// ====================================================================== phase 4: CX tools

@Controller('cx')
export class CxController {
  constructor(
    @Inject(CxService) private readonly cx: CxService,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(OrgService) private readonly org: OrgService,
  ) {}

  /** US-27: expansion radar. A CSM sees only their own accounts. */
  @Get('radar')
  @Roles('csm', ...MANAGERS)
  async radar(@Req() req: Req, @Query('date') date?: string) {
    const r = await this.cx.radar(dateParam(date));
    if (!r) throw new NotFoundException('No data has been loaded yet');
    const scope = await this.org.scopeFor(req.user);
    return scope.all ? r : { ...r, entries: r.entries.filter((e) => OrgService.includes(scope, e.csmEmail)) };
  }

  /** US-26: first-90-day scorecard. */
  @Get('scorecard')
  @Roles('implementation_manager', ...MANAGERS)
  async scorecard(@Query('date') date?: string) {
    const s = await this.cx.scorecard(dateParam(date));
    if (!s) throw new NotFoundException('No data has been loaded yet');
    return s;
  }

  /** US-28: the latest ticket themes with draft macros and KB articles. */
  @Get('clusters')
  @Roles('support_specialist', ...MANAGERS)
  async clusters() {
    return { aiEnabled: this.cx.aiEnabled, latest: await this.cx.latestClusters() };
  }

  @Post('clusters/run')
  @HttpCode(200)
  @Roles('support_specialist', 'cs_director')
  async runClusters(@Req() req: Req) {
    const out = await this.cx.clusterTickets(todayInLagos(), req.user.email);
    if (!out) throw new BadRequestException('Not enough recent tickets to find themes, or Claude gave no usable answer. Try again later.');
    return out;
  }

  @Get('accounts/:hubspotId/qbr')
  @Roles('csm', 'cs_director', 'cs_team_lead')
  async latestQbr(@Req() req: Req, @Param('hubspotId') hubspotId: string) {
    await this.ownAccount(req.user, hubspotId);
    return { aiEnabled: this.cx.aiEnabled, latest: await this.cx.latestQbr(hubspotId) };
  }

  /** US-27: draft QBR outline for one account. CSMs can draft only for their own accounts. */
  @Post('accounts/:hubspotId/qbr')
  @HttpCode(200)
  @Roles('csm', 'cs_director', 'cs_team_lead')
  async qbr(@Req() req: Req, @Param('hubspotId') hubspotId: string) {
    await this.ownAccount(req.user, hubspotId);
    const out = await this.cx.qbr(hubspotId, todayInLagos(), req.user.email);
    if (!out) throw new BadRequestException('Claude gave no usable answer, or the account has no data. Try again later.');
    return out;
  }

  private async ownAccount(user: AuthUser, hubspotId: string): Promise<void> {
    const asOf = await this.snapshots.latestSnapshotDate(todayInLagos());
    const company = asOf ? (await this.snapshots.loadCompanies(asOf)).find((c) => c.hubspotId === hubspotId) : undefined;
    if (!company || !OrgService.includes(await this.org.scopeFor(user), company.csmEmail)) throw new NotFoundException('Account not found');
  }
}

// ====================================================================== phase 4: broadcasts

@Controller('broadcasts')
export class BroadcastController {
  constructor(@Inject(BroadcastService) private readonly broadcasts: BroadcastService) {}

  /** Whether this person may use broadcasts at all, so the app can lock the screen with a reason. */
  @Get('access')
  @Roles('csm', 'implementation_manager', 'support_specialist', ...MANAGERS)
  access(@Req() req: Req) {
    return this.broadcasts.access(req.user);
  }

  @Get()
  @Roles('cs_director')
  list(@Req() req: Req) {
    return this.broadcasts.list(req.user);
  }

  @Post('preview')
  @HttpCode(200)
  @Roles('cs_director')
  preview(@Req() req: Req, @Body() body: unknown) {
    return this.broadcasts.preview(body, req.user);
  }

  @Get('runs/:runId')
  @Roles('cs_director')
  run(@Req() req: Req, @Param('runId', ParseIntPipe) runId: number) {
    return this.broadcasts.run(runId, req.user);
  }

  @Post()
  @Roles('cs_director')
  create(@Req() req: Req, @Body() body: unknown) {
    return this.broadcasts.create(body, req.user);
  }

  @Get(':id')
  @Roles('cs_director')
  get(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.broadcasts.get(id, req.user);
  }

  @Put(':id')
  @Roles('cs_director')
  update(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.broadcasts.update(id, body, req.user);
  }

  /** Sends now. `confirmCount` must equal the number of messages the preview showed. */
  @Post(':id/send')
  @HttpCode(200)
  @Roles('cs_director')
  send(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() body: { confirmCount?: unknown }) {
    if (!Number.isInteger(body?.confirmCount)) throw new BadRequestException('Send { "confirmCount": <number of messages shown in the preview> }');
    return this.broadcasts.send(id, body.confirmCount as number, req.user);
  }

  @Post(':id/schedule')
  @HttpCode(200)
  @Roles('cs_director')
  schedule(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() body: { schedule?: unknown }) {
    return this.broadcasts.schedule(id, body?.schedule, req.user);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Roles('cs_director')
  pause(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.broadcasts.pause(id, req.user);
  }

  @Get(':id/runs')
  @Roles('cs_director')
  runs(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.broadcasts.runs(id, req.user);
  }
}

// ====================================================================== the CSM dashboard

@Controller('portfolio')
export class PortfolioController {
  constructor(
    @Inject(PortfolioService) private readonly portfolio: PortfolioService,
    @Inject(OrgService) private readonly org: OrgService,
  ) {}

  /** Every client in your scope with the numbers that matter. `?csm=` narrows to one person under you. */
  @Get()
  @Roles('csm', ...MANAGERS)
  async dashboard(@Req() req: Req, @Query('csm') csm?: string, @Query('date') date?: string) {
    const scope = await this.org.scopeFor(req.user);
    if (csm && !OrgService.includes(scope, csm)) throw new NotFoundException('Nobody by that email in your team');
    const d = await this.portfolio.dashboard(scope, dateParam(date), csm);
    if (!d) throw new NotFoundException('No data has been loaded yet');
    return { ...d, people: (await this.org.csmsIn(scope)).map((u) => ({ email: u.email, name: u.name })) };
  }

  /** The CSMs in your scope, for pickers. */
  @Get('people')
  @Roles('csm', ...MANAGERS)
  async people(@Req() req: Req) {
    return (await this.org.csmsIn(await this.org.scopeFor(req.user))).map((u) => ({ email: u.email, name: u.name }));
  }

  @Get('clients/:hubspotId')
  @Roles('csm', ...MANAGERS)
  async client(@Req() req: Req, @Param('hubspotId') hubspotId: string, @Query('date') date?: string) {
    const c = await this.portfolio.client(await this.org.scopeFor(req.user), dateParam(date), hubspotId);
    if (!c) throw new NotFoundException('Client not found');
    return c;
  }
}

// ====================================================================== product adoption

@Controller('adoption')
export class AdoptionController {
  constructor(
    @Inject(AdoptionService) private readonly adoption: AdoptionService,
    @Inject(OrgService) private readonly org: OrgService,
  ) {}

  /** Modules bought, in use and open for upsell, plus one adoption line per client in your scope. */
  @Get()
  @Roles('csm', ...MANAGERS)
  async overview(@Req() req: Req, @Query('csm') csm?: string, @Query('date') date?: string) {
    const scope = await this.org.scopeFor(req.user);
    if (csm && !OrgService.includes(scope, csm)) throw new NotFoundException('Nobody by that email in your team');
    const o = await this.adoption.overview(scope, dateParam(date), csm);
    if (!o) throw new NotFoundException('No data has been loaded yet');
    return { ...o, people: (await this.org.csmsIn(scope)).map((u) => ({ email: u.email, name: u.name })) };
  }

  /** Administrators, employee activity, support and SLA, and modules for one client. */
  @Get('clients/:hubspotId')
  @Roles('csm', ...MANAGERS)
  async client(@Req() req: Req, @Param('hubspotId') hubspotId: string, @Query('date') date?: string) {
    const c = await this.adoption.client(await this.org.scopeFor(req.user), dateParam(date), hubspotId);
    if (!c) throw new NotFoundException('Client not found');
    return c;
  }
}
