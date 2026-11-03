import { Inject, Injectable, Logger } from '@nestjs/common';
import { addDays, type IsoDate } from '../common/calendar.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import type { ControlPanelAccount, FlagType, Finding, HubSpotCompany } from '../domain/types.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { auditArrMath } from './arr-math.audit.js';
import { FlagRepository } from './flag.repository.js';
import { buildRollups, type AccountRollup } from './hierarchy.js';
import { auditHygiene } from './hygiene.audit.js';
import { auditLatePayroll } from './late-payroll.audit.js';
import { reconcileEntities, type ReconciliationSummary } from './reconciliation.audit.js';
import { RulesRepository } from './rules.repository.js';
import { auditSeatChanges } from './seat-change.audit.js';
import { auditSeatOverage } from './seat-overage.audit.js';

/** Every flag type phase 1 produces; open flags of these types are resolved when no longer found. */
export const PHASE1_FLAG_TYPES: FlagType[] = [
  'ARR_MISMATCH',
  'SEAT_INCREASE_NO_ARR_CHANGE',
  'RENEWAL_NO_ARR_CHANGE',
  'UNLINKED_HUBSPOT_COMPANY',
  'UNLINKED_CONTROL_PANEL_ACCOUNT',
  'BROKEN_LINK',
  'SEAT_OVERAGE',
  'MISSING_FIELDS',
  'LATE_PAYROLL',
];

export interface AuditRunResult {
  runId: number;
  runDate: IsoDate;
  findings: number;
  newFlagIds: number[];
  resolved: number;
  byType: Partial<Record<FlagType, number>>;
  reconciliation: ReconciliationSummary;
  hierarchy: Array<Pick<AccountRollup, 'parentClientId' | 'parentName' | 'subAccountCount' | 'totalActiveUsers'>>;
}

/** Map every Control Panel account (including sub-accounts) to the HubSpot company of its top-level parent. */
export function companyLookup(companies: HubSpotCompany[], accounts: ControlPanelAccount[]) {
  const byCpId = new Map(companies.filter((c) => c.controlPanelId).map((c) => [c.controlPanelId!, c]));
  const parentOf = new Map(accounts.map((a) => [a.clientId, a.parentClientId]));
  return (clientId: string): HubSpotCompany | undefined => {
    const seen = new Set<string>();
    let current: string | null | undefined = clientId;
    while (current && !seen.has(current)) {
      const direct = byCpId.get(current);
      if (direct) return direct;
      seen.add(current);
      current = parentOf.get(current);
    }
    return undefined;
  };
}

/** Runs all phase-1 audits against one day's snapshot and stores the results. */
export function runAllAudits(input: {
  companies: HubSpotCompany[];
  accounts: ControlPanelAccount[];
  history: Map<string, import('../domain/types.js').CompanyDayPoint[]>;
  today: IsoDate;
  rules: import('./rules.repository.js').AuditRules;
  calendar: import('../common/calendar.js').BusinessCalendar;
  seatSource: AppConfig['ARR_SEAT_SOURCE'];
}) {
  const { companies, accounts, rules } = input;
  const rollups = buildRollups(accounts);
  const findings: Finding[] = [];

  findings.push(
    ...auditArrMath(companies, {
      toleranceKobo: BigInt(rules.arr_tolerance_kobo),
      seatSourceLabel: input.seatSource,
      seatsFor: (c) =>
        input.seatSource === 'hubspot_paid_seats'
          ? c.paidSeats
          : c.controlPanelId
            ? (rollups.get(c.controlPanelId)?.totalActiveUsers ?? null)
            : null,
    }),
  );
  for (const c of companies) findings.push(...auditSeatChanges(c, input.history.get(c.hubspotId) ?? []));

  const reconciliation = reconcileEntities(companies, accounts);
  findings.push(...reconciliation.findings);
  findings.push(...auditSeatOverage(companies, rollups));
  findings.push(...auditHygiene(companies, rules.mandatory_fields));
  findings.push(
    ...auditLatePayroll(accounts, {
      today: input.today,
      calendar: input.calendar,
      graceBusinessDays: rules.payroll_grace_business_days,
      companyFor: companyLookup(companies, accounts),
    }),
  );

  return { findings, reconciliation: reconciliation.summary, rollups };
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(RulesRepository) private readonly rulesRepo: RulesRepository,
  ) {}

  async run(runDate: IsoDate): Promise<AuditRunResult> {
    const latest = await this.snapshots.latestSnapshotDate(runDate);
    if (latest !== runDate) {
      // Auditing stale data would raise false late-payroll alerts, so stop instead.
      throw new Error(`No snapshot for ${runDate} (latest is ${latest ?? 'none'}). Run ingestion first.`);
    }

    const [companies, accounts, rules, calendar] = await Promise.all([
      this.snapshots.loadCompanies(runDate),
      this.snapshots.loadAccounts(runDate),
      this.rulesRepo.load(),
      this.rulesRepo.calendar(),
    ]);
    if (companies.length === 0) {
      // An empty pull is almost always an outage; resolving every open flag would be wrong.
      throw new Error(`Snapshot ${runDate} has no HubSpot companies; refusing to audit`);
    }
    const history = await this.snapshots.loadHistory(addDays(runDate, -rules.seat_history_days), runDate);

    const { findings, reconciliation, rollups } = runAllAudits({
      companies,
      accounts,
      history,
      today: runDate,
      rules,
      calendar,
      seatSource: this.cfg.ARR_SEAT_SOURCE,
    });

    const byType: Partial<Record<FlagType, number>> = {};
    for (const f of findings) byType[f.type] = (byType[f.type] ?? 0) + 1;
    const hierarchy = [...rollups.values()]
      .filter((r) => r.subAccountCount > 0)
      .map(({ parentClientId, parentName, subAccountCount, totalActiveUsers }) => ({
        parentClientId,
        parentName,
        subAccountCount,
        totalActiveUsers,
      }));

    const result = await this.db.transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO audit_run (run_date, audits, status) VALUES ($1, $2, 'running') RETURNING id`,
        [runDate, PHASE1_FLAG_TYPES],
      );
      const runId = Number(rows[0]!.id);
      const newFlagIds = await this.flags.upsertFindings(client, runId, findings);
      const resolved = await this.flags.resolveMissing(client, runId, PHASE1_FLAG_TYPES);
      const summary = { findings: findings.length, newFlags: newFlagIds.length, resolved, byType, reconciliation, hierarchy };
      await client.query(
        `UPDATE audit_run SET status = 'succeeded', summary = $2, finished_at = now() WHERE id = $1`,
        [runId, JSON.stringify(summary)],
      );
      return { runId, newFlagIds, resolved };
    });

    this.log.log(
      `Audit ${runDate}: ${findings.length} findings, ${result.newFlagIds.length} new, ${result.resolved} resolved`,
    );
    return { ...result, runDate, findings: findings.length, byType, reconciliation, hierarchy };
  }

  async latestRunSummary(): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query(
      `SELECT id, run_date, summary, finished_at FROM audit_run WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }
}
