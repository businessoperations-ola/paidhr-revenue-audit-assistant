import { describe, expect, it } from 'vitest';
import { churnRisk, partialChurn, upsellOpportunities, adoptionRate, type CatalogModule, type ClientFacts, type ModuleFact, type UpsellContext } from '../../src/adoption/intelligence.js';
import { DEFAULT_SCORING, mergeScoring, SCORING_FIELDS, validateScoring } from '../../src/adoption/scoring-config.js';
import { describeScoring } from '../../src/adoption/scoring-notes.js';

const S = { npsScale: '0_10' as const, csatMax: 5 };
const mod = (key: string, status: ModuleFact['status'], events30 = 0, eventsPrior30 = 0): ModuleFact => ({ key, label: key, status, events30, eventsPrior30 });
const facts = (over: Partial<ClientFacts> = {}): ClientFacts => ({
  health: 'Healthy', daysToRenewal: 300, nps: 9, csat: 4.5, openTickets: 0, closedTickets90: 0, slaBreaches: 0, reopenedTickets: 0, activityChangePct: null, engagementPct: null,
  primaryAdmin: 'active', payroll: 'ok', seatUtilisationPct: 90, urgentAlerts: 0, modules: [mod('PAYROLL', 'in_use', 50, 50), mod('LEAVE', 'unused')], signals: [], ...over,
});
const CATALOG: CatalogModule[] = ['PAYROLL', 'LEAVE', 'STATUTORY', 'TIME'].map((key) => ({ key, label: key, launchedOn: null, launchNote: null, active: true }));
const ctx = (): UpsellContext => ({ catalog: CATALOG, windows: [], peerPct: new Map([['STATUTORY', 50]]), today: new Date('2026-03-10T00:00:00Z'), launchDays: 180, lookaheadDays: 60 });
const withCfg = (patch: (c: typeof DEFAULT_SCORING) => void) => { const c = structuredClone(DEFAULT_SCORING); patch(c); return c; };
const score = (f: ClientFacts, module: string, cfg = DEFAULT_SCORING) => upsellOpportunities(f, S, ctx(), churnRisk(f, S, cfg), cfg).find((o) => o.module === module)!;

describe('the settings document', () => {
  it('has a range for every number, and every default sits inside its range', () => {
    for (const f of SCORING_FIELDS) {
      const v = f.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], DEFAULT_SCORING);
      expect(typeof v, f.path).toBe('number');
      expect(v as number, f.path).toBeGreaterThanOrEqual(f.min);
      expect(v as number, f.path).toBeLessThanOrEqual(f.max);
    }
    expect(validateScoring(DEFAULT_SCORING).ok).toBe(true);
  });

  it('overlays what was saved on the defaults, so a setting added later still has a value', () => {
    const merged = mergeScoring({ churn: { high: 70 }, holds: { atRisk: false }, upsell: { hot: 75 } });
    expect(merged.churn.high).toBe(70);
    expect(merged.churn.medium).toBe(DEFAULT_SCORING.churn.medium);
    expect(merged.holds).toEqual({ churnHigh: true, atRisk: false, urgentAlerts: true, detractor: true });
    expect(merged.upsell.hot).toBe(75);
    expect(merged.related.STATUTORY).toEqual(DEFAULT_SCORING.related.STATUTORY);
    expect(mergeScoring(null)).toEqual(DEFAULT_SCORING);
  });

  it('reports every problem in plain words', () => {
    const r = validateScoring({ churn: { high: 500, medium: 'a lot' }, bands: { adoptionStrongPct: 40, adoptionPartialPct: 60 }, holds: { atRisk: 'yes' }, related: { 'bad key': [], EWA: [{ uses: 'PAYROLL', because: 'x' }] }, signalAffinity: { GOSSIP: [] } });
    expect(r.ok).toBe(false);
    const errors = (r as { errors: string[] }).errors.join(' | ');
    expect(errors).toMatch(/High risk from: use a number from 1 to 100/);
    expect(errors).toMatch(/Medium risk from: use a whole number/);
    expect(errors).toMatch(/Holds: atRisk must be on or off/);
    expect(errors).toMatch(/"bad key" is not a module key/);
    expect(errors).toMatch(/say why in 3 to 120 characters/);
    expect(errors).toMatch(/"GOSSIP" is not a kind/);
    const order = validateScoring({ bands: { adoptionStrongPct: 40, adoptionPartialPct: 60 }, churn: { medium: 70, high: 60 }, upsell: { cool: 50, warm: 40, hot: 30 } }) as { errors: string[] };
    expect(order.errors).toEqual(expect.arrayContaining(['Partial adoption must start below strong adoption', 'Medium churn risk must start below high', 'Warm must start below hot', 'Cool must start below warm']));
  });

  it('explains the scoring in words built from the live numbers', () => {
    const notes = describeScoring(withCfg((c) => { c.churn.high = 70; c.upsell.npsPromoter = 20; c.holds.atRisk = false; }));
    expect(notes.churn.at(-1)).toBe('High is 70 or more, medium 35 or more');
    expect(notes.upsell.join(' ')).toMatch(/NPS promoter 20/);
    expect(notes.upsell.at(-1)).toMatch(/Held, not pushed: high churn risk, urgent alerts, a detractor score/);
    expect(notes.adoption).toMatch(/Strong is 80% or more/);
  });
});

describe('changing the settings changes the scores', () => {
  it('adoption bands', () => {
    const mods = [mod('A', 'in_use'), mod('B', 'in_use'), mod('C', 'unused')];
    expect(adoptionRate(mods).band).toBe('partial'); // 67%
    expect(adoptionRate(mods, withCfg((c) => { c.bands.adoptionStrongPct = 60; })).band).toBe('strong');
    expect(adoptionRate(mods, withCfg((c) => { c.bands.adoptionPartialPct = 70; c.bands.adoptionStrongPct = 90; })).band).toBe('weak');
  });

  it('churn weights and levels', () => {
    const f = facts({ primaryAdmin: 'never', health: 'At Risk' });
    const base = churnRisk(f, S);
    expect(base.score).toBe(15 + 20 + 12); // 1 of 2 modules in use is 50%: 15 points
    expect(churnRisk(f, S, withCfg((c) => { c.churn.adminNever = 40; })).score).toBe(base.score + 20);
    expect(churnRisk(f, S, withCfg((c) => { c.churn.adoptionMax = 0; })).score).toBe(base.score - 15);
    expect(base.level).toBe('medium');
    expect(churnRisk(f, S, withCfg((c) => { c.churn.high = 45; })).level).toBe('high');
    expect(churnRisk(f, S, withCfg((c) => { c.churn.medium = 60; c.churn.high = 80; })).level).toBe('low');
  });

  it('partial churn weights', () => {
    const f = facts({ modules: [mod('LEAVE', 'unused')] });
    expect(partialChurn(f, S).modules[0]!.score).toBe(60);
    expect(partialChurn(f, S, withCfg((c) => { c.partial.unused = 30; })).modules).toEqual([]); // 30 is under the 35 shown
    expect(partialChurn(f, S, withCfg((c) => { c.partial.unused = 30; c.partial.show = 20; })).modules[0]!.risk).toBe('medium');
    const fading = facts({ modules: [mod('LEAVE', 'in_use', 40, 60)] });
    expect(partialChurn(fading, S).modules).toEqual([]); // down 33%, under the 40% bar
    expect(partialChurn(fading, S, withCfg((c) => { c.partial.declinePct = 30; })).modules[0]!.score).toBe(35);
  });

  it('upsell weights, bands and the things that hold an account back', () => {
    const f = facts({ modules: [mod('PAYROLL', 'in_use', 50, 50), mod('LEAVE', 'in_use', 10, 10)] });
    const base = score(f, 'STATUTORY');
    expect(base.reasons.find((r) => r.text === 'NPS is 9 (a promoter)')!.points).toBe(14);
    expect(score(f, 'STATUTORY', withCfg((c) => { c.upsell.npsPromoter = 30; })).score - base.score).toBe(16);
    expect(score(f, 'STATUTORY', withCfg((c) => { c.upsell.peerFactorPct = 0; })).score).toBe(base.score - 10);
    expect(score(f, 'STATUTORY', withCfg((c) => { c.upsell.adjacent = 0; })).score).toBe(base.score - 8);
    expect(base.band).toBe(base.score >= 60 ? 'hot' : base.score >= 40 ? 'warm' : 'cool');
    expect(score(f, 'STATUTORY', withCfg((c) => { c.upsell.hot = 40; c.upsell.warm = 30; c.upsell.cool = 10; })).band).toBe('hot');
    // holds can be switched off
    const troubled = facts({ health: 'At Risk', urgentAlerts: 2, nps: 3, modules: f.modules });
    expect(score(troubled, 'STATUTORY').holds).toEqual(['HubSpot health is At Risk', 'Urgent or high alerts are open', 'The customer is a detractor']);
    expect(score(troubled, 'STATUTORY', withCfg((c) => { c.holds.atRisk = false; c.holds.urgentAlerts = false; })).holds).toEqual(['The customer is a detractor']);
    expect(score(troubled, 'STATUTORY', withCfg((c) => { c.holds = { churnHigh: false, atRisk: false, urgentAlerts: false, detractor: false }; })).holds).toEqual([]);
  });

  it('related modules and growth-plan affinities are editable', () => {
    const f = facts({ modules: [mod('PAYROLL', 'in_use', 50, 50)], signals: [{ kind: 'EXPANSION', detail: 'New depot', happenedOn: '2026-03-01' }] });
    expect(score(f, 'TIME').reasons.some((r) => r.text.startsWith('Uses LEAVE'))).toBe(false);
    const rel = score(f, 'TIME', withCfg((c) => { c.related.TIME = [{ uses: 'PAYROLL', because: 'pays shift workers' }]; }));
    expect(rel.reasons.map((r) => r.text)).toContain('Uses PAYROLL and pays shift workers');
    expect(score(f, 'STATUTORY', withCfg((c) => { c.signalAffinity.EXPANSION = ['TIME']; })).reasons.find((r) => r.text.startsWith('Expansion'))!.points).toBe(4);
    expect(score(f, 'TIME', withCfg((c) => { c.signalAffinity.EXPANSION = ['TIME']; })).reasons.find((r) => r.text.startsWith('Expansion'))!.points).toBe(15);
  });
});
