import { ADJACENT } from './modules.js';

/**
 * Adoption, churn and upsell scoring. Everything here is a plain function of the facts passed in,
 * so every score can be explained line by line: each one returns the points and the reason.
 */

export type Band = 'hot' | 'warm' | 'cool';
export type RiskLevel = 'high' | 'medium' | 'low';
export type NpsBand = 'promoter' | 'passive' | 'detractor' | null;

export interface Reason {
  points: number;
  text: string;
}

export interface ModuleFact {
  key: string;
  label: string;
  status: 'in_use' | 'unused' | 'not_purchased';
  events30: number;
  eventsPrior30: number;
}

export interface Signal {
  kind: 'FUNDRAISE' | 'EXPANSION' | 'HIRING_PLAN' | 'OTHER';
  detail: string;
  happenedOn: string;
}

export interface CatalogModule {
  key: string;
  label: string;
  launchedOn: string | null;
  launchNote: string | null;
  active: boolean;
}

export interface SeasonWindow {
  module: string;
  startMonth: number;
  endMonth: number;
  boost: number;
  reason: string;
}

export interface ClientFacts {
  health: string | null;
  daysToRenewal: number | null;
  /** NPS and CSAT as stored; see `npsBand` and `csatPct` for how they are read. */
  nps: number | null;
  csat: number | null;
  openTickets: number;
  closedTickets90: number;
  slaBreaches: number;
  reopenedTickets: number;
  activityChangePct: number | null;
  engagementPct: number | null;
  primaryAdmin: 'active' | 'quiet' | 'dormant' | 'never' | 'none';
  payroll: 'ok' | 'late' | 'not_set_up' | 'unknown';
  seatUtilisationPct: number | null;
  urgentAlerts: number;
  modules: ModuleFact[];
  signals: Signal[];
}

export interface Scales {
  npsScale: '0_10' | 'minus100_100';
  csatMax: number;
}

// ---------------------------------------------------------------- reading NPS and CSAT

export function npsBand(nps: number | null | undefined, scale: Scales['npsScale']): NpsBand {
  if (nps === null || nps === undefined) return null;
  if (scale === '0_10') return nps >= 9 ? 'promoter' : nps >= 7 ? 'passive' : 'detractor';
  return nps >= 30 ? 'promoter' : nps >= 0 ? 'passive' : 'detractor';
}

/** CSAT as a percentage, whatever scale HubSpot holds it on. */
export function csatPct(csat: number | null | undefined, max: number): number | null {
  if (csat === null || csat === undefined || max <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((csat * 100) / max)));
}

// ---------------------------------------------------------------- adoption rate

export interface AdoptionRate {
  purchased: number;
  inUse: number;
  unused: number;
  /** Modules in use as a share of modules bought. Null when nothing has been bought, or we cannot tell. */
  ratePct: number | null;
  band: 'strong' | 'partial' | 'weak' | null;
}

export function adoptionRate(modules: ModuleFact[]): AdoptionRate {
  const bought = modules.filter((m) => m.status !== 'not_purchased');
  const inUse = bought.filter((m) => m.status === 'in_use').length;
  const ratePct = bought.length === 0 ? null : Math.round((inUse * 100) / bought.length);
  return { purchased: bought.length, inUse, unused: bought.length - inUse, ratePct, band: ratePct === null ? null : ratePct >= 80 ? 'strong' : ratePct >= 50 ? 'partial' : 'weak' };
}

// ---------------------------------------------------------------- churn

export interface Risk {
  score: number;
  level: RiskLevel;
  reasons: Reason[];
}

const level = (score: number): RiskLevel => (score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low');

/** How likely the whole account is to leave: adoption, admin engagement, experience and the commercial picture. */
export function churnRisk(f: ClientFacts, s: Scales): Risk {
  const reasons: Reason[] = [];
  const add = (points: number, text: string) => { if (points !== 0) reasons.push({ points, text }); };
  const a = adoptionRate(f.modules);
  if (a.ratePct !== null) add(Math.round(((100 - a.ratePct) * 30) / 100), `${a.inUse} of ${a.purchased} modules bought are in use (${a.ratePct}%)`);
  if (f.primaryAdmin === 'never') add(20, 'Primary admin has never logged in');
  else if (f.primaryAdmin === 'dormant') add(15, 'Primary admin has not logged in for over 30 days');
  else if (f.primaryAdmin === 'quiet') add(6, 'Primary admin has been quiet for over 2 weeks');
  if (f.activityChangePct !== null && f.activityChangePct <= -30) add(15, `Employee activity down ${-f.activityChangePct}% on the month before`);
  else if (f.activityChangePct !== null && f.activityChangePct <= -15) add(8, `Employee activity down ${-f.activityChangePct}% on the month before`);
  if (f.engagementPct !== null && f.engagementPct < 20) add(8, `Only ${f.engagementPct}% of seats are active on a typical day`);
  if (f.seatUtilisationPct !== null && f.seatUtilisationPct < 50) add(6, `Only ${f.seatUtilisationPct}% of paid seats are in use`);
  const nb = npsBand(f.nps, s.npsScale);
  if (nb === 'detractor') add(15, `NPS is ${f.nps} (a detractor)`);
  const cs = csatPct(f.csat, s.csatMax);
  if (cs !== null && cs < 60) add(10, `CSAT is ${cs}%`);
  if (f.slaBreaches >= 2) add(12, `${f.slaBreaches} support tickets are past their SLA`);
  else if (f.slaBreaches === 1) add(8, 'A support ticket is past its SLA');
  if (f.reopenedTickets > 0) add(4, `${f.reopenedTickets} ticket${f.reopenedTickets === 1 ? ' was' : 's were'} reopened`);
  if (f.openTickets >= 3) add(4, `${f.openTickets} tickets are open`);
  const h = f.health?.toLowerCase();
  if (h === 'at risk') add(12, 'HubSpot health is At Risk');
  else if (h === 'neutral') add(3, 'HubSpot health is Neutral');
  if (f.payroll === 'late') add(6, 'Payroll is late');
  else if (f.payroll === 'not_set_up') add(10, 'Payroll has not been set up');
  const base = reasons.reduce((n, r) => n + r.points, 0);
  if (f.daysToRenewal !== null && f.daysToRenewal >= 0 && f.daysToRenewal <= 90 && base >= 25) add(10, `Renewal is in ${f.daysToRenewal} days, with these risks open`);
  const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0));
  return { score, level: level(score), reasons: reasons.sort((x, y) => y.points - x.points) };
}

export interface ModuleRisk {
  module: string;
  label: string;
  risk: 'high' | 'medium';
  score: number;
  reasons: Reason[];
}

export interface PartialChurn {
  level: 'high' | 'medium' | 'none';
  modules: ModuleRisk[];
}

/** Which modules a customer may drop at renewal, even if they stay: bought but idle, or fading fast. */
export function partialChurn(f: ClientFacts, s: Scales): PartialChurn {
  const nb = npsBand(f.nps, s.npsScale);
  const unhappy = nb === 'detractor' || f.slaBreaches > 0;
  const out: ModuleRisk[] = [];
  for (const m of f.modules) {
    if (m.status === 'not_purchased') continue;
    const reasons: Reason[] = [];
    if (m.status === 'unused') reasons.push({ points: 60, text: 'Bought but not used in the last 30 days' });
    else if (m.eventsPrior30 >= 20 && m.events30 <= m.eventsPrior30 * 0.6) reasons.push({ points: 35, text: `Use fell ${Math.round(100 - (m.events30 * 100) / m.eventsPrior30)}% on the month before` });
    if (reasons.length === 0) continue;
    if (unhappy) reasons.push({ points: 10, text: nb === 'detractor' ? 'The customer is a detractor' : 'Support tickets are past their SLA' });
    if (f.daysToRenewal !== null && f.daysToRenewal >= 0 && f.daysToRenewal <= 120) reasons.push({ points: 15, text: `Renewal is in ${f.daysToRenewal} days, when modules get dropped` });
    const score = reasons.reduce((n, r) => n + r.points, 0);
    if (score >= 35) out.push({ module: m.key, label: m.label, risk: score >= 60 ? 'high' : 'medium', score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return { level: out.some((m) => m.risk === 'high') ? 'high' : out.length ? 'medium' : 'none', modules: out };
}

// ---------------------------------------------------------------- seasonality

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inWindow = (month: number, w: SeasonWindow) => (w.startMonth <= w.endMonth ? month >= w.startMonth && month <= w.endMonth : month >= w.startMonth || month <= w.endMonth);
export const windowLabel = (w: SeasonWindow) => (w.startMonth === w.endMonth ? MONTH_NAMES[w.startMonth - 1]! : `${MONTH_NAMES[w.startMonth - 1]} to ${MONTH_NAMES[w.endMonth - 1]}`);

/** Whole-day distance from a date to the start of a window's next opening (0 if it is open now). */
function daysUntilOpen(today: Date, w: SeasonWindow): number {
  if (inWindow(today.getUTCMonth() + 1, w)) return 0;
  const y = today.getUTCFullYear();
  const opens = [Date.UTC(y, w.startMonth - 1, 1), Date.UTC(y + 1, w.startMonth - 1, 1)].find((t) => t > today.getTime())!;
  return Math.ceil((opens - today.getTime()) / 86_400_000);
}

export interface Season {
  points: number;
  text: string;
  /** Advice on when to raise it. */
  when: string | null;
  state: 'open' | 'opening' | 'closed';
}

/** The strongest seasonal pull for a module today: full boost inside a window, half in the weeks before one opens. */
export function seasonFor(module: string, windows: SeasonWindow[], today: Date, lookaheadDays: number): Season {
  let best: Season = { points: 0, text: '', when: null, state: 'closed' };
  for (const w of windows.filter((x) => x.module === module)) {
    const d = daysUntilOpen(today, w);
    if (d === 0 && w.boost > best.points) best = { points: w.boost, text: `${w.reason} (${windowLabel(w)})`, when: `Buying season is open now (${windowLabel(w)})`, state: 'open' };
    else if (d > 0 && d <= lookaheadDays && Math.round(w.boost / 2) > best.points) best = { points: Math.round(w.boost / 2), text: `${w.reason} starts in ${d} days (${windowLabel(w)})`, when: `Start the conversation now: the season opens in ${d} days`, state: 'opening' };
  }
  if (best.state === 'closed') {
    const next = windows.filter((x) => x.module === module).map((w) => ({ w, d: daysUntilOpen(today, w) })).sort((a, b) => a.d - b.d)[0];
    if (next) best.when = `Next buying season: ${windowLabel(next.w)} (${next.w.reason.toLowerCase()})`;
  }
  return best;
}

// ---------------------------------------------------------------- upsell

export interface Opportunity {
  module: string;
  label: string;
  score: number;
  band: Band;
  reasons: Reason[];
  /** Why now is not the time, when it is not. Empty when the account is ready. */
  holds: string[];
  isNewLaunch: boolean;
  when: string | null;
}

export interface UpsellContext {
  catalog: CatalogModule[];
  windows: SeasonWindow[];
  /** Share (0-100) of all customers that have bought each module. */
  peerPct: Map<string, number>;
  today: Date;
  launchDays: number;
  lookaheadDays: number;
  signalDays: number;
}

/** Which growth signals point to which modules. A signal of any kind adds a little to everything. */
export const SIGNAL_AFFINITY: Record<Signal['kind'], string[]> = {
  FUNDRAISE: ['PERFORMANCE', 'CORE_HR', 'PAYROLL', 'EXPENSES'],
  EXPANSION: ['TIME', 'STATUTORY', 'LEAVE', 'CORE_HR'],
  HIRING_PLAN: ['CORE_HR', 'PERFORMANCE', 'LEAVE', 'PAYROLL'],
  OTHER: [],
};
const SIGNAL_LABEL: Record<Signal['kind'], string> = { FUNDRAISE: 'Fund raise', EXPANSION: 'Expansion plans', HIRING_PLAN: 'Hiring plans', OTHER: 'Growth news' };

const bandOf = (score: number): Band => (score >= 60 ? 'hot' : score >= 40 ? 'warm' : 'cool');
const daysAgo = (iso: string, today: Date) => Math.max(0, Math.round((today.getTime() - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000));

/**
 * Every module a customer has not bought, scored 0-100 from six things: what they have bought,
 * what they actually use, how their experience has been, the time of year, new launches, and
 * what we know about their growth plans. Each point is explained.
 */
export function upsellOpportunities(f: ClientFacts, s: Scales, ctx: UpsellContext, risk: Risk): Opportunity[] {
  const rate = adoptionRate(f.modules);
  if (rate.purchased === 0) return [];
  const inUse = new Set(f.modules.filter((m) => m.status === 'in_use').map((m) => m.key));
  const own = new Map(f.modules.map((m) => [m.key, m]));
  const nb = npsBand(f.nps, s.npsScale);
  const cs = csatPct(f.csat, s.csatMax);
  const signals = f.signals.filter((x) => daysAgo(x.happenedOn, ctx.today) <= ctx.signalDays);
  const holds: string[] = [];
  if (risk.level === 'high') holds.push('Churn risk is high: save the account before selling');
  if (f.health?.toLowerCase() === 'at risk') holds.push('HubSpot health is At Risk');
  if (f.urgentAlerts > 0) holds.push('Urgent or high alerts are open');
  if (nb === 'detractor') holds.push('The customer is a detractor');

  // Experience is the same for every module, so work it out once.
  const experience: Reason[] = [];
  if (nb === 'promoter') experience.push({ points: 14, text: `NPS is ${f.nps} (a promoter)` });
  else if (nb === 'passive') experience.push({ points: 4, text: `NPS is ${f.nps} (passive)` });
  else if (nb === 'detractor') experience.push({ points: -18, text: `NPS is ${f.nps} (a detractor)` });
  if (cs !== null && cs >= 80) experience.push({ points: 8, text: `CSAT is ${cs}%` });
  else if (cs !== null && cs < 60) experience.push({ points: -12, text: `CSAT is only ${cs}%` });
  if (f.slaBreaches > 0) experience.push({ points: -12, text: `${f.slaBreaches} support ticket${f.slaBreaches === 1 ? ' is' : 's are'} past SLA` });
  else if (f.openTickets >= 3) experience.push({ points: -8, text: `${f.openTickets} tickets are open` });
  if (f.reopenedTickets > 0) experience.push({ points: -5, text: 'Tickets have been reopened' });
  if (f.openTickets === 0 && f.closedTickets90 > 0) experience.push({ points: 3, text: `All ${f.closedTickets90} recent tickets are closed` });

  const readiness: Reason[] = [];
  if (rate.ratePct !== null && rate.ratePct >= 80) readiness.push({ points: 12, text: `Uses ${rate.inUse} of ${rate.purchased} modules bought (${rate.ratePct}%)` });
  else if (rate.ratePct !== null && rate.ratePct >= 50) readiness.push({ points: 6, text: `Uses ${rate.inUse} of ${rate.purchased} modules bought (${rate.ratePct}%)` });
  else if (rate.ratePct !== null) readiness.push({ points: -12, text: `Uses only ${rate.inUse} of ${rate.purchased} modules bought: fix adoption first` });
  if (f.engagementPct !== null && f.engagementPct >= 40) readiness.push({ points: 4, text: `${f.engagementPct}% of seats are active on a typical day` });

  const out: Opportunity[] = [];
  for (const m of ctx.catalog.filter((x) => x.active)) {
    if (own.get(m.key)?.status && own.get(m.key)!.status !== 'not_purchased') continue;
    const reasons: Reason[] = [];
    const peer = ctx.peerPct.get(m.key) ?? 0;
    if (peer > 0) reasons.push({ points: Math.min(20, Math.round(peer * 0.2)), text: `${peer}% of customers have it` });
    let adj = 0;
    for (const a of ADJACENT[m.key] ?? []) if (inUse.has(a.uses) && adj < 2) { adj += 1; reasons.push({ points: 8, text: `Uses ${ctx.catalog.find((c) => c.key === a.uses)?.label ?? a.uses} and ${a.because}` }); }
    reasons.push(...readiness, ...experience);
    const season = seasonFor(m.key, ctx.windows, ctx.today, ctx.lookaheadDays);
    if (season.points > 0) reasons.push({ points: season.points, text: season.text });
    let isNew = false;
    if (m.launchedOn) {
      const age = daysAgo(m.launchedOn, ctx.today);
      if (age <= ctx.launchDays && Date.parse(m.launchedOn) <= ctx.today.getTime()) { isNew = true; reasons.push({ points: age <= ctx.launchDays / 2 ? 12 : 8, text: `New module, launched ${age === 0 ? 'today' : `${age} days ago`}${m.launchNote ? `: ${m.launchNote}` : ''}` }); }
    }
    let sig = 0;
    for (const x of signals) {
      const affinity = SIGNAL_AFFINITY[x.kind].includes(m.key);
      const pts = affinity ? 15 : 4;
      if (sig + pts > 25) continue;
      sig += pts;
      reasons.push({ points: pts, text: `${SIGNAL_LABEL[x.kind]}: ${x.detail}${affinity ? '' : ' (general growth)'}` });
    }
    const raw = reasons.reduce((n, r) => n + r.points, 0);
    const score = Math.max(0, Math.min(100, raw));
    out.push({ module: m.key, label: m.label, score, band: bandOf(score), reasons: reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)), holds, isNewLaunch: isNew, when: season.when });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** How the scores are built, in words, so the app can show it next to the numbers. */
export const SCORING_NOTES = {
  adoption: 'Adoption rate is modules in use divided by modules bought. A module is in use when employees or admins have used it in the last 30 days (payroll 45, wage access 30, statutory 60 for the most recent run).',
  churn: [
    'Adoption: up to 30 points, more the fewer modules bought are in use',
    'Primary admin: 20 if never logged in, 15 if dormant over 30 days, 6 if quiet over 2 weeks',
    'Employee activity down 30% or more: 15 (15% or more: 8). Under 20% of seats active: 8. Under 50% of paid seats in use: 6',
    'Experience: NPS detractor 15, CSAT under 60% 10, tickets past SLA 8 to 12, reopened 4, three or more open 4',
    'Commercial: HubSpot health At Risk 12 (Neutral 3), payroll late 6 or not set up 10',
    'Renewal within 90 days while other risks already add up to 25 or more: 10',
    'High is 60 or more, medium 35 or more',
  ],
  partialChurn: [
    'A module bought but not used in the last 30 days: 60',
    'Use fell 40% or more on the month before (from at least 20 actions): 35',
    'Plus 10 if the customer is a detractor or has tickets past SLA, and 15 if renewal is within 120 days',
    'Shown at 35 or more; high at 60 or more',
  ],
  upsell: [
    'Modules purchased: up to 20 for how many customers have it, 8 for each related module they already use (up to 2)',
    'Modules in use: 12 when 80% or more of what they bought is in use, 6 at 50%, minus 12 below that. 4 more when 40% of seats are active',
    'Experience so far: NPS promoter 14, passive 4, detractor minus 18. CSAT 80% or more 8, under 60% minus 12. Tickets past SLA minus 12, three or more open minus 8, reopened minus 5, all recent tickets closed 3',
    'Seasonality: the full boost for each buying season while it is open, half in the weeks before it opens',
    'New launch: 12 in the first half of the launch window, 8 after that',
    'Growth plans: 15 for a fund raise, expansion or hiring plan that fits the module, 4 for any other, up to 25 in all',
    'Hot is 60 or more, warm 40 or more, cool 20 or more. Accounts with high churn risk, At Risk health, urgent alerts or a detractor score are held, not pushed',
  ],
};
