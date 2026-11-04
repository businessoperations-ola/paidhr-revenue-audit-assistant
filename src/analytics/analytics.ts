import { daysBetween, addDays, todayInLagos, type IsoDate } from '../common/calendar.js';
import type { ControlPanelAccount, RevenueCategory, RevenueLine } from '../domain/types.js';
import { rootMembers } from '../audits/hierarchy.js';

/** A customer on one day, as the analytics see it. */
export interface CompanyPoint {
  hubspotId: string;
  name: string;
  csmEmail: string | null;
  csmName: string | null;
  healthStatus: string | null;
  arrKobo: bigint | null;
  contractEndDate: IsoDate | null;
}

// ---------------------------------------------------------------- ARR movement (US-09, US-19)

export interface ChurnedAccount {
  hubspotId: string;
  name: string;
  /** ARR lost, in kobo. */
  lostKobo: bigint;
}

export interface ArrBridge {
  startKobo: bigint;
  newKobo: bigint;
  expansionKobo: bigint;
  partialChurnKobo: bigint;
  fullChurnKobo: bigint;
  endKobo: bigint;
  newCount: number;
  expansionCount: number;
  fullChurn: ChurnedAccount[];
  partialChurn: ChurnedAccount[];
}

const positive = (v: bigint | null): v is bigint => v !== null && v > 0n;

/** `part` as a percentage of `whole`, rounded (not truncated) to `digits` places. Null when `whole` is zero. */
export function pctOf(part: bigint, whole: bigint, digits = 1): number | null {
  if (whole === 0n) return null;
  const f = 10 ** digits;
  return Math.round((Number(part) / Number(whole)) * 100 * f) / f;
}

/**
 * How total ARR moved between two days: start + new + expansion − partial churn − full churn = end.
 * - Full churn: ARR fell to ₦0, or the customer is gone (US-09).
 * - Partial churn: ARR fell but stayed above ₦0 (a contraction).
 */
export function arrBridge(start: CompanyPoint[], end: CompanyPoint[]): ArrBridge {
  const startMap = new Map(start.filter((c) => positive(c.arrKobo)).map((c) => [c.hubspotId, c]));
  const endMap = new Map(end.filter((c) => positive(c.arrKobo)).map((c) => [c.hubspotId, c]));
  const out: ArrBridge = {
    startKobo: 0n, newKobo: 0n, expansionKobo: 0n, partialChurnKobo: 0n, fullChurnKobo: 0n, endKobo: 0n,
    newCount: 0, expansionCount: 0, fullChurn: [], partialChurn: [],
  };
  for (const [id, s] of startMap) {
    const startArr = s.arrKobo!;
    out.startKobo += startArr;
    const e = endMap.get(id);
    if (!e) {
      out.fullChurnKobo += startArr;
      out.fullChurn.push({ hubspotId: id, name: s.name, lostKobo: startArr });
    } else if (e.arrKobo! < startArr) {
      const lost = startArr - e.arrKobo!;
      out.partialChurnKobo += lost;
      out.partialChurn.push({ hubspotId: id, name: s.name, lostKobo: lost });
    } else if (e.arrKobo! > startArr) {
      out.expansionKobo += e.arrKobo! - startArr;
      out.expansionCount += 1;
    }
  }
  for (const [id, e] of endMap) {
    out.endKobo += e.arrKobo!;
    if (!startMap.has(id)) {
      out.newKobo += e.arrKobo!;
      out.newCount += 1;
    }
  }
  const byLost = (a: ChurnedAccount, b: ChurnedAccount) => (a.lostKobo === b.lostKobo ? a.name.localeCompare(b.name) : a.lostKobo > b.lostKobo ? -1 : 1);
  out.fullChurn.sort(byLost);
  out.partialChurn.sort(byLost);
  return out;
}

export function totalArr(companies: CompanyPoint[]): bigint {
  return companies.reduce((sum, c) => sum + (positive(c.arrKobo) ? c.arrKobo : 0n), 0n);
}

// ---------------------------------------------------------------- health (US-10)

export interface HealthRow {
  status: string;
  count: number;
  /** Share of customers, one decimal place. */
  pct: number;
  arrKobo: bigint;
}

const HEALTH_ORDER = ['Healthy', 'Neutral', 'At Risk'];

export function healthDistribution(companies: CompanyPoint[]): HealthRow[] {
  const norm = (h: string | null) => HEALTH_ORDER.find((s) => s.toLowerCase() === h?.trim().toLowerCase()) ?? 'Not set';
  const groups = new Map<string, { count: number; arrKobo: bigint }>();
  for (const s of [...HEALTH_ORDER, 'Not set']) groups.set(s, { count: 0, arrKobo: 0n });
  for (const c of companies) {
    const g = groups.get(norm(c.healthStatus))!;
    g.count += 1;
    g.arrKobo += positive(c.arrKobo) ? c.arrKobo : 0n;
  }
  const total = companies.length;
  return [...groups.entries()]
    .filter(([status, g]) => status !== 'Not set' || g.count > 0)
    .map(([status, g]) => ({ status, count: g.count, pct: total === 0 ? 0 : Math.round((g.count / total) * 1000) / 10, arrKobo: g.arrKobo }));
}

// ---------------------------------------------------------------- renewals (US-11)

export interface ContractPoint {
  date: IsoDate;
  contractEnd: IsoDate | null;
  arrKobo: bigint | null;
}

export interface RenewalDetail {
  hubspotId: string;
  expiry: IsoDate;
  renewed: boolean;
  /** Day the new contract end date was first seen. */
  detectedOn: IsoDate | null;
  /** Days from the old expiry to the day the renewal was seen. Negative means early. */
  turnaroundDays: number | null;
}

export interface RenewalStats {
  eligible: number;
  renewed: number;
  /** Renewed ÷ eligible contracts. */
  renewalRatePct: number | null;
  /** Cohort ARR at the end ÷ cohort ARR at the start (includes expansion, contraction and churn). */
  netRenewalPct: number | null;
  avgTurnaroundDays: number | null;
  details: RenewalDetail[];
}

/**
 * Eligible contracts are those whose end date falls inside the period, as seen on its first day.
 * A contract counts as renewed when its end date later moves forward. The signing date is the
 * first day that move shows in a snapshot, so it can lag the real signature by up to a day.
 *
 * `seriesByCompany` holds each company's daily points from the first to the last snapshot we have.
 * When the data stops before the period ends (`observedTo` < `to`), a contract that expires after
 * the last snapshot and has not renewed yet is left out: its outcome is not known, so counting it
 * as "not renewed" would understate the renewal rate.
 */
export function renewalStats(
  seriesByCompany: Map<string, ContractPoint[]>,
  from: IsoDate,
  to: IsoDate,
  endArrByCompany: Map<string, bigint>,
  observedTo: IsoDate = to,
): RenewalStats {
  const details: RenewalDetail[] = [];
  let startArr = 0n;
  let endArr = 0n;
  for (const [id, points] of seriesByCompany) {
    const first = points[0];
    if (!first || first.date !== from || !first.contractEnd) continue; // new customer or no contract date
    const expiry = first.contractEnd;
    if (expiry < from || expiry > to) continue;
    const moved = points.find((p) => p.date > from && p.contractEnd !== null && p.contractEnd > expiry);
    if (!moved && expiry > observedTo) continue; // not due yet as far as the data goes
    details.push({
      hubspotId: id,
      expiry,
      renewed: Boolean(moved),
      detectedOn: moved?.date ?? null,
      turnaroundDays: moved ? daysBetween(expiry, moved.date) : null,
    });
    startArr += positive(first.arrKobo) ? first.arrKobo : 0n;
    endArr += endArrByCompany.get(id) ?? 0n;
  }
  const renewed = details.filter((d) => d.renewed);
  const turnarounds = renewed.map((d) => d.turnaroundDays!).filter((n) => n !== null);
  return {
    eligible: details.length,
    renewed: renewed.length,
    renewalRatePct: details.length === 0 ? null : Math.round((renewed.length / details.length) * 1000) / 10,
    netRenewalPct: pctOf(endArr, startArr, 2),
    avgTurnaroundDays: turnarounds.length === 0 ? null : Math.round((turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length) * 10) / 10,
    details,
  };
}

// ---------------------------------------------------------------- module adoption (US-08)

export interface AdoptionWindow {
  days: number;
  /** Top-level accounts that used the module within the window. */
  users: number;
  ratePct: number | null;
}

export interface AdoptionStats {
  /** Active top-level client accounts (the denominator). */
  base: number;
  ewa: AdoptionWindow[];
  statutory: AdoptionStats['ewa'];
}

const maxDate = (dates: Array<IsoDate | null>): IsoDate | null =>
  dates.reduce<IsoDate | null>((m, d) => (d && (!m || d > m) ? d : m), null);

/**
 * Adoption rate = accounts that used the module in the window ÷ all active client accounts.
 * A parent counts as using a module when it or any of its sub-accounts did.
 */
export function adoptionStats(accounts: ControlPanelAccount[], asOf: IsoDate, windows: number[] = [30, 90, 365]): AdoptionStats {
  const roots = [...rootMembers(accounts).values()];
  const base = roots.length;
  const rate = (pick: (a: ControlPanelAccount) => IsoDate | null): AdoptionWindow[] =>
    windows.map((days) => {
      const cutoff = addDays(asOf, -days);
      const users = roots.filter((members) => {
        const last = maxDate(members.map(pick));
        return last !== null && last >= cutoff && last <= asOf;
      }).length;
      return { days, users, ratePct: base === 0 ? null : Math.round((users / base) * 1000) / 10 };
    });
  return { base, ewa: rate((a) => a.ewaLastUsedOn), statutory: rate((a) => a.statutoryLastUsedOn) };
}

// ---------------------------------------------------------------- contractor seats (US-06)

export interface ContractorStats {
  total: number;
  byParent: Array<{ parentClientId: string; parentName: string; contractors: number; subAccounts: number }>;
}

export function contractorSeats(accounts: ControlPanelAccount[]): ContractorStats {
  const byParent = [...rootMembers(accounts).entries()]
    .map(([id, members]) => ({
      parentClientId: id,
      parentName: members[0]!.name,
      contractors: members.reduce((n, a) => n + a.contractorUsers, 0),
      subAccounts: members.length - 1,
    }))
    .filter((p) => p.contractors > 0)
    .sort((a, b) => b.contractors - a.contractors || a.parentName.localeCompare(b.parentName));
  return { total: byParent.reduce((n, p) => n + p.contractors, 0), byParent };
}

// ---------------------------------------------------------------- expansion revenue (US-07)

export interface ExpansionStats {
  totalKobo: bigint;
  byCategory: Array<{ category: RevenueCategory; amountKobo: bigint }>;
  /** EWA and statutory remittance revenue. */
  monetizedKobo: bigint;
  /** (EWA + statutory) ÷ total expansion revenue. */
  monetizedPct: number | null;
}

const CATEGORIES: RevenueCategory[] = ['UPSELL', 'CROSS_SELL_EWA', 'CROSS_SELL_STATUTORY', 'CROSS_SELL_OTHER'];

export function expansionRevenue(lines: RevenueLine[], from: IsoDate, to: IsoDate): ExpansionStats {
  const inRange = lines.filter((l) => l.revenueDate >= from && l.revenueDate <= to);
  const byCategory = CATEGORIES.map((category) => ({
    category,
    amountKobo: inRange.filter((l) => l.category === category).reduce((n, l) => n + l.amountKobo, 0n),
  }));
  const totalKobo = byCategory.reduce((n, c) => n + c.amountKobo, 0n);
  const monetizedKobo = byCategory
    .filter((c) => c.category === 'CROSS_SELL_EWA' || c.category === 'CROSS_SELL_STATUTORY')
    .reduce((n, c) => n + c.amountKobo, 0n);
  return {
    totalKobo,
    byCategory,
    monetizedKobo,
    monetizedPct: pctOf(monetizedKobo, totalKobo, 1),
  };
}

// ---------------------------------------------------------------- tickets (US-12)

export interface TicketRow {
  hubspotCompanyId: string | null;
  createdAt: string;
}

/** Clients ranked by tickets created in the period (US-12). Tickets with no company are left out. */
export function topTicketClients(tickets: TicketRow[], from: IsoDate, to: IsoDate, limit = 10): Array<{ hubspotId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tickets) {
    if (!t.hubspotCompanyId) continue;
    const day = todayInLagos(new Date(t.createdAt));
    if (day < from || day > to) continue;
    counts.set(t.hubspotCompanyId, (counts.get(t.hubspotCompanyId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([hubspotId, count]) => ({ hubspotId, count }))
    .sort((a, b) => b.count - a.count || a.hubspotId.localeCompare(b.hubspotId))
    .slice(0, limit);
}

// ---------------------------------------------------------------- CSM ledger (US-18)

export const UNASSIGNED = '(unassigned)';

export interface CsmBaseline {
  csmEmail: string;
  csmName: string | null;
  baselineKobo: bigint;
  accounts: number;
}

export interface CsmLedgerRow {
  csmEmail: string;
  csmName: string | null;
  baselineKobo: bigint;
  currentKobo: bigint;
  deltaKobo: bigint;
  /** Change since the baseline, as a % of the baseline. Null when the baseline was zero. */
  deltaPct: number | null;
  accounts: number;
}

/** ARR owned by each CSM on one day. Customers with no CSM are grouped as "(unassigned)". */
export function arrByCsm(companies: CompanyPoint[]): CsmBaseline[] {
  const map = new Map<string, CsmBaseline>();
  for (const c of companies) {
    if (!positive(c.arrKobo)) continue;
    const key = c.csmEmail ?? UNASSIGNED;
    const row = map.get(key) ?? { csmEmail: key, csmName: c.csmName, baselineKobo: 0n, accounts: 0 };
    row.baselineKobo += c.arrKobo;
    row.accounts += 1;
    row.csmName = row.csmName ?? c.csmName;
    map.set(key, row);
  }
  return [...map.values()];
}

export function csmLedger(baselines: CsmBaseline[], current: CompanyPoint[]): CsmLedgerRow[] {
  const now = new Map(arrByCsm(current).map((r) => [r.csmEmail, r]));
  const base = new Map(baselines.map((b) => [b.csmEmail, b]));
  const keys = new Set([...base.keys(), ...now.keys()]);
  return [...keys]
    .map((key) => {
      const b = base.get(key);
      const n = now.get(key);
      const baselineKobo = b?.baselineKobo ?? 0n;
      const currentKobo = n?.baselineKobo ?? 0n;
      return {
        csmEmail: key,
        csmName: n?.csmName ?? b?.csmName ?? null,
        baselineKobo,
        currentKobo,
        deltaKobo: currentKobo - baselineKobo,
        deltaPct: pctOf(currentKobo - baselineKobo, baselineKobo, 2),
        accounts: n?.accounts ?? 0,
      };
    })
    .sort((a, b) => (a.currentKobo === b.currentKobo ? a.csmEmail.localeCompare(b.csmEmail) : a.currentKobo > b.currentKobo ? -1 : 1));
}
