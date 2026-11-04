import { Inject, Injectable, Logger } from '@nestjs/common';
import { addDays, type IsoDate } from '../common/calendar.js';
import { Database } from '../db/database.js';
import type { HubSpotCompany, RevenueLine } from '../domain/types.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import {
  adoptionStats,
  arrBridge,
  arrByCsm,
  contractorSeats,
  csmLedger,
  expansionRevenue,
  healthDistribution,
  pctOf,
  renewalStats,
  topTicketClients,
  totalArr,
  type AdoptionStats,
  type ArrBridge,
  type CompanyPoint,
  type ContractPoint,
  type ContractorStats,
  type CsmLedgerRow,
  type ExpansionStats,
  type HealthRow,
  type RenewalStats,
} from './analytics.js';

export const toPoint = (c: HubSpotCompany): CompanyPoint => ({
  hubspotId: c.hubspotId,
  name: c.name,
  csmEmail: c.csmEmail,
  csmName: c.csmName,
  healthStatus: c.healthStatus,
  arrKobo: c.arrKobo,
  contractEndDate: c.contractEndDate,
});

export interface Portfolio {
  /** Snapshot date the figures come from. */
  asOf: IsoDate;
  customers: number;
  totalArrKobo: bigint;
  arrAtRiskKobo: bigint;
  arrAtRiskPct: number | null;
  health: HealthRow[];
  contractors: ContractorStats;
  adoption: AdoptionStats;
}

export interface Coverage {
  requestedFrom: IsoDate;
  requestedTo: IsoDate;
  /** Snapshot days actually compared. */
  from: IsoDate;
  to: IsoDate;
  /** True when there is not enough history to cover the whole period. */
  partial: boolean;
}

export interface PeriodAnalytics {
  coverage: Coverage;
  bridge: ArrBridge;
  renewals: RenewalStats & { names: Record<string, string> };
  expansion: ExpansionStats;
  /** Present once expansion revenue has been loaded from the Control Panel. */
  expansionAvailable: boolean;
  topTicketClients: Array<{ hubspotId: string; name: string; count: number }>;
  ticketsCreated: number;
}

export interface Ledger {
  year: number;
  baselineDate: IsoDate;
  asOf: IsoDate;
  rows: CsmLedgerRow[];
  totals: { baselineKobo: bigint; currentKobo: bigint; deltaKobo: bigint; deltaPct: number | null };
}

@Injectable()
export class AnalyticsService {
  private readonly log = new Logger(AnalyticsService.name);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
  ) {}

  /** US-10, 19, 06, 08 and the ARR-at-risk headline, from the latest snapshot on or before `date`. */
  async portfolio(date: IsoDate): Promise<Portfolio | null> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const [companies, accounts] = await Promise.all([this.snapshots.loadCompanies(asOf), this.snapshots.loadAccounts(asOf)]);
    const points = companies.map(toPoint);
    const total = totalArr(points);
    const health = healthDistribution(points);
    const atRisk = health.find((h) => h.status === 'At Risk')?.arrKobo ?? 0n;
    return {
      asOf,
      customers: points.filter((p) => p.arrKobo !== null && p.arrKobo > 0n).length,
      totalArrKobo: total,
      arrAtRiskKobo: atRisk,
      arrAtRiskPct: pctOf(atRisk, total, 1),
      health,
      contractors: contractorSeats(accounts),
      adoption: adoptionStats(accounts, asOf),
    };
  }

  /** US-09, 11, 07, 12 for a period. Uses the snapshots nearest each end, and says if history is short. */
  async period(from: IsoDate, to: IsoDate): Promise<PeriodAnalytics | null> {
    const toUsed = await this.snapshots.latestSnapshotDate(to);
    if (!toUsed) return null;
    let fromUsed = await this.snapshots.latestSnapshotDate(from);
    let partial = false;
    if (!fromUsed) {
      fromUsed = await this.earliestSnapshotOnOrAfter(from);
      partial = true;
    }
    if (!fromUsed || fromUsed > toUsed) return null;
    // A period starting more than a few days before the first snapshot we could use is only partly covered.
    if (fromUsed > addDays(from, 3) || toUsed < addDays(to, -3)) partial = true;

    const [startCompanies, endCompanies, series, revenue, tickets] = await Promise.all([
      this.snapshots.loadCompanies(fromUsed),
      this.snapshots.loadCompanies(toUsed),
      this.loadContractSeries(fromUsed, toUsed),
      this.loadRevenue(),
      this.loadTickets(from, to),
    ]);
    const endPoints = endCompanies.map(toPoint);
    const names = new Map([...startCompanies, ...endCompanies].map((c) => [c.hubspotId, c.name]));
    const endArr = new Map(endPoints.filter((p) => p.arrKobo && p.arrKobo > 0n).map((p) => [p.hubspotId, p.arrKobo!]));
    const renewals = renewalStats(series, fromUsed, to, endArr, toUsed);
    const ranked = topTicketClients(tickets, from, to, 10);
    return {
      coverage: { requestedFrom: from, requestedTo: to, from: fromUsed, to: toUsed, partial },
      bridge: arrBridge(startCompanies.map(toPoint), endPoints),
      renewals: { ...renewals, names: Object.fromEntries(renewals.details.map((d) => [d.hubspotId, names.get(d.hubspotId) ?? d.hubspotId])) },
      expansion: expansionRevenue(revenue.lines, from, to),
      expansionAvailable: revenue.lines.length > 0,
      topTicketClients: ranked.map((r) => ({ ...r, name: names.get(r.hubspotId) ?? `Company ${r.hubspotId}` })),
      ticketsCreated: tickets.filter((t) => t.hubspotCompanyId).length,
    };
  }

  /** US-18: baseline vs current ARR per CSM. Null until the year's baseline has been captured. */
  async ledger(year: number, date: IsoDate): Promise<Ledger | null> {
    const { rows } = await this.db.query<{ csm_email: string; csm_name: string | null; baseline_arr_kobo: string; accounts: number; snapshot_date: string }>(
      'SELECT csm_email, csm_name, baseline_arr_kobo, accounts, snapshot_date FROM csm_arr_baseline WHERE year = $1',
      [year],
    );
    if (rows.length === 0) return null;
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const current = (await this.snapshots.loadCompanies(asOf)).map(toPoint);
    const ledger = csmLedger(
      rows.map((r) => ({ csmEmail: r.csm_email, csmName: r.csm_name, baselineKobo: BigInt(r.baseline_arr_kobo), accounts: r.accounts })),
      current,
    );
    const baselineKobo = ledger.reduce((n, r) => n + r.baselineKobo, 0n);
    const currentKobo = ledger.reduce((n, r) => n + r.currentKobo, 0n);
    return {
      year,
      baselineDate: rows[0]!.snapshot_date,
      asOf,
      rows: ledger,
      totals: {
        baselineKobo,
        currentKobo,
        deltaKobo: currentKobo - baselineKobo,
        deltaPct: pctOf(currentKobo - baselineKobo, baselineKobo, 2),
      },
    };
  }

  /**
   * US-18: lock each CSM's ARR at the start of the year. Rows already written are never changed,
   * so re-running the job (or running it late) cannot move a baseline.
   */
  async captureBaseline(year: number, snapshotDate: IsoDate, actor = 'scheduler'): Promise<{ created: number; existing: number }> {
    const companies = (await this.snapshots.loadCompanies(snapshotDate)).map(toPoint);
    if (companies.length === 0) throw new Error(`Snapshot ${snapshotDate} has no HubSpot companies; refusing to write baselines`);
    const rows = arrByCsm(companies);
    let created = 0;
    for (const r of rows) {
      const res = await this.db.query(
        `INSERT INTO csm_arr_baseline (year, csm_email, csm_name, baseline_arr_kobo, accounts, snapshot_date)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (year, csm_email) DO NOTHING`,
        [year, r.csmEmail, r.csmName, r.baselineKobo.toString(), r.accounts, snapshotDate],
      );
      created += res.rowCount ?? 0;
    }
    await this.db.query(
      `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, 'baseline.capture', 'csm_arr_baseline', $2, $3)`,
      [actor, String(year), JSON.stringify({ snapshotDate, created, existing: rows.length - created })],
    );
    this.log.log(`CSM baselines for ${year}: ${created} written, ${rows.length - created} already existed`);
    return { created, existing: rows.length - created };
  }

  async currentArrByCsm(date: IsoDate): Promise<CompanyPoint[]> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    return asOf ? (await this.snapshots.loadCompanies(asOf)).map(toPoint) : [];
  }

  // ---- data loading

  private async earliestSnapshotOnOrAfter(date: IsoDate): Promise<IsoDate | null> {
    const { rows } = await this.db.query<{ d: string | null }>(
      `SELECT min(snapshot_date) AS d FROM ingestion_run WHERE status = 'succeeded' AND snapshot_date >= $1`,
      [date],
    );
    return rows[0]?.d ?? null;
  }

  private async loadContractSeries(from: IsoDate, to: IsoDate): Promise<Map<string, ContractPoint[]>> {
    const { rows } = await this.db.query<{ hubspot_id: string; snapshot_date: string; contract_end_date: string | null; arr_kobo: string | null }>(
      `SELECT hubspot_id, snapshot_date, contract_end_date, arr_kobo FROM hs_company_snapshot
        WHERE snapshot_date BETWEEN $1 AND $2 ORDER BY hubspot_id, snapshot_date`,
      [from, to],
    );
    const series = new Map<string, ContractPoint[]>();
    for (const r of rows) {
      const list = series.get(r.hubspot_id) ?? [];
      list.push({ date: r.snapshot_date, contractEnd: r.contract_end_date, arrKobo: r.arr_kobo === null ? null : BigInt(r.arr_kobo) });
      series.set(r.hubspot_id, list);
    }
    return series;
  }

  private async loadRevenue(): Promise<{ lines: RevenueLine[] }> {
    const { rows } = await this.db.query<{ client_id: string; revenue_date: string; category: RevenueLine['category']; amount_kobo: string }>(
      'SELECT client_id, revenue_date, category, amount_kobo FROM cp_revenue_line',
    );
    return { lines: rows.map((r) => ({ clientId: r.client_id, revenueDate: r.revenue_date, category: r.category, amountKobo: BigInt(r.amount_kobo) })) };
  }

  private async loadTickets(from: IsoDate, to: IsoDate) {
    const { rows } = await this.db.query<{ hubspot_company_id: string | null; created_at: Date }>(
      // A day of slack either side: WAT dates are computed in code from the timestamp.
      `SELECT hubspot_company_id, created_at FROM ticket WHERE created_at >= $1::date - 1 AND created_at < $2::date + 2`,
      [from, to],
    );
    return rows.map((r) => ({ hubspotCompanyId: r.hubspot_company_id, createdAt: r.created_at.toISOString() }));
  }
}
