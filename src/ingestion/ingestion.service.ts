import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildRollups } from '../audits/hierarchy.js';
import type { IsoDate } from '../common/calendar.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import {
  CONTROL_PANEL_SOURCE,
  HUBSPOT_SOURCE,
  type ControlPanelSource,
  type HubSpotSource,
} from '../sources/source.types.js';
import { SnapshotRepository } from './snapshot.repository.js';

export interface IngestionResult {
  runId: number;
  snapshotDate: IsoDate;
  companies: number;
  accounts: number;
}

/** Pulls HubSpot and Control Panel data and stores it as the snapshot for one date. */
@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(HUBSPOT_SOURCE) private readonly hubspot: HubSpotSource,
    @Inject(CONTROL_PANEL_SOURCE) private readonly controlPanel: ControlPanelSource,
  ) {}

  async run(snapshotDate: IsoDate): Promise<IngestionResult> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO ingestion_run (snapshot_date, source_mode, status) VALUES ($1, $2, 'running') RETURNING id`,
      [snapshotDate, this.cfg.SOURCE_MODE],
    );
    const runId = Number(rows[0]!.id);

    try {
      const [companies, accounts] = await Promise.all([
        this.hubspot.fetchActiveCustomers(),
        this.controlPanel.fetchAccounts(),
      ]);

      const rollups = buildRollups(accounts);
      const metrics = companies.map((c) => ({
        hubspotId: c.hubspotId,
        arrKobo: c.arrKobo,
        rollupSeats: c.controlPanelId ? (rollups.get(c.controlPanelId)?.totalActiveUsers ?? null) : null,
        contractEndDate: c.contractEndDate,
      }));

      await this.db.transaction((client) =>
        this.snapshots.replaceSnapshot(client, snapshotDate, companies, accounts, metrics),
      );

      const counts = { companies: companies.length, accounts: accounts.length };
      await this.db.query(
        `UPDATE ingestion_run SET status = 'succeeded', counts = $2, finished_at = now() WHERE id = $1`,
        [runId, counts],
      );
      this.log.log(`Snapshot ${snapshotDate}: ${counts.companies} HubSpot companies, ${counts.accounts} Control Panel accounts`);
      return { runId, snapshotDate, ...counts };
    } catch (err) {
      await this.db.query(
        `UPDATE ingestion_run SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [runId, String(err instanceof Error ? err.message : err)],
      );
      throw err;
    }
  }
}
