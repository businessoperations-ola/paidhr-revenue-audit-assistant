import { DEFAULT_SCORING, type ScoringConfig } from './scoring-config.js';

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

export function adoptionRate(modules: ModuleFact[], cfg: ScoringConfig = DEFAULT_SCORING): AdoptionRate {
  const bought = modules.filter((m) => m.status !== 'not_purchased');
  const inUse = bought.filter((m) => m.status === 'in_use').length;
  const ratePct = bought.length === 0 ? null : Math.round((inUse * 100) / bought.length);
  return { purchased: bought.length, inUse, unused: bought.length - inUse, ratePct, band: ratePct === null ? null : ratePct >= cfg.bands.adoptionStrongPct ? 'strong' : ratePct >= cfg.bands.adoptionPartialPct ? 'partial' : 'weak' };
}

// ---------------------------------------------------------------- churn

export interface Risk {
  score: number;
  level: RiskLevel;
  reasons: Reason[];
}

const levelOf = (score: number, cfg: ScoringConfig): RiskLevel => (score >= cfg.churn.high ? 'high' : score >= cfg.churn.medium ? 'medium' : 'low');

/** How likely the whole account is to leave: adoption, admin engagement, experience and the commercial picture. */
export function churnRisk(f: ClientFacts, s: Scales, cfg: ScoringConfig = DEFAULT_SCORING): Risk {
  const c = cfg.churn;
  const reasons: Reason[] = [];
  const add = (points: number, text: string) => { if (points !== 0) reasons.push({ points, text }); };
  const a = adoptionRate(f.modules, cfg);
  if (a.ratePct !== null) add(Math.round(((100 - a.ratePct) * c.adoptionMax) / 100), `${a.inUse} of ${a.purchased} modules bought are in use (${a.ratePct}%)`);
  if (f.primaryAdmin === 'never') add(c.adminNever, 'Primary admin has never logged in');
  else if (f.primaryAdmin === 'dormant') add(c.adminDormant, 'Primary admin has not logged in for over 30 days');
  else if (f.primaryAdmin === 'quiet') add(c.adminQuiet, 'Primary admin has been quiet for over 2 weeks');
  if (f.activityChangePct !== null && f.activityChangePct <= -c.activityDropBigPct) add(c.activityDropBig, `Employee activity down ${-f.activityChangePct}% on the month before`);
  else if (f.activityChangePct !== null && f.activityChangePct <= -c.activityDropSmallPct) add(c.activityDropSmall, `Employee activity down ${-f.activityChangePct}% on the month before`);
  if (f.engagementPct !== null && f.engagementPct < c.lowEngagementPct) add(c.lowEngagement, `Only ${f.engagementPct}% of seats are active on a typical day`);
  if (f.seatUtilisationPct !== null && f.seatUtilisationPct < c.lowSeatPct) add(c.lowSeat, `Only ${f.seatUtilisationPct}% of paid seats are in use`);
  const nb = npsBand(f.nps, s.npsScale);
  if (nb === 'detractor') add(c.detractor, `NPS is ${f.nps} (a detractor)`);
  const cs = csatPct(f.csat, s.csatMax);
  if (cs !== null && cs < c.csatLowPct) add(c.csatLow, `CSAT is ${cs}%`);
  if (f.slaBreaches >= 2) add(c.slaMany, `${f.slaBreaches} support tickets are past their SLA`);
  else if (f.slaBreaches === 1) add(c.slaOne, 'A support ticket is past its SLA');
  if (f.reopenedTickets > 0) add(c.reopened, `${f.reopenedTickets} ticket${f.reopenedTickets === 1 ? ' was' : 's were'} reopened`);
  if (f.openTickets >= c.openManyCount) add(c.openMany, `${f.openTickets} tickets are open`);
  const h = f.health?.toLowerCase();
  if (h === 'at risk') add(c.healthAtRisk, 'HubSpot health is At Risk');
  else if (h === 'neutral') add(c.healthNeutral, 'HubSpot health is Neutral');
  if (f.payroll === 'late') add(c.payrollLate, 'Payroll is late');
  else if (f.payroll === 'not_set_up') add(c.payrollNotSetUp, 'Payroll has not been set up');
  const base = reasons.reduce((n, r) => n + r.points, 0);
  if (f.daysToRenewal !== null && f.daysToRenewal >= 0 && f.daysToRenewal <= c.renewalDays && base >= c.renewalMinBase) add(c.renewal, `Renewal is in ${f.daysToRenewal} days, with these risks open`);
  const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0));
  return { score, level: levelOf(score, cfg), reasons: reasons.sort((x, y) => y.points - x.points) };
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
export function partialChurn(f: ClientFacts, s: Scales, cfg: ScoringConfig = DEFAULT_SCORING): PartialChurn {
  const p = cfg.partial;
  const nb = npsBand(f.nps, s.npsScale);
  const unhappy = nb === 'detractor' || f.slaBreaches > 0;
  const out: ModuleRisk[] = [];
  for (const m of f.modules) {
    if (m.status === 'not_purchased') continue;
    const reasons: Reason[] = [];
    if (m.status === 'unused') reasons.push({ points: p.unused, text: 'Bought but not used in the last 30 days' });
    else if (m.eventsPrior30 >= p.declineMinBase && m.events30 <= (m.eventsPrior30 * (100 - p.declinePct)) / 100) reasons.push({ points: p.decline, text: `Use fell ${Math.round(100 - (m.events30 * 100) / m.eventsPrior30)}% on the month before` });
    if (reasons.length === 0) continue;
    if (unhappy) reasons.push({ points: p.unhappy, text: nb === 'detractor' ? 'The customer is a detractor' : 'Support tickets are past their SLA' });
    if (f.daysToRenewal !== null && f.daysToRenewal >= 0 && f.daysToRenewal <= p.renewalDays) reasons.push({ points: p.renewal, text: `Renewal is in ${f.daysToRenewal} days, when modules get dropped` });
    const score = reasons.reduce((n, r) => n + r.points, 0);
    if (score >= p.show) out.push({ module: m.key, label: m.label, risk: score >= p.high ? 'high' : 'medium', score, reasons });
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
}

const SIGNAL_LABEL: Record<Signal['kind'], string> = { FUNDRAISE: 'Fund raise', EXPANSION: 'Expansion plans', HIRING_PLAN: 'Hiring plans', OTHER: 'Growth news' };

const daysAgo = (iso: string, today: Date) => Math.max(0, Math.round((today.getTime() - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000));

/**
 * Every module a customer has not bought, scored 0-100 from six things: what they have bought,
 * what they actually use, how their experience has been, the time of year, new launches, and
 * what we know about their growth plans. Each point is explained. All weights come from `cfg`.
 */
export function upsellOpportunities(f: ClientFacts, s: Scales, ctx: UpsellContext, risk: Risk, cfg: ScoringConfig = DEFAULT_SCORING): Opportunity[] {
  const u = cfg.upsell;
  const bandOf = (score: number): Band => (score >= u.hot ? 'hot' : score >= u.warm ? 'warm' : 'cool');
  const rate = adoptionRate(f.modules, cfg);
  if (rate.purchased === 0) return [];
  const inUse = new Set(f.modules.filter((m) => m.status === 'in_use').map((m) => m.key));
  const own = new Map(f.modules.map((m) => [m.key, m]));
  const nb = npsBand(f.nps, s.npsScale);
  const cs = csatPct(f.csat, s.csatMax);
  const signals = f.signals.filter((x) => daysAgo(x.happenedOn, ctx.today) <= u.signalDays);
  const holds: string[] = [];
  if (cfg.holds.churnHigh && risk.level === 'high') holds.push('Churn risk is high: save the account before selling');
  if (cfg.holds.atRisk && f.health?.toLowerCase() === 'at risk') holds.push('HubSpot health is At Risk');
  if (cfg.holds.urgentAlerts && f.urgentAlerts > 0) holds.push('Urgent or high alerts are open');
  if (cfg.holds.detractor && nb === 'detractor') holds.push('The customer is a detractor');

  // Experience is the same for every module, so work it out once.
  const experience: Reason[] = [];
  if (nb === 'promoter') experience.push({ points: u.npsPromoter, text: `NPS is ${f.nps} (a promoter)` });
  else if (nb === 'passive') experience.push({ points: u.npsPassive, text: `NPS is ${f.nps} (passive)` });
  else if (nb === 'detractor') experience.push({ points: u.npsDetractor, text: `NPS is ${f.nps} (a detractor)` });
  if (cs !== null && cs >= u.csatHighPct) experience.push({ points: u.csatHigh, text: `CSAT is ${cs}%` });
  else if (cs !== null && cs < u.csatLowPct) experience.push({ points: u.csatLow, text: `CSAT is only ${cs}%` });
  if (f.slaBreaches > 0) experience.push({ points: u.slaBreach, text: `${f.slaBreaches} support ticket${f.slaBreaches === 1 ? ' is' : 's are'} past SLA` });
  else if (f.openTickets >= u.openManyCount) experience.push({ points: u.openMany, text: `${f.openTickets} tickets are open` });
  if (f.reopenedTickets > 0) experience.push({ points: u.reopened, text: 'Tickets have been reopened' });
  if (f.openTickets === 0 && f.closedTickets90 > 0) experience.push({ points: u.allClosed, text: `All ${f.closedTickets90} recent tickets are closed` });

  const readiness: Reason[] = [];
  if (rate.ratePct !== null && rate.ratePct >= u.adoptionStrongPct) readiness.push({ points: u.adoptionStrong, text: `Uses ${rate.inUse} of ${rate.purchased} modules bought (${rate.ratePct}%)` });
  else if (rate.ratePct !== null && rate.ratePct >= u.adoptionPartialPct) readiness.push({ points: u.adoptionPartial, text: `Uses ${rate.inUse} of ${rate.purchased} modules bought (${rate.ratePct}%)` });
  else if (rate.ratePct !== null) readiness.push({ points: u.adoptionWeak, text: `Uses only ${rate.inUse} of ${rate.purchased} modules bought: fix adoption first` });
  if (f.engagementPct !== null && f.engagementPct >= u.engagementPct) readiness.push({ points: u.engagement, text: `${f.engagementPct}% of seats are active on a typical day` });

  const out: Opportunity[] = [];
  for (const m of ctx.catalog.filter((x) => x.active)) {
    if (own.get(m.key)?.status && own.get(m.key)!.status !== 'not_purchased') continue;
    const reasons: Reason[] = [];
    const peer = ctx.peerPct.get(m.key) ?? 0;
    if (peer > 0) reasons.push({ points: Math.min(u.peerCap, Math.round((peer * u.peerFactorPct) / 100)), text: `${peer}% of customers have it` });
    let adj = 0;
    for (const a of cfg.related[m.key] ?? []) if (inUse.has(a.uses) && adj < u.adjacentMax) { adj += 1; reasons.push({ points: u.adjacent, text: `Uses ${ctx.catalog.find((c) => c.key === a.uses)?.label ?? a.uses} and ${a.because}` }); }
    reasons.push(...readiness, ...experience);
    const season = seasonFor(m.key, ctx.windows, ctx.today, ctx.lookaheadDays);
    if (season.points > 0) reasons.push({ points: season.points, text: season.text });
    let isNew = false;
    if (m.launchedOn) {
      const age = daysAgo(m.launchedOn, ctx.today);
      if (age <= ctx.launchDays && Date.parse(m.launchedOn) <= ctx.today.getTime()) { isNew = true; reasons.push({ points: age <= ctx.launchDays / 2 ? u.launchFirstHalf : u.launchSecondHalf, text: `New module, launched ${age === 0 ? 'today' : `${age} days ago`}${m.launchNote ? `: ${m.launchNote}` : ''}` }); }
    }
    let sig = 0;
    for (const x of signals) {
      const affinity = (cfg.signalAffinity[x.kind] ?? []).includes(m.key);
      const pts = affinity ? u.signalFit : u.signalGeneral;
      if (sig + pts > u.signalCap) continue;
      sig += pts;
      reasons.push({ points: pts, text: `${SIGNAL_LABEL[x.kind]}: ${x.detail}${affinity ? '' : ' (general growth)'}` });
    }
    const raw = reasons.reduce((n, r) => n + r.points, 0);
    const score = Math.max(0, Math.min(100, raw));
    out.push({ module: m.key, label: m.label, score, band: bandOf(score), reasons: reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)), holds, isNewLaunch: isNew, when: season.when });
  }
  return out.sort((a, b) => b.score - a.score);
}
