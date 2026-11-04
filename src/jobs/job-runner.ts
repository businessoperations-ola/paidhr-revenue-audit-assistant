import { Inject, Injectable } from '@nestjs/common';
import { AlertDispatcher } from '../alerts/alert-dispatcher.service.js';
import { EscalationService } from '../alerts/escalation.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { BroadcastService } from '../broadcasts/broadcast.service.js';
import { CxService } from '../cx/cx.service.js';
import { ReportService } from '../reports/report.service.js';
import { AuditService } from '../audits/audit.service.js';
import type { IsoDate } from '../common/calendar.js';
import { Database } from '../db/database.js';
import { IngestionService } from '../ingestion/ingestion.service.js';

export const JOB_NAMES = ['ingest', 'audit', 'dispatch', 'escalate', 'reports', 'broadcasts', 'baseline', 'cx-weekly', 'daily'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * The scheduled work. `daily` is what the 04:00 WAT job runs: snapshot, audit, then alert.
 * `dispatch` on its own retries failed deliveries. `escalate` runs at 08:00 WAT on weekdays (US-16).
 * `reports` (08:00 WAT) sends the due daily, weekly or monthly reports (US-25). `broadcasts` runs every
 * 15 minutes. `baseline` runs once a year, on 1 January (US-18). `cx-weekly` clusters tickets (US-28).
 */
@Injectable()
export class JobRunner {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(AuditService) private readonly audits: AuditService,
    @Inject(AlertDispatcher) private readonly dispatcher: AlertDispatcher,
    @Inject(EscalationService) private readonly escalation: EscalationService,
    @Inject(ReportService) private readonly reports: ReportService,
    @Inject(BroadcastService) private readonly broadcasts: BroadcastService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(CxService) private readonly cx: CxService,
  ) {}

  async run(name: JobName, date: IsoDate, actor = 'scheduler') {
    await this.db.query(
      `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, 'job.run', 'job', $2, $3)`,
      [actor, name, JSON.stringify({ date })],
    );
    switch (name) {
      case 'ingest':
        return { ingest: await this.ingestion.run(date) };
      case 'audit':
        return { audit: await this.audits.run(date) };
      case 'dispatch':
        return { dispatch: await this.dispatcher.dispatch() };
      case 'escalate':
        return { escalate: await this.escalation.run(date) };
      case 'reports':
        return { reports: await this.reports.run(date) };
      case 'broadcasts':
        return { broadcasts: await this.broadcasts.runDue() };
      case 'baseline': {
        // US-18: lock each CSM's ARR for the year of `date`, from a fresh snapshot of that day.
        const ingest = await this.ingestion.run(date);
        return { ingest, baseline: await this.analytics.captureBaseline(Number(date.slice(0, 4)), date, actor) };
      }
      case 'cx-weekly': {
        // US-28: ticket themes, macros and KB drafts. Skipped quietly while Claude features are off.
        const clusters = this.cx.aiEnabled ? await this.cx.clusterTickets(date, actor) : null;
        return { clusters: clusters ? { themes: clusters.content.themes.length, ticketsAnalysed: clusters.content.ticketsAnalysed } : null };
      }
      case 'daily': {
        const ingest = await this.ingestion.run(date);
        // Tone first, so the support early warning in the audit can use it; playbooks after, once flags exist.
        const sentiment = await this.cx.scoreSentiment();
        const audit = await this.audits.run(date);
        const playbooks = await this.cx.writePlaybooks();
        const dispatch = await this.dispatcher.dispatch();
        return { ingest, sentiment, audit, playbooks, dispatch };
      }
    }
  }
}
