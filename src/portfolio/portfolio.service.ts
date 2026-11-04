import { Inject, Injectable } from '@nestjs/common';
import { FLAG_TITLES } from '../alerts/message-format.js';
import { FlagRepository, type StoredFlag } from '../audits/flag.repository.js';
import { rootMembers } from '../audits/hierarchy.js';
import { addDays, daysBetween, type IsoDate } from '../common/calendar.js';
import type { Kobo } from '../common/money.js';
import { CxService } from '../cx/cx.service.js';
import { Database } from '../db/database.js';
import type { ControlPanelAccount, HubSpotCompany } from '../domain/types.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { OrgService, type Scope } from '../org/org.service.js';

export type PayrollStatus = 'ok' | 'late' | 'not_set_up' | 'unknown';
export type OnboardingStatus = 'live' | 'in_progress' | 'stalled' | null;

export interface ClientRow {
  hubspotId: string;
  name: string;
  industry: string | null;
  csmEmail: string | null;
  csmName: string | null;
  health: string | null;
  arrKobo: Kobo | null;
  contractEnd: IsoDate | null;
  daysToRenewal: number | null;
  paidSeats: number | null;
  activeSeats: number | null;
  /** Active users as a share of paid seats, rounded. Over 100 means unbilled seats. */
  utilisationPct: number | null;
  contractorSeats: number | null;
  /** Active users now minus 90 days ago, when both are known. */
  seatChange90d: number | null;
  lastContact: IsoDate | null;
  daysSinceContact: number | null;
  openAlerts: number;
  topSeverity: string | null;
  openTickets: number;
  payroll: { status: PayrollStatus; frequency: string | null; lastPayDate: IsoDate | null };
  ewa: { lastUsed: IsoDate | null; volume30dKobo: Kobo | null };
  statutoryLastUsed: IsoDate | null;
  onboarding: OnboardingStatus;
  signals: string[];
}

export interface PortfolioSummary {
  clients: number;
  arrKobo: Kobo;
  atRisk: { count: number; arrKobo: Kobo };
  renewals90: { count: number; arrKobo: Kobo };
  openAlerts: number;
  urgentAlerts: number;
  noContact30: number;
  avgUtilisationPct: number | null;
  openTickets: number;
}

export interface CsmRow {
  csmEmail: string | null;
  csmName: string | null;
  clients: number;
  arrKobo: Kobo;
  atRisk: number;
  renewals90: number;
  openAlerts: number;
}

const SEV = ['urgent', 'high', 'medium', 'low'];
const flagState = (f: StoredFlag) => (f.escalationLevel === 2 ? 'With directors' : f.escalationLevel === 1 ? 'With team lead' : f.acknowledgedAt ? 'Acknowledged' : f.notifiedAt ? 'Awaiting CSM' : 'Not sent yet');
const maxDate = (xs: Array<IsoDate | null>): IsoDate | null => xs.reduce<IsoDate | null>((m, x) => (x && (!m || x > m) ? x : m), null);

/** The CSM dashboard: every client in a person's scope with the numbers that matter. */
@Injectable()
export class PortfolioService {
  constructor(
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(CxService) private readonly cx: CxService,
    @Inject(OrgService) private readonly org: OrgService,
    @Inject(Database) private readonly db: Database,
  ) {}

  /**
   * `csm` narrows to one person (who must be inside `scope`). Directors and viewers see unassigned
   * accounts too; everyone else sees only accounts whose CSM is inside their scope.
   */
  async dashboard(scope: Scope, date: IsoDate, csm?: string): Promise<{ asOf: IsoDate; summary: PortfolioSummary; team: CsmRow[]; clients: ClientRow[] } | null> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const rows = await this.rows(asOf);
    const want = csm?.toLowerCase();
    const mine = rows.filter((r) => (want ? r.csmEmail?.toLowerCase() === want : scope.all || OrgService.includes(scope, r.csmEmail)));
    return { asOf, summary: summarise(mine), team: byCsm(mine), clients: mine };
  }

  /** One client, in full. Null when it does not exist or is outside the scope. */
  async client(scope: Scope, date: IsoDate, hubspotId: string) {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const row = (await this.rows(asOf)).find((r) => r.hubspotId === hubspotId);
    if (!row || !(scope.all || OrgService.includes(scope, row.csmEmail))) return null;
    const companies = await this.snapshots.loadCompanies(asOf);
    const controlPanelId = companies.find((c) => c.hubspotId === hubspotId)?.controlPanelId ?? null;
    const [flags, history, tickets, revenue] = await Promise.all([
      this.flags.list({ status: 'open', limit: 2000 }),
      this.snapshots.loadHistory(addDays(asOf, -90), asOf),
      this.db.query(
        `SELECT ticket_id, subject, created_at, closed_at, is_closed, reopen_count, sentiment FROM ticket
          WHERE hubspot_company_id = $1 AND (NOT is_closed OR closed_at > now() - interval '60 days') ORDER BY is_closed, created_at DESC LIMIT 20`,
        [hubspotId],
      ),
      controlPanelId
        ? this.db.query(
            `SELECT category, sum(amount_kobo)::bigint AS total FROM cp_revenue_line WHERE client_id = $1 AND revenue_date > $2 GROUP BY category ORDER BY category`,
            [controlPanelId, addDays(asOf, -365)],
          )
        : Promise.resolve({ rows: [] as Array<{ category: string; total: string }> }),
    ]);
    const age = (iso: Date | string) => daysBetween((iso instanceof Date ? iso.toISOString() : String(iso)).slice(0, 10), asOf);
    return {
      asOf,
      client: row,
      alerts: flags.filter((f) => f.hubspotCompanyId === hubspotId).sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity)).map((f) => ({ id: f.id, title: FLAG_TITLES[f.type] ?? f.type, severity: f.severity, summary: f.summary, state: flagState(f), firstSeen: f.firstSeenAt })),
      tickets: tickets.rows.map((t) => ({ id: t.ticket_id, subject: t.subject, open: !t.is_closed, ageDays: age(t.created_at), reopenCount: t.reopen_count, sentiment: t.sentiment })),
      seatHistory: (history.get(hubspotId) ?? []).map((p) => ({ date: p.date, seats: p.seats, arrKobo: p.arrKobo })),
      expansionRevenue12m: revenue.rows.map((r) => ({ category: r.category, amountKobo: BigInt(r.total) })),
    };
  }

  // ------------------------------------------------------------------ building the rows

  private async rows(asOf: IsoDate): Promise<ClientRow[]> {
    const [companies, accounts, flags, tickets, history, radar] = await Promise.all([
      this.snapshots.loadCompanies(asOf),
      this.snapshots.loadAccounts(asOf),
      this.flags.list({ status: 'open', limit: 2000 }),
      this.snapshots.loadOpenTickets(),
      this.snapshots.loadHistory(addDays(asOf, -90), asOf),
      this.cx.radar(asOf),
    ]);
    const members = new Map<string, ControlPanelAccount[]>();
    for (const [root, list] of rootMembers(accounts)) members.set(root, list);
    const flagsBy = group(flags, (f) => f.hubspotCompanyId);
    const ticketsBy = group(tickets, (t) => t.hubspotCompanyId);
    const signals = new Map((radar?.entries ?? []).map((e) => [e.hubspotId, e.signals.map((s) => s.text)]));
    return companies.map((c) => this.row(c, asOf, members.get(c.controlPanelId ?? ''), flagsBy.get(c.hubspotId) ?? [], (ticketsBy.get(c.hubspotId) ?? []).length, history.get(c.hubspotId) ?? [], signals.get(c.hubspotId) ?? []));
  }

  private row(c: HubSpotCompany, asOf: IsoDate, cp: ControlPanelAccount[] | undefined, flags: StoredFlag[], openTickets: number, hist: Array<{ date: IsoDate; seats: number | null }>, signals: string[]): ClientRow {
    const root = cp?.[0];
    const activeSeats = cp ? cp.reduce((n, a) => n + a.activeUsers, 0) : null;
    const earlier = hist.length > 1 ? hist[0]!.seats : null;
    const lateFlag = flags.some((f) => f.type === 'LATE_PAYROLL');
    const volume = cp ? cp.reduce<bigint | null>((n, a) => (a.ewaVolume30dKobo === null ? n : (n ?? 0n) + a.ewaVolume30dKobo), null) : null;
    const created = root?.createdOn ?? null;
    const recent = created !== null && daysBetween(created, asOf) <= 90;
    const onboarding: OnboardingStatus = !root || !recent ? null : root.firstPayrollRunOn ? 'live' : flags.some((f) => f.type === 'ONBOARDING_STAGNATION') ? 'stalled' : 'in_progress';
    const top = flags.map((f) => f.severity).sort((a, b) => SEV.indexOf(a) - SEV.indexOf(b))[0] ?? null;
    return {
      hubspotId: c.hubspotId,
      name: c.name,
      industry: c.industry,
      csmEmail: c.csmEmail,
      csmName: c.csmName,
      health: c.healthStatus,
      arrKobo: c.arrKobo,
      contractEnd: c.contractEndDate,
      daysToRenewal: c.contractEndDate ? daysBetween(asOf, c.contractEndDate) : null,
      paidSeats: c.paidSeats,
      activeSeats,
      utilisationPct: activeSeats !== null && c.paidSeats ? Math.round((activeSeats * 100) / c.paidSeats) : null,
      contractorSeats: cp ? cp.reduce((n, a) => n + a.contractorUsers, 0) : null,
      seatChange90d: activeSeats !== null && earlier !== null ? activeSeats - earlier : null,
      lastContact: c.lastActivityDate,
      daysSinceContact: c.lastActivityDate ? daysBetween(c.lastActivityDate, asOf) : null,
      openAlerts: flags.length,
      topSeverity: top,
      openTickets,
      payroll: {
        status: !root ? 'unknown' : lateFlag ? 'late' : root.payFrequency === null ? 'not_set_up' : 'ok',
        frequency: root?.payFrequency ?? null,
        lastPayDate: maxDate((cp ?? []).map((a) => a.lastPayrollPayDate)),
      },
      ewa: { lastUsed: maxDate((cp ?? []).map((a) => a.ewaLastUsedOn)), volume30dKobo: volume },
      statutoryLastUsed: maxDate((cp ?? []).map((a) => a.statutoryLastUsedOn)),
      onboarding,
      signals,
    };
  }
}

function group<T>(items: T[], key: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    if (k !== null) out.set(k, [...(out.get(k) ?? []), i]);
  }
  return out;
}

export function summarise(rows: ClientRow[]): PortfolioSummary {
  const sum = (xs: ClientRow[]) => xs.reduce((n, r) => n + (r.arrKobo ?? 0n), 0n);
  const risk = rows.filter((r) => r.health?.toLowerCase() === 'at risk');
  const ren = rows.filter((r) => r.daysToRenewal !== null && r.daysToRenewal >= 0 && r.daysToRenewal <= 90);
  const util = rows.filter((r) => r.utilisationPct !== null);
  return {
    clients: rows.length,
    arrKobo: sum(rows),
    atRisk: { count: risk.length, arrKobo: sum(risk) },
    renewals90: { count: ren.length, arrKobo: sum(ren) },
    openAlerts: rows.reduce((n, r) => n + r.openAlerts, 0),
    urgentAlerts: rows.filter((r) => r.topSeverity === 'urgent' || r.topSeverity === 'high').length,
    noContact30: rows.filter((r) => r.daysSinceContact === null || r.daysSinceContact > 30).length,
    avgUtilisationPct: util.length ? Math.round(util.reduce((n, r) => n + r.utilisationPct!, 0) / util.length) : null,
    openTickets: rows.reduce((n, r) => n + r.openTickets, 0),
  };
}

export function byCsm(rows: ClientRow[]): CsmRow[] {
  const out = new Map<string, ClientRow[]>();
  for (const r of rows) out.set(r.csmEmail ?? '', [...(out.get(r.csmEmail ?? '') ?? []), r]);
  return [...out.entries()]
    .map(([email, list]) => {
      const s = summarise(list);
      return { csmEmail: email || null, csmName: list[0]!.csmName, clients: s.clients, arrKobo: s.arrKobo, atRisk: s.atRisk.count, renewals90: s.renewals90.count, openAlerts: s.openAlerts };
    })
    .sort((a, b) => Number(b.arrKobo - a.arrKobo));
}
