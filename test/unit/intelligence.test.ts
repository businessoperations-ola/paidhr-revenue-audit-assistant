import { describe, expect, it } from 'vitest';
import {
  adoptionRate, churnRisk, csatPct, npsBand, partialChurn, seasonFor, upsellOpportunities,
  type CatalogModule, type ClientFacts, type ModuleFact, type SeasonWindow, type UpsellContext,
} from '../../src/adoption/intelligence.js';

const S = { npsScale: '0_10' as const, csatMax: 5 };
const mod = (key: string, status: ModuleFact['status'], events30 = 0, eventsPrior30 = 0): ModuleFact => ({ key, label: key, status, events30, eventsPrior30 });
const facts = (over: Partial<ClientFacts> = {}): ClientFacts => ({
  health: 'Healthy', daysToRenewal: 200, nps: null, csat: null, openTickets: 0, closedTickets90: 0, slaBreaches: 0, reopenedTickets: 0,
  activityChangePct: null, engagementPct: null, primaryAdmin: 'active', payroll: 'ok', seatUtilisationPct: 90, urgentAlerts: 0,
  modules: [mod('PAYROLL', 'in_use', 50, 50), mod('CORE_HR', 'in_use', 20, 20), mod('LEAVE', 'in_use', 30, 30)], signals: [], ...over,
});
const CATALOG: CatalogModule[] = ['PAYROLL', 'CORE_HR', 'LEAVE', 'STATUTORY', 'TIME', 'PERFORMANCE', 'LOANS'].map((key) => ({ key, label: key, launchedOn: null, launchNote: null, active: true }));
const WINDOWS: SeasonWindow[] = [
  { module: 'PERFORMANCE', startMonth: 11, endMonth: 12, boost: 20, reason: 'Year-end reviews' },
  { module: 'PERFORMANCE', startMonth: 6, endMonth: 7, boost: 15, reason: 'Mid-year reviews' },
  { module: 'LOANS', startMonth: 12, endMonth: 2, boost: 10, reason: 'Festive season and new year' }, // wraps the year end
];
const ctx = (over: Partial<UpsellContext> = {}): UpsellContext => ({ catalog: CATALOG, windows: [], peerPct: new Map(), today: new Date('2026-03-10T00:00:00Z'), launchDays: 180, lookaheadDays: 60, ...over });
const opps = (f: ClientFacts, c: UpsellContext = ctx()) => upsellOpportunities(f, S, c, churnRisk(f, S));
const find = (list: ReturnType<typeof opps>, key: string) => list.find((o) => o.module === key)!;

describe('reading experience scores', () => {
  it('bands NPS on either scale and normalises CSAT to a percentage', () => {
    expect([10, 9, 8, 7, 6, 0].map((n) => npsBand(n, '0_10'))).toEqual(['promoter', 'promoter', 'passive', 'passive', 'detractor', 'detractor']);
    expect([50, 30, 29, 0, -1, -40].map((n) => npsBand(n, 'minus100_100'))).toEqual(['promoter', 'promoter', 'passive', 'passive', 'detractor', 'detractor']);
    expect(npsBand(null, '0_10')).toBeNull();
    expect(csatPct(4.5, 5)).toBe(90);
    expect(csatPct(82, 100)).toBe(82);
    expect(csatPct(7, 5)).toBe(100);
    expect(csatPct(null, 5)).toBeNull();
  });
});

describe('adoption rate: modules in use against modules bought', () => {
  it('counts what is used out of what was bought, and says nothing when nothing was bought', () => {
    expect(adoptionRate([mod('A', 'in_use'), mod('B', 'in_use'), mod('C', 'unused'), mod('D', 'not_purchased')])).toEqual({ purchased: 3, inUse: 2, unused: 1, ratePct: 67, band: 'partial' });
    expect(adoptionRate([mod('A', 'in_use'), mod('B', 'in_use')])).toMatchObject({ ratePct: 100, band: 'strong' });
    expect(adoptionRate([mod('A', 'unused'), mod('B', 'unused'), mod('C', 'in_use')])).toMatchObject({ ratePct: 33, band: 'weak' });
    expect(adoptionRate([mod('A', 'not_purchased')])).toEqual({ purchased: 0, inUse: 0, unused: 0, ratePct: null, band: null });
  });
});

describe('churn risk', () => {
  it('is low for a healthy, fully adopted account and explains nothing', () => {
    const r = churnRisk(facts({ nps: 9, csat: 4.6 }), S);
    expect(r).toMatchObject({ score: 0, level: 'low', reasons: [] });
  });

  it('adds up adoption, admin, activity, experience and commercial signals, each with a reason', () => {
    const r = churnRisk(facts({
      modules: [mod('PAYROLL', 'in_use', 10, 10), mod('LEAVE', 'unused'), mod('LOANS', 'unused'), mod('EWA', 'unused')],
      primaryAdmin: 'dormant', activityChangePct: -35, nps: 4, csat: 2.5, slaBreaches: 2, health: 'At Risk', payroll: 'late', daysToRenewal: 45,
    }), S);
    const by = Object.fromEntries(r.reasons.map((x) => [x.text, x.points]));
    expect(by['1 of 4 modules bought are in use (25%)']).toBe(23);
    expect(by['Primary admin has not logged in for over 30 days']).toBe(15);
    expect(by['Employee activity down 35% on the month before']).toBe(15);
    expect(by['NPS is 4 (a detractor)']).toBe(15);
    expect(by['CSAT is 50%']).toBe(10);
    expect(by['2 support tickets are past their SLA']).toBe(12);
    expect(by['HubSpot health is At Risk']).toBe(12);
    expect(by['Payroll is late']).toBe(6);
    expect(by['Renewal is in 45 days, with these risks open']).toBe(10);
    expect(r.score).toBe(100); // capped
    expect(r.level).toBe('high');
    expect(r.reasons[0]!.points).toBeGreaterThanOrEqual(r.reasons.at(-1)!.points); // biggest first
  });

  it('does not add a renewal penalty when the account is otherwise fine', () => {
    expect(churnRisk(facts({ daysToRenewal: 30 }), S).reasons).toEqual([]);
    expect(churnRisk(facts({ daysToRenewal: 30, primaryAdmin: 'never', health: 'At Risk' }), S).reasons.some((x) => x.text.startsWith('Renewal'))).toBe(true);
  });

  it('bands medium between 35 and 59', () => {
    const r = churnRisk(facts({ primaryAdmin: 'never', health: 'At Risk', activityChangePct: -20 }), S);
    expect(r.score).toBe(20 + 12 + 8);
    expect(r.level).toBe('medium');
  });
});

describe('partial churn: modules likely to be dropped', () => {
  it('flags bought-but-unused modules, and raises them when the customer is unhappy or renewing soon', () => {
    const quiet = partialChurn(facts({ modules: [mod('PAYROLL', 'in_use', 40, 40), mod('LOANS', 'unused')] }), S);
    expect(quiet).toMatchObject({ level: 'high', modules: [{ module: 'LOANS', risk: 'high', score: 60 }] });
    const soon = partialChurn(facts({ daysToRenewal: 90, nps: 3, modules: [mod('LOANS', 'unused')] }), S);
    expect(soon.modules[0]).toMatchObject({ score: 85 });
    expect(soon.modules[0]!.reasons.map((r) => r.text)).toEqual(['Bought but not used in the last 30 days', 'The customer is a detractor', 'Renewal is in 90 days, when modules get dropped']);
  });

  it('flags fading use, but only from a real base, and leaves healthy modules alone', () => {
    const r = partialChurn(facts({ daysToRenewal: 400, modules: [mod('LEAVE', 'in_use', 20, 60), mod('CORE_HR', 'in_use', 3, 10), mod('PAYROLL', 'in_use', 55, 60)] }), S);
    expect(r.modules.map((m) => [m.module, m.risk, m.score])).toEqual([['LEAVE', 'medium', 35]]);
    expect(r.modules[0]!.reasons[0]!.text).toBe('Use fell 67% on the month before');
    expect(partialChurn(facts(), S)).toEqual({ level: 'none', modules: [] });
  });
});

describe('seasonality', () => {
  it('gives the full boost inside a window and half in the weeks before one opens', () => {
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-11-15T00:00:00Z'), 60)).toMatchObject({ points: 20, state: 'open', text: 'Year-end reviews (Nov to Dec)' });
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-10-05T00:00:00Z'), 60)).toMatchObject({ points: 10, state: 'opening' });
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-10-05T00:00:00Z'), 60).when).toBe('Start the conversation now: the season opens in 27 days');
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-08-20T00:00:00Z'), 60)).toMatchObject({ points: 0, state: 'closed' });
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-08-20T00:00:00Z'), 60).when).toMatch(/^Next buying season: Nov to Dec/);
  });

  it('handles a window that wraps the year end, and a module with no seasons', () => {
    for (const d of ['2026-12-20', '2027-01-15', '2027-02-28']) expect(seasonFor('LOANS', WINDOWS, new Date(`${d}T00:00:00Z`), 60).state).toBe('open');
    expect(seasonFor('LOANS', WINDOWS, new Date('2026-06-01T00:00:00Z'), 60).state).toBe('closed');
    expect(seasonFor('PAYROLL', WINDOWS, new Date('2026-11-15T00:00:00Z'), 60)).toMatchObject({ points: 0, when: null });
  });

  it('picks the stronger of two windows, and a lookahead of 0 turns early warning off', () => {
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-06-10T00:00:00Z'), 60).points).toBe(15);
    expect(seasonFor('PERFORMANCE', WINDOWS, new Date('2026-10-05T00:00:00Z'), 0).state).toBe('closed');
  });
});

describe('upsell scoring: six data points, each explained', () => {
  it('lists only modules not bought, and nothing for a customer with no module data', () => {
    expect(opps(facts()).map((o) => o.module).sort()).toEqual(['LOANS', 'PERFORMANCE', 'STATUTORY', 'TIME']);
    expect(opps(facts({ modules: [mod('PAYROLL', 'not_purchased')] }))).toEqual([]);
  });

  it('1+2 uses what they bought and what they use: adjacent modules and a strong adoption rate score, idle modules count against', () => {
    const good = find(opps(facts(), ctx({ peerPct: new Map([['STATUTORY', 70]]) })), 'STATUTORY');
    const texts = good.reasons.map((r) => r.text);
    expect(texts).toContain('70% of customers have it');
    expect(texts).toContain('Uses PAYROLL and runs payroll but does remittance by hand');
    expect(texts).toContain('Uses 3 of 3 modules bought (100%)');
    expect(good.score).toBe(14 + 8 + 12);
    const idle = find(opps(facts({ modules: [mod('PAYROLL', 'in_use', 40, 40), mod('LEAVE', 'unused'), mod('CORE_HR', 'unused')] }), ctx({ peerPct: new Map([['STATUTORY', 70]]) })), 'STATUTORY');
    expect(idle.reasons.map((r) => r.text)).toContain('Uses only 1 of 3 modules bought: fix adoption first');
    expect(idle.score).toBeLessThan(good.score - 20);
  });

  it('3 reads the experience so far: NPS, CSAT, open and closed tickets', () => {
    const base = find(opps(facts()), 'TIME').score;
    const happy = find(opps(facts({ nps: 10, csat: 4.8, closedTickets90: 4 })), 'TIME');
    expect(happy.score - base).toBe(14 + 8 + 3);
    expect(happy.reasons.map((r) => r.text)).toEqual(expect.arrayContaining(['NPS is 10 (a promoter)', 'CSAT is 96%', 'All 4 recent tickets are closed']));
    const sad = find(opps(facts({ nps: 5, csat: 2.4, slaBreaches: 1, reopenedTickets: 1 })), 'TIME');
    expect(sad.score).toBe(Math.max(0, base - 18 - 12 - 12 - 5));
    expect(find(opps(facts({ openTickets: 3 })), 'TIME').score).toBe(base - 8);
  });

  it('4 adds the time of year, and says when to ask', () => {
    const nov = ctx({ windows: WINDOWS, today: new Date('2026-11-10T00:00:00Z') });
    const off = ctx({ windows: WINDOWS, today: new Date('2026-03-10T00:00:00Z') });
    expect(find(opps(facts(), nov), 'PERFORMANCE').score - find(opps(facts(), off), 'PERFORMANCE').score).toBe(20);
    expect(find(opps(facts(), nov), 'PERFORMANCE').when).toBe('Buying season is open now (Nov to Dec)');
    expect(find(opps(facts(), nov), 'PERFORMANCE').reasons.map((r) => r.text)).toContain('Year-end reviews (Nov to Dec)');
  });

  it('5 lifts a module in the months after it launches, then lets it go', () => {
    const launched = (on: string | null): CatalogModule[] => CATALOG.map((m) => (m.key === 'PERFORMANCE' ? { ...m, launchedOn: on, launchNote: 'with 360 feedback' } : m));
    const fresh = find(opps(facts(), ctx({ catalog: launched('2026-02-20') })), 'PERFORMANCE');
    expect(fresh.isNewLaunch).toBe(true);
    expect(fresh.reasons.map((r) => r.text)).toContain('New module, launched 18 days ago: with 360 feedback');
    const base = find(opps(facts(), ctx({ catalog: launched(null) })), 'PERFORMANCE').score;
    expect(fresh.score - base).toBe(12);
    expect(find(opps(facts(), ctx({ catalog: launched('2025-11-10') })), 'PERFORMANCE').score - base).toBe(8); // 120 days: the boost has halved
    expect(find(opps(facts(), ctx({ catalog: launched('2025-12-20') })), 'PERFORMANCE').score - base).toBe(12); // 80 days: still in the first half
    expect(find(opps(facts(), ctx({ catalog: launched('2025-08-01') })), 'PERFORMANCE').isNewLaunch).toBe(false); // 221 days: no longer new
    expect(find(opps(facts(), ctx({ catalog: launched('2026-09-01') })), 'PERFORMANCE').isNewLaunch).toBe(false); // not launched yet
  });

  it('6 uses what we know of their plans: signals that fit the module count most, any signal counts a little, old ones expire', () => {
    const sig = (kind: 'FUNDRAISE' | 'EXPANSION', happenedOn = '2026-02-01') => ({ kind, detail: kind === 'FUNDRAISE' ? 'Series A closed' : 'Opening a Kano office', happenedOn });
    const base = find(opps(facts()), 'PERFORMANCE').score;
    const raised = find(opps(facts({ signals: [sig('FUNDRAISE')] })), 'PERFORMANCE');
    expect(raised.score - base).toBe(15);
    expect(raised.reasons.map((r) => r.text)).toContain('Fund raise: Series A closed');
    expect(find(opps(facts({ signals: [sig('EXPANSION')] })), 'PERFORMANCE').score - base).toBe(4); // not what expansion points to
    expect(find(opps(facts({ signals: [sig('EXPANSION')] })), 'TIME').reasons.map((r) => r.points)).toContain(15);
    expect(find(opps(facts({ signals: [sig('FUNDRAISE', '2025-06-01')] })), 'PERFORMANCE').score).toBe(base); // expired
    expect(find(opps(facts({ signals: [sig('FUNDRAISE'), sig('FUNDRAISE'), sig('FUNDRAISE')] })), 'PERFORMANCE').score - base).toBe(15); // 15 + 4 + 4 is capped at 25? fund raise fits so 15, then 15 would pass 25
  });

  it('puts it all together, bands it, and holds back accounts that are not ready', () => {
    const f = facts({ nps: 10, csat: 4.7, engagementPct: 55, signals: [{ kind: 'FUNDRAISE', detail: 'Series A', happenedOn: '2026-11-01' }] });
    const c = ctx({ windows: WINDOWS, today: new Date('2026-11-10T00:00:00Z'), peerPct: new Map([['PERFORMANCE', 60]]), catalog: CATALOG.map((m) => (m.key === 'PERFORMANCE' ? { ...m, launchedOn: '2026-10-01' } : m)) });
    const top = opps(f, c)[0]!;
    expect(top).toMatchObject({ module: 'PERFORMANCE', band: 'hot', isNewLaunch: true, holds: [] });
    expect(top.score).toBeGreaterThanOrEqual(60);
    expect(top.reasons.reduce((n, r) => n + r.points, 0)).toBeGreaterThanOrEqual(top.score);
    // the same account, but in trouble
    const troubled = opps({ ...f, health: 'At Risk', urgentAlerts: 2, primaryAdmin: 'never', nps: 3 }, c)[0]!;
    expect(troubled.holds).toEqual(['HubSpot health is At Risk', 'Urgent or high alerts are open', 'The customer is a detractor']);
    const leaving = opps({ ...f, primaryAdmin: 'never', health: 'At Risk', nps: 2, activityChangePct: -40, slaBreaches: 3, modules: [mod('PAYROLL', 'in_use', 5, 40), mod('LEAVE', 'unused'), mod('CORE_HR', 'unused')] }, c)[0]!;
    expect(leaving.holds[0]).toBe('Churn risk is high: save the account before selling');
  });

  it('never goes outside 0 to 100, and skips modules switched off', () => {
    const all = opps(facts({ nps: 0, csat: 1, slaBreaches: 3, reopenedTickets: 2 }));
    for (const o of all) expect(o.score).toBeGreaterThanOrEqual(0);
    const huge = opps(facts({ nps: 10, csat: 5, closedTickets90: 3, signals: [{ kind: 'FUNDRAISE', detail: 'x1', happenedOn: '2026-03-01' }] }), ctx({ peerPct: new Map([['PERFORMANCE', 100]]), windows: [{ module: 'PERFORMANCE', startMonth: 1, endMonth: 12, boost: 30, reason: 'Always' }], catalog: CATALOG.map((m) => (m.key === 'PERFORMANCE' ? { ...m, launchedOn: '2026-03-01' } : m)) }));
    expect(find(huge, 'PERFORMANCE').score).toBe(100);
    expect(opps(facts(), ctx({ catalog: CATALOG.map((m) => ({ ...m, active: m.key !== 'TIME' })) })).map((o) => o.module)).not.toContain('TIME');
  });
});
