import { daysBetween, todayInLagos, type IsoDate } from '../common/calendar.js';
import { formatNgn } from '../common/money.js';
import { rootMembers } from '../audits/hierarchy.js';
import type { ControlPanelAccount, Finding, HubSpotCompany } from '../domain/types.js';

// ====================================================================== onboarding (US-26)

const configuredOn = (a: ControlPanelAccount): IsoDate | null => a.payrollConfiguredOn ?? a.firstPayrollRunOn;

/**
 * US-26: flag active accounts that have been onboarding longer than the SLA with no payroll
 * configured. Only top-level accounts are checked; a new sub-account of a live customer is not onboarding.
 */
export function auditOnboarding(
  accounts: ControlPanelAccount[],
  companies: HubSpotCompany[],
  today: IsoDate,
  slaDays: number,
): Finding[] {
  const byCp = new Map(companies.filter((c) => c.controlPanelId).map((c) => [c.controlPanelId!, c]));
  const findings: Finding[] = [];
  for (const members of rootMembers(accounts).values()) {
    const a = members[0]!;
    if (!a.createdOn || configuredOn(a)) continue;
    const days = daysBetween(a.createdOn, today);
    if (days <= slaDays) continue;
    const c = byCp.get(a.clientId);
    findings.push({
      type: 'ONBOARDING_STAGNATION',
      severity: days > slaDays * 2 ? 'high' : 'medium',
      entityKey: c ? `hs:${c.hubspotId}` : `cp:${a.clientId}`,
      hubspotCompanyId: c?.hubspotId ?? null,
      controlPanelId: a.clientId,
      companyName: c?.name ?? a.name,
      csmEmail: c?.csmEmail ?? null,
      summary: `${days} days since sign-up (SLA ${slaDays}) and payroll is still not set up. ${a.activeUsers} ${a.activeUsers === 1 ? 'user has' : 'users have'} been added.`,
      details: { createdOn: a.createdOn, daysInOnboarding: days, slaDays, activeUsers: a.activeUsers, contractorUsers: a.contractorUsers },
    });
  }
  return findings;
}

export type OnboardingStatus = 'live' | 'configured' | 'in_progress' | 'stuck';

export interface ScorecardRow {
  clientId: string;
  name: string;
  createdOn: IsoDate;
  daysSinceSignup: number;
  configuredOn: IsoDate | null;
  firstPayrollRunOn: IsoDate | null;
  /** Days from sign-up to the first completed payroll run (time to first value). */
  ttfvDays: number | null;
  status: OnboardingStatus;
}

export interface Scorecard {
  windowDays: number;
  slaDays: number;
  cohort: number;
  avgTtfvDays: number | null;
  medianTtfvDays: number | null;
  /** Of accounts at least `slaDays` old, the share that have completed a first payroll. */
  firstPayrollRatePct: number | null;
  /** Of all accounts in the window, the share that have payroll configured. */
  configuredRatePct: number | null;
  rows: ScorecardRow[];
}

/** US-26: first-90-day success scorecard for accounts created in the last `windowDays`. */
export function onboardingScorecard(accounts: ControlPanelAccount[], today: IsoDate, slaDays: number, windowDays = 90): Scorecard {
  const rows: ScorecardRow[] = [];
  for (const members of rootMembers(accounts).values()) {
    const a = members[0]!;
    if (!a.createdOn) continue;
    const age = daysBetween(a.createdOn, today);
    if (age < 0 || age > windowDays) continue;
    const configured = configuredOn(a);
    rows.push({
      clientId: a.clientId,
      name: a.name,
      createdOn: a.createdOn,
      daysSinceSignup: age,
      configuredOn: configured,
      firstPayrollRunOn: a.firstPayrollRunOn,
      ttfvDays: a.firstPayrollRunOn ? daysBetween(a.createdOn, a.firstPayrollRunOn) : null,
      status: a.firstPayrollRunOn ? 'live' : configured ? 'configured' : age > slaDays ? 'stuck' : 'in_progress',
    });
  }
  rows.sort((a, b) => a.createdOn.localeCompare(b.createdOn) || a.name.localeCompare(b.name));
  const ttfv = rows.map((r) => r.ttfvDays).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const mature = rows.filter((r) => r.daysSinceSignup >= slaDays);
  const mid = Math.floor(ttfv.length / 2);
  return {
    windowDays,
    slaDays,
    cohort: rows.length,
    avgTtfvDays: ttfv.length === 0 ? null : Math.round((ttfv.reduce((a, b) => a + b, 0) / ttfv.length) * 10) / 10,
    medianTtfvDays: ttfv.length === 0 ? null : ttfv.length % 2 ? ttfv[mid]! : (ttfv[mid - 1]! + ttfv[mid]!) / 2,
    firstPayrollRatePct: mature.length === 0 ? null : Math.round((mature.filter((r) => r.firstPayrollRunOn).length / mature.length) * 1000) / 10,
    configuredRatePct: rows.length === 0 ? null : Math.round((rows.filter((r) => r.configuredOn).length / rows.length) * 1000) / 10,
    rows,
  };
}

// ====================================================================== expansion radar (US-27)

export type RadarSignalKind = 'SEAT_GROWTH' | 'HIGH_EWA' | 'CONTRACTORS';

export interface RadarSignal {
  kind: RadarSignalKind;
  /** What was seen. */
  text: string;
  /** The conversation it suggests. */
  play: string;
}

export interface RadarEntry {
  hubspotId: string;
  name: string;
  csmEmail: string | null;
  arrKobo: bigint | null;
  score: number;
  signals: RadarSignal[];
}

export interface RadarRules {
  growthPct: number;
  growthDays: number;
  ewaVolumeKobo: bigint;
  contractorMin: number;
}

/** Control Panel user counts for a customer now, and `growthDays` ago (null when there is no history that old). */
export interface SeatTrend {
  seatsNow: number | null;
  seatsThen: number | null;
}

/**
 * US-27: accounts showing rapid seat growth, high EWA volume or heavy contractor use are the
 * best places to start an upsell or cross-sell conversation. Score = number of signals.
 */
export function expansionRadar(
  companies: HubSpotCompany[],
  accounts: ControlPanelAccount[],
  seatTrends: Map<string, SeatTrend>,
  rules: RadarRules,
): RadarEntry[] {
  const members = rootMembers(accounts);
  const entries: RadarEntry[] = [];
  for (const c of companies) {
    const group = c.controlPanelId ? members.get(c.controlPanelId) : undefined;
    if (!group) continue;
    const signals: RadarSignal[] = [];

    const trend = seatTrends.get(c.hubspotId);
    if (trend?.seatsNow != null && trend.seatsThen != null && trend.seatsThen > 0 && trend.seatsNow > trend.seatsThen) {
      const pct = ((trend.seatsNow - trend.seatsThen) / trend.seatsThen) * 100;
      if (pct >= rules.growthPct) {
        signals.push({
          kind: 'SEAT_GROWTH',
          text: `Users grew ${Math.round(pct)}% in ${rules.growthDays} days (${trend.seatsThen} to ${trend.seatsNow})`,
          play: 'Review their seat tier and contract: they are growing faster than planned.',
        });
      }
    }
    const ewa = group.reduce((n, a) => n + (a.ewaVolume30dKobo ?? 0n), 0n);
    if (ewa > 0n && ewa >= rules.ewaVolumeKobo) {
      signals.push({
        kind: 'HIGH_EWA',
        text: `${formatNgn(ewa)} of Earned Wage Access in the last 30 days`,
        play: 'Staff clearly value early pay: discuss statutory remittance and other add-ons.',
      });
    }
    const contractors = group.reduce((n, a) => n + a.contractorUsers, 0);
    if (contractors >= rules.contractorMin) {
      signals.push({
        kind: 'CONTRACTORS',
        text: `${contractors} contractor users`,
        play: 'Position cross-border and contractor payments for this team.',
      });
    }
    if (signals.length > 0) {
      entries.push({ hubspotId: c.hubspotId, name: c.name, csmEmail: c.csmEmail, arrKobo: c.arrKobo, score: signals.length, signals });
    }
  }
  return entries.sort((a, b) => b.score - a.score || Number((b.arrKobo ?? 0n) - (a.arrKobo ?? 0n)) || a.name.localeCompare(b.name));
}

// ====================================================================== support early warning

export interface SupportTicket {
  ticketId: string;
  hubspotCompanyId: string | null;
  subject: string;
  createdAt: string;
  isClosed: boolean;
  reopenCount: number;
  /** -2 (very negative) to 2 (very positive); null until scored by Claude. */
  sentiment: number | null;
  priority?: string | null;
  firstResponseAt?: string | null;
  closedAt?: string | null;
}

export interface SupportRules {
  reopenThreshold: number;
  openDays: number;
}

export type SupportSignal = 'REOPENED' | 'AGED' | 'NEGATIVE_SENTIMENT';

/**
 * Early warning before a support issue costs trust: open tickets that have been reopened,
 * have stayed open too long, or read as frustrated. Sentiment is optional (needs Claude);
 * re-opens and age work without it. One flag per customer, listing its risky tickets.
 */
export function auditSupportRisk(
  tickets: SupportTicket[],
  companies: HubSpotCompany[],
  today: IsoDate,
  rules: SupportRules,
): Finding[] {
  const byId = new Map(companies.map((c) => [c.hubspotId, c]));
  const risky = new Map<string, Array<{ t: SupportTicket; ageDays: number; signals: SupportSignal[] }>>();
  for (const t of tickets) {
    if (t.isClosed || !t.hubspotCompanyId || !byId.has(t.hubspotCompanyId)) continue;
    const ageDays = Math.max(0, daysBetween(todayInLagos(new Date(t.createdAt)), today));
    const signals: SupportSignal[] = [];
    if (t.reopenCount >= rules.reopenThreshold) signals.push('REOPENED');
    if (ageDays > rules.openDays) signals.push('AGED');
    if (t.sentiment !== null && t.sentiment <= -1) signals.push('NEGATIVE_SENTIMENT');
    if (signals.length === 0) continue;
    const list = risky.get(t.hubspotCompanyId) ?? [];
    list.push({ t, ageDays, signals });
    risky.set(t.hubspotCompanyId, list);
  }

  const findings: Finding[] = [];
  for (const [companyId, list] of risky) {
    const c = byId.get(companyId)!;
    list.sort((a, b) => b.signals.length - a.signals.length || b.ageDays - a.ageDays);
    const severe = list.some(({ t, signals }) => signals.length >= 2 || (t.sentiment ?? 0) <= -2 || t.reopenCount >= 2);
    const describe = ({ ageDays, signals, t }: (typeof list)[number]) =>
      [`open ${ageDays} days`, ...(signals.includes('REOPENED') ? [`reopened ${t.reopenCount}x`] : []), ...(signals.includes('NEGATIVE_SENTIMENT') ? ['frustrated tone'] : [])].join(', ');
    findings.push({
      type: 'SUPPORT_ESCALATION_RISK',
      severity: severe ? 'high' : 'medium',
      entityKey: `hs:${companyId}`,
      hubspotCompanyId: companyId,
      controlPanelId: c.controlPanelId,
      companyName: c.name,
      csmEmail: c.csmEmail,
      summary: `${list.length} open support ${list.length === 1 ? 'ticket' : 'tickets'} at risk: ${list.slice(0, 3).map(describe).join('; ')}${list.length > 3 ? '; …' : ''}`,
      details: {
        tickets: list.map(({ t, ageDays, signals }) => ({ ticketId: t.ticketId, subject: t.subject, ageDays, reopenCount: t.reopenCount, sentiment: t.sentiment, signals })),
      },
    });
  }
  return findings;
}
