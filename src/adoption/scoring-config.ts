/**
 * Every number behind adoption bands, churn risk, partial churn and upsell scoring, in one document.
 * Built-in defaults live here; the Head of CX can change any of them in the app and the saved values win.
 */

export interface ScoringConfig {
  bands: { adoptionStrongPct: number; adoptionPartialPct: number };
  churn: {
    adoptionMax: number;
    adminNever: number; adminDormant: number; adminQuiet: number;
    activityDropBigPct: number; activityDropBig: number; activityDropSmallPct: number; activityDropSmall: number;
    lowEngagementPct: number; lowEngagement: number; lowSeatPct: number; lowSeat: number;
    detractor: number; csatLowPct: number; csatLow: number;
    slaMany: number; slaOne: number; reopened: number; openManyCount: number; openMany: number;
    healthAtRisk: number; healthNeutral: number; payrollLate: number; payrollNotSetUp: number;
    renewalDays: number; renewalMinBase: number; renewal: number;
    medium: number; high: number;
  };
  partial: { unused: number; decline: number; declinePct: number; declineMinBase: number; unhappy: number; renewalDays: number; renewal: number; show: number; high: number };
  upsell: {
    peerFactorPct: number; peerCap: number; adjacent: number; adjacentMax: number;
    adoptionStrongPct: number; adoptionStrong: number; adoptionPartialPct: number; adoptionPartial: number; adoptionWeak: number;
    engagementPct: number; engagement: number;
    npsPromoter: number; npsPassive: number; npsDetractor: number;
    csatHighPct: number; csatHigh: number; csatLowPct: number; csatLow: number;
    slaBreach: number; openManyCount: number; openMany: number; reopened: number; allClosed: number;
    launchFirstHalf: number; launchSecondHalf: number;
    signalFit: number; signalGeneral: number; signalCap: number; signalDays: number;
    hot: number; warm: number; cool: number;
  };
  /** Which situations stop us pushing an upsell. */
  holds: { churnHigh: boolean; atRisk: boolean; urgentAlerts: boolean; detractor: boolean };
  /** A customer that uses `uses` is a good candidate for the module. */
  related: Record<string, Array<{ uses: string; because: string }>>;
  /** Which modules each kind of growth news points to. */
  signalAffinity: Record<'FUNDRAISE' | 'EXPANSION' | 'HIRING_PLAN' | 'OTHER', string[]>;
}

export const DEFAULT_SCORING: ScoringConfig = {
  bands: { adoptionStrongPct: 80, adoptionPartialPct: 50 },
  churn: {
    adoptionMax: 30, adminNever: 20, adminDormant: 15, adminQuiet: 6,
    activityDropBigPct: 30, activityDropBig: 15, activityDropSmallPct: 15, activityDropSmall: 8,
    lowEngagementPct: 20, lowEngagement: 8, lowSeatPct: 50, lowSeat: 6,
    detractor: 15, csatLowPct: 60, csatLow: 10,
    slaMany: 12, slaOne: 8, reopened: 4, openManyCount: 3, openMany: 4,
    healthAtRisk: 12, healthNeutral: 3, payrollLate: 6, payrollNotSetUp: 10,
    renewalDays: 90, renewalMinBase: 25, renewal: 10,
    medium: 35, high: 60,
  },
  partial: { unused: 60, decline: 35, declinePct: 40, declineMinBase: 20, unhappy: 10, renewalDays: 120, renewal: 15, show: 35, high: 60 },
  upsell: {
    peerFactorPct: 20, peerCap: 20, adjacent: 8, adjacentMax: 2,
    adoptionStrongPct: 80, adoptionStrong: 12, adoptionPartialPct: 50, adoptionPartial: 6, adoptionWeak: -12,
    engagementPct: 40, engagement: 4,
    npsPromoter: 14, npsPassive: 4, npsDetractor: -18,
    csatHighPct: 80, csatHigh: 8, csatLowPct: 60, csatLow: -12,
    slaBreach: -12, openManyCount: 3, openMany: -8, reopened: -5, allClosed: 3,
    launchFirstHalf: 12, launchSecondHalf: 8,
    signalFit: 15, signalGeneral: 4, signalCap: 25, signalDays: 180,
    hot: 60, warm: 40, cool: 20,
  },
  holds: { churnHigh: true, atRisk: true, urgentAlerts: true, detractor: true },
  related: {
    STATUTORY: [{ uses: 'PAYROLL', because: 'runs payroll but does remittance by hand' }],
    EWA: [{ uses: 'PAYROLL', because: 'runs payroll and employees could draw early' }, { uses: 'LOANS', because: 'employees already ask for loans' }],
    LOANS: [{ uses: 'PAYROLL', because: 'runs payroll, so repayments can come off pay' }],
    TIME: [{ uses: 'LEAVE', because: 'already manages leave in the platform' }],
    EXPENSES: [{ uses: 'PAYROLL', because: 'can reimburse through payroll' }],
    LEAVE: [{ uses: 'CORE_HR', because: 'keeps employee records here' }],
    CORE_HR: [{ uses: 'PAYROLL', because: 'runs payroll on employee records' }],
    PERFORMANCE: [{ uses: 'CORE_HR', because: 'keeps employee records here for reviews to build on' }, { uses: 'PAYROLL', because: 'can link reviews to pay' }],
    REQUISITION: [{ uses: 'CORE_HR', because: 'keeps employee records here for hiring to build on' }],
  },
  signalAffinity: {
    FUNDRAISE: ['PERFORMANCE', 'CORE_HR', 'PAYROLL', 'EXPENSES'],
    EXPANSION: ['TIME', 'STATUTORY', 'LEAVE', 'CORE_HR'],
    HIRING_PLAN: ['CORE_HR', 'PERFORMANCE', 'LEAVE', 'PAYROLL', 'REQUISITION'],
    OTHER: [],
  },
};

export interface ScoringField {
  path: string;
  group: string;
  label: string;
  min: number;
  max: number;
  unit: 'points' | 'percent' | 'days' | 'count';
  help?: string;
}

const F = (path: string, group: string, label: string, min: number, max: number, unit: ScoringField['unit'], help?: string): ScoringField => ({ path, group, label, min, max, unit, help });

/** The editable numbers, with the range each may take. The app builds its settings forms from this list. */
export const SCORING_FIELDS: ScoringField[] = [
  F('bands.adoptionStrongPct', 'Adoption bands', 'Strong adoption from', 1, 100, 'percent', 'Share of bought modules in use'),
  F('bands.adoptionPartialPct', 'Adoption bands', 'Partial adoption from', 1, 100, 'percent', 'Below this is weak'),

  F('churn.adoptionMax', 'Churn risk: adoption and engagement', 'Adoption: most points (when nothing is used)', 0, 60, 'points'),
  F('churn.adminNever', 'Churn risk: adoption and engagement', 'Primary admin never logged in', 0, 40, 'points'),
  F('churn.adminDormant', 'Churn risk: adoption and engagement', 'Primary admin dormant (over 30 days)', 0, 40, 'points'),
  F('churn.adminQuiet', 'Churn risk: adoption and engagement', 'Primary admin quiet (over 14 days)', 0, 40, 'points'),
  F('churn.activityDropBigPct', 'Churn risk: adoption and engagement', 'Big activity drop from', 1, 100, 'percent'),
  F('churn.activityDropBig', 'Churn risk: adoption and engagement', 'Points for a big drop', 0, 40, 'points'),
  F('churn.activityDropSmallPct', 'Churn risk: adoption and engagement', 'Smaller activity drop from', 1, 100, 'percent'),
  F('churn.activityDropSmall', 'Churn risk: adoption and engagement', 'Points for a smaller drop', 0, 40, 'points'),
  F('churn.lowEngagementPct', 'Churn risk: adoption and engagement', 'Low engagement: seats active under', 1, 100, 'percent'),
  F('churn.lowEngagement', 'Churn risk: adoption and engagement', 'Points for low engagement', 0, 40, 'points'),
  F('churn.lowSeatPct', 'Churn risk: adoption and engagement', 'Low seat use: paid seats in use under', 1, 100, 'percent'),
  F('churn.lowSeat', 'Churn risk: adoption and engagement', 'Points for low seat use', 0, 40, 'points'),

  F('churn.detractor', 'Churn risk: experience and commercial', 'NPS detractor', 0, 40, 'points'),
  F('churn.csatLowPct', 'Churn risk: experience and commercial', 'Low CSAT: under', 1, 100, 'percent'),
  F('churn.csatLow', 'Churn risk: experience and commercial', 'Points for low CSAT', 0, 40, 'points'),
  F('churn.slaMany', 'Churn risk: experience and commercial', 'Two or more tickets past SLA', 0, 40, 'points'),
  F('churn.slaOne', 'Churn risk: experience and commercial', 'One ticket past SLA', 0, 40, 'points'),
  F('churn.reopened', 'Churn risk: experience and commercial', 'Reopened tickets', 0, 40, 'points'),
  F('churn.openManyCount', 'Churn risk: experience and commercial', 'Many open tickets: from', 1, 50, 'count'),
  F('churn.openMany', 'Churn risk: experience and commercial', 'Points for many open tickets', 0, 40, 'points'),
  F('churn.healthAtRisk', 'Churn risk: experience and commercial', 'HubSpot health At Risk', 0, 40, 'points'),
  F('churn.healthNeutral', 'Churn risk: experience and commercial', 'HubSpot health Neutral', 0, 40, 'points'),
  F('churn.payrollLate', 'Churn risk: experience and commercial', 'Payroll late', 0, 40, 'points'),
  F('churn.payrollNotSetUp', 'Churn risk: experience and commercial', 'Payroll not set up', 0, 40, 'points'),
  F('churn.renewalDays', 'Churn risk: experience and commercial', 'Renewal amplifier: renewing within', 1, 365, 'days'),
  F('churn.renewalMinBase', 'Churn risk: experience and commercial', 'Only when other risk is at least', 0, 100, 'points'),
  F('churn.renewal', 'Churn risk: experience and commercial', 'Points added near renewal', 0, 40, 'points'),
  F('churn.medium', 'Churn risk: levels', 'Medium risk from', 1, 100, 'points'),
  F('churn.high', 'Churn risk: levels', 'High risk from', 1, 100, 'points'),

  F('partial.unused', 'Partial churn', 'Bought but not in use', 0, 100, 'points'),
  F('partial.decline', 'Partial churn', 'Use fading', 0, 100, 'points'),
  F('partial.declinePct', 'Partial churn', 'Fading means use down by at least', 1, 100, 'percent'),
  F('partial.declineMinBase', 'Partial churn', 'Only if the month before had at least', 0, 1000, 'count', 'Actions, so tiny numbers do not trigger it'),
  F('partial.unhappy', 'Partial churn', 'Detractor or tickets past SLA', 0, 100, 'points'),
  F('partial.renewalDays', 'Partial churn', 'Renewal amplifier: renewing within', 1, 365, 'days'),
  F('partial.renewal', 'Partial churn', 'Points added near renewal', 0, 100, 'points'),
  F('partial.show', 'Partial churn', 'Show a module at', 1, 200, 'points'),
  F('partial.high', 'Partial churn', 'High risk at', 1, 200, 'points'),

  F('upsell.peerFactorPct', 'Upsell: modules purchased and in use', 'Peer share: points per 100% of customers', 0, 100, 'points', 'A module 70% of customers have earns 70% of this'),
  F('upsell.peerCap', 'Upsell: modules purchased and in use', 'Peer share: most points', 0, 40, 'points'),
  F('upsell.adjacent', 'Upsell: modules purchased and in use', 'Each related module they already use', 0, 40, 'points'),
  F('upsell.adjacentMax', 'Upsell: modules purchased and in use', 'Count at most this many related modules', 0, 5, 'count'),
  F('upsell.adoptionStrongPct', 'Upsell: modules purchased and in use', 'Strong adoption from', 1, 100, 'percent'),
  F('upsell.adoptionStrong', 'Upsell: modules purchased and in use', 'Points for strong adoption', -40, 40, 'points'),
  F('upsell.adoptionPartialPct', 'Upsell: modules purchased and in use', 'Partial adoption from', 1, 100, 'percent'),
  F('upsell.adoptionPartial', 'Upsell: modules purchased and in use', 'Points for partial adoption', -40, 40, 'points'),
  F('upsell.adoptionWeak', 'Upsell: modules purchased and in use', 'Points for weak adoption', -40, 40, 'points'),
  F('upsell.engagementPct', 'Upsell: modules purchased and in use', 'Engaged: seats active from', 1, 100, 'percent'),
  F('upsell.engagement', 'Upsell: modules purchased and in use', 'Points for engagement', -40, 40, 'points'),

  F('upsell.npsPromoter', 'Upsell: experience so far', 'NPS promoter', -40, 40, 'points'),
  F('upsell.npsPassive', 'Upsell: experience so far', 'NPS passive', -40, 40, 'points'),
  F('upsell.npsDetractor', 'Upsell: experience so far', 'NPS detractor', -40, 40, 'points'),
  F('upsell.csatHighPct', 'Upsell: experience so far', 'High CSAT from', 1, 100, 'percent'),
  F('upsell.csatHigh', 'Upsell: experience so far', 'Points for high CSAT', -40, 40, 'points'),
  F('upsell.csatLowPct', 'Upsell: experience so far', 'Low CSAT: under', 1, 100, 'percent'),
  F('upsell.csatLow', 'Upsell: experience so far', 'Points for low CSAT', -40, 40, 'points'),
  F('upsell.slaBreach', 'Upsell: experience so far', 'Tickets past SLA', -40, 40, 'points'),
  F('upsell.openManyCount', 'Upsell: experience so far', 'Many open tickets: from', 1, 50, 'count'),
  F('upsell.openMany', 'Upsell: experience so far', 'Points for many open tickets', -40, 40, 'points'),
  F('upsell.reopened', 'Upsell: experience so far', 'Reopened tickets', -40, 40, 'points'),
  F('upsell.allClosed', 'Upsell: experience so far', 'All recent tickets closed', -40, 40, 'points'),

  F('upsell.launchFirstHalf', 'Upsell: launches and growth plans', 'New launch, first half of the window', -40, 40, 'points'),
  F('upsell.launchSecondHalf', 'Upsell: launches and growth plans', 'New launch, second half', -40, 40, 'points'),
  F('upsell.signalFit', 'Upsell: launches and growth plans', 'Growth plan that fits the module', -40, 40, 'points'),
  F('upsell.signalGeneral', 'Upsell: launches and growth plans', 'Any other growth plan', -40, 40, 'points'),
  F('upsell.signalCap', 'Upsell: launches and growth plans', 'Growth plans: most points in all', 0, 100, 'points'),
  F('upsell.signalDays', 'Upsell: launches and growth plans', 'A growth plan counts for', 1, 730, 'days'),

  F('upsell.hot', 'Upsell: bands', 'Hot from', 1, 100, 'points'),
  F('upsell.warm', 'Upsell: bands', 'Warm from', 1, 100, 'points'),
  F('upsell.cool', 'Upsell: bands', 'Show opportunities from', 0, 100, 'points'),
];

const KEY = /^[A-Z][A-Z0-9_]{1,29}$/;
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
const set = (o: Record<string, unknown>, path: string, v: unknown) => {
  const parts = path.split('.');
  let cur = o;
  for (const k of parts.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[parts.at(-1)!] = v;
};

/** Overlays saved values on the defaults, so a newly added setting always has a value. */
export function mergeScoring(saved: unknown, base: ScoringConfig = DEFAULT_SCORING): ScoringConfig {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  const s = (saved ?? {}) as Record<string, unknown>;
  for (const f of SCORING_FIELDS) { const v = get(s, f.path); if (typeof v === 'number' && Number.isFinite(v)) set(out, f.path, v); }
  const h = get(s, 'holds') as Record<string, unknown> | undefined;
  for (const k of Object.keys(DEFAULT_SCORING.holds)) if (typeof h?.[k] === 'boolean') (out.holds as Record<string, unknown>)[k] = h[k];
  if (s.related && typeof s.related === 'object') out.related = s.related;
  if (s.signalAffinity && typeof s.signalAffinity === 'object') out.signalAffinity = { ...(out.signalAffinity as object), ...(s.signalAffinity as object) };
  return out as unknown as ScoringConfig;
}

/** Checks a whole settings document. Returns every problem in plain words, not just the first. */
export function validateScoring(input: unknown, base: ScoringConfig = DEFAULT_SCORING): { ok: true; config: ScoringConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['Send the settings as an object'] };
  for (const f of SCORING_FIELDS) {
    const v = get(input, f.path);
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) errors.push(`${f.label}: use a whole number`);
    else if (v < f.min || v > f.max) errors.push(`${f.label}: use a number from ${f.min} to ${f.max}`);
  }
  const h = (input as ScoringConfig).holds as unknown;
  if (h !== undefined) for (const [k, v] of Object.entries(h as object)) if (!(k in DEFAULT_SCORING.holds) || typeof v !== 'boolean') errors.push(`Holds: ${k} must be on or off`);
  const rel = (input as ScoringConfig).related as unknown;
  if (rel !== undefined) {
    if (!rel || typeof rel !== 'object' || Array.isArray(rel)) errors.push('Related modules: send an object keyed by module');
    else for (const [m, list] of Object.entries(rel as Record<string, unknown>)) {
      if (!KEY.test(m)) errors.push(`Related modules: "${m}" is not a module key`);
      if (!Array.isArray(list) || list.length > 6) { errors.push(`Related modules for ${m}: send a list of up to 6`); continue; }
      for (const r of list as Array<{ uses?: unknown; because?: unknown }>) {
        if (typeof r?.uses !== 'string' || !KEY.test(r.uses)) errors.push(`Related modules for ${m}: "${String(r?.uses)}" is not a module key`);
        if (typeof r?.because !== 'string' || r.because.trim().length < 3 || r.because.length > 120) errors.push(`Related modules for ${m}: say why in 3 to 120 characters`);
      }
    }
  }
  const aff = (input as ScoringConfig).signalAffinity as unknown;
  if (aff !== undefined) {
    if (!aff || typeof aff !== 'object' || Array.isArray(aff)) errors.push('Growth plans: send an object keyed by kind');
    else for (const [k, list] of Object.entries(aff as Record<string, unknown>)) {
      if (!(k in DEFAULT_SCORING.signalAffinity)) errors.push(`Growth plans: "${k}" is not a kind`);
      else if (!Array.isArray(list) || list.some((m) => typeof m !== 'string' || !KEY.test(m))) errors.push(`Growth plans for ${k}: send a list of module keys`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const config = mergeScoring(input, base);
  const pairs: Array<[number, number, string]> = [
    [config.bands.adoptionPartialPct, config.bands.adoptionStrongPct, 'Partial adoption must start below strong adoption'],
    [config.churn.medium, config.churn.high, 'Medium churn risk must start below high'],
    [config.upsell.cool, config.upsell.warm, 'Cool must start below warm'],
    [config.upsell.warm, config.upsell.hot, 'Warm must start below hot'],
    [config.partial.show, config.partial.high, 'Showing a module must start below high partial churn'],
    [config.churn.activityDropSmallPct, config.churn.activityDropBigPct, 'A smaller activity drop must be smaller than a big one'],
    [config.upsell.csatLowPct, config.upsell.csatHighPct, 'Low CSAT must be below high CSAT'],
  ];
  for (const [low, high, msg] of pairs) if (low >= high) errors.push(msg);
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
