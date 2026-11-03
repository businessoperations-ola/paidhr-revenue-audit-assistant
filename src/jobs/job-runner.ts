import { Inject, Injectable } from '@nestjs/common';
import { AlertDispatcher } from '../alerts/alert-dispatcher.service.js';
import { AuditService } from '../audits/audit.service.js';
import type { IsoDate } from '../common/calendar.js';
import { Database } from '../db/database.js';
import { IngestionService } from '../ingestion/ingestion.service.js';

export const JOB_NAMES = ['ingest', 'audit', 'dispatch', 'daily'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * The scheduled work. `daily` is what the 04:00 WAT job runs: snapshot, audit, then alert.
 * `dispatch` on its own retries failed deliveries.
 */
@Injectable()
export class JobRunner {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(AuditService) private readonly audits: AuditService,
    @Inject(AlertDispatcher) private readonly dispatcher: AlertDispatcher,
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
      case 'daily': {
        const ingest = await this.ingestion.run(date);
        const audit = await this.audits.run(date);
        const dispatch = await this.dispatcher.dispatch();
        return { ingest, audit, dispatch };
      }
    }
  }
}
