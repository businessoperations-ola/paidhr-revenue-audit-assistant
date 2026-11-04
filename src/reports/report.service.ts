import { Inject, Injectable, Logger } from '@nestjs/common';
import { logoUrl } from '../alerts/ack-link.js';
import { ALERT_SENDERS, type AlertSenders } from '../alerts/channels/channels.js';
import { dayOfWeek, type IsoDate } from '../common/calendar.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { ReportBuilder } from './report-builder.js';
import { reportChat, reportHtml, reportText } from './report-format.js';
import type { Audience, Cadence } from './report-types.js';

export interface ReportScheduleRow {
  key: string;
  audience: Audience;
  cadence: Cadence;
  enabled: boolean;
  channels: Array<'email' | 'google_chat'>;
  updatedAt: string;
  updatedBy: string;
}

export interface ReportRunResult {
  date: IsoDate;
  schedulesDue: number;
  sent: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
}

/** Who receives each audience's report. Everyone comes from the app's own user list. */
const RECIPIENT_ROLES: Record<Audience, string[]> = {
  executive: ['super_admin', 'cs_director', 'viewer'],
  csm: ['csm'],
  implementation: ['implementation_manager'],
  support: ['support_specialist'],
};

/** CSM reports are personal, so they are only ever emailed, never posted in a shared space. */
const CHAT_ALLOWED: Audience[] = ['executive', 'implementation', 'support'];
const CHAT_RECIPIENT = 'space:default';

/** US-25: dispatches the daily, weekly and monthly reports that admins have switched on. */
@Injectable()
export class ReportService {
  private readonly log = new Logger(ReportService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(ReportBuilder) private readonly builder: ReportBuilder,
    @Inject(ALERT_SENDERS) private readonly senders: AlertSenders,
  ) {}

  async schedules(): Promise<ReportScheduleRow[]> {
    const { rows } = await this.db.query(
      `SELECT key, audience, cadence, enabled, channels, updated_at, updated_by FROM report_schedule
        ORDER BY array_position(ARRAY['executive','csm','implementation','support'], audience),
                 array_position(ARRAY['daily','weekly','monthly'], cadence)`,
    );
    return rows.map((r) => ({
      key: r.key, audience: r.audience, cadence: r.cadence, enabled: r.enabled, channels: r.channels,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at, updatedBy: r.updated_by,
    }));
  }

  async updateSchedule(key: string, patch: { enabled?: boolean; channels?: string[] }, actor: string): Promise<ReportScheduleRow> {
    const current = (await this.schedules()).find((s) => s.key === key);
    if (!current) throw new Error(`Unknown report schedule: ${key}`);
    const channels = patch.channels ?? current.channels;
    if (!channels.includes('email') || channels.some((c) => c !== 'email' && c !== 'google_chat')) {
      throw new Error('Channels must include email, and may add google_chat');
    }
    if (channels.includes('google_chat') && !CHAT_ALLOWED.includes(current.audience)) {
      throw new Error('CSM reports are personal and can only be emailed');
    }
    await this.db.transaction(async (client) => {
      await client.query('UPDATE report_schedule SET enabled = $2, channels = $3, updated_at = now(), updated_by = $4 WHERE key = $1', [key, patch.enabled ?? current.enabled, channels, actor]);
      await client.query(
        `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, 'report_schedule.update', 'report_schedule', $2, $3)`,
        [actor, key, JSON.stringify({ enabled: patch.enabled ?? current.enabled, channels })],
      );
    });
    return (await this.schedules()).find((s) => s.key === key)!;
  }

  /** Daily reports are always due; weekly ones on Monday; monthly ones on the 1st (all in WAT). */
  static dueCadences(date: IsoDate): Cadence[] {
    return ['daily', ...(dayOfWeek(date) === 1 ? (['weekly'] as const) : []), ...(date.endsWith('-01') ? (['monthly'] as const) : [])];
  }

  async run(date: IsoDate, opts: { cadences?: Cadence[] } = {}): Promise<ReportRunResult> {
    const due = opts.cadences ?? ReportService.dueCadences(date);
    const schedules = (await this.schedules()).filter((s) => s.enabled && due.includes(s.cadence));
    const result: ReportRunResult = { date, schedulesDue: schedules.length, sent: 0, failed: 0, skipped: 0, dryRun: this.cfg.ALERTS_DRY_RUN };
    const appUrl = this.cfg.APP_BASE_URL;
    const logo = logoUrl(this.cfg.APP_BASE_URL);

    for (const s of schedules) {
      const users = await this.recipients(s.audience);
      if (s.audience === 'csm') {
        for (const email of users) await this.deliverEmail(s, date, email, result, () => this.builder.build('csm', s.cadence, date, email));
      } else {
        const report = await this.builder.build(s.audience, s.cadence, date);
        if (!report) {
          this.log.warn(`${s.key}: no snapshot for ${date}, skipped`);
          continue;
        }
        for (const email of users) await this.deliverEmail(s, date, email, result, async () => report);
        if (s.channels.includes('google_chat') && CHAT_ALLOWED.includes(s.audience) && this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK) {
          const webhook = this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK;
          await this.attempt(s, date, CHAT_RECIPIENT, 'google_chat', result, () => this.senders.chat.send(webhook, reportChat(report, appUrl)));
        }
      }
    }
    this.log.log(`Reports ${date}: ${result.sent} sent, ${result.failed} failed, ${result.skipped} already sent${result.dryRun ? ' (dry run)' : ''}`);
    return result;
  }

  private async deliverEmail(
    s: ReportScheduleRow,
    date: IsoDate,
    email: string,
    result: ReportRunResult,
    build: () => Promise<Awaited<ReturnType<ReportBuilder['build']>>>,
  ): Promise<void> {
    await this.attempt(s, date, email, 'email', result, async () => {
      const report = await build();
      if (!report) throw new Error('No data to report on yet');
      return this.senders.email.send({
        to: [email],
        subject: `${report.title}: ${report.subtitle}`,
        text: reportText(report, this.cfg.APP_BASE_URL),
        html: reportHtml(report, logoUrl(this.cfg.APP_BASE_URL), this.cfg.APP_BASE_URL),
      });
    });
  }

  /** One delivery, recorded once per schedule, day, recipient and channel. A failed one is retried on the next run. */
  private async attempt(
    s: ReportScheduleRow,
    date: IsoDate,
    recipient: string,
    channel: 'email' | 'google_chat',
    result: ReportRunResult,
    send: () => Promise<string>,
  ): Promise<void> {
    const prior = await this.db.query<{ status: string }>(
      'SELECT status FROM report_run WHERE schedule_key = $1 AND period_key = $2 AND recipient = $3 AND channel = $4',
      [s.key, date, recipient, channel],
    );
    if (prior.rows[0]?.status === 'sent') {
      result.skipped += 1;
      return;
    }
    if (this.cfg.ALERTS_DRY_RUN) {
      this.log.log(`[dry run] ${s.key} → ${channel} ${recipient}`);
      return;
    }
    let status: 'sent' | 'failed' = 'sent';
    let error: string | null = null;
    try {
      await send();
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      this.log.warn(`${s.key} → ${channel} ${recipient} failed: ${error}`);
    }
    await this.db.query(
      `INSERT INTO report_run (schedule_key, period_key, recipient, channel, status, error) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (schedule_key, period_key, recipient, channel) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, created_at = now()`,
      [s.key, date, recipient, channel, status, error],
    );
    result[status] += 1;
  }

  private async recipients(audience: Audience): Promise<string[]> {
    const { rows } = await this.db.query<{ email: string }>('SELECT email FROM app_user WHERE active AND role = ANY($1) ORDER BY email', [RECIPIENT_ROLES[audience]]);
    return rows.map((r) => r.email);
  }
}
