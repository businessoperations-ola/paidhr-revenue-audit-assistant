import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { Outbox, World, apiApp, resetDatabase, testConfig } from './harness.js';

const DAY = '2026-03-10'; // outside every buying season, so seasonality starts at zero
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const NGOZI = 'ngozi.okafor@example.com';
const TUNDE = 'tunde.bello@example.com';

describe('adoption rate, churn and upsell', () => {
  let app: INestApplication;
  let db: Database;
  let world: World;
  const as = (email: string, viewAs?: string) => ({ authorization: `Bearer ${email}`, ...(viewAs ? { 'x-view-as': viewAs } : {}) });
  const http = () => request(app.getHttpServer());
  const get = async (path: string, who = 'director@example.com') => (await http().get(`${path}${path.includes('?') ? '&' : '?'}date=${DAY}`).set(as(who)).expect(200)).body;
  const opp = (client: { opportunities: Array<{ module: string }> }, module: string) => client.opportunities.find((o) => o.module === module) as unknown as { score: number; band: string; holds: string[]; reasons: Array<{ points: number; text: string }>; isNewLaunch: boolean; when: string | null };

  async function start() {
    await resetDatabase();
    world = new World();
    world.now = new Date(`${DAY}T12:00:00Z`);
    app = await apiApp(testConfig({ ALERTS_DRY_RUN: 'true' }), world, new Outbox());
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'), ('lead@example.com', 'cs_team_lead'), ('${NGOZI}', 'csm'), ('${TUNDE}', 'csm'), ('support@example.com', 'support_specialist')`);
    await db.query(`UPDATE app_user SET manager_email = 'lead@example.com' WHERE role = 'csm'`);
    await app.get(JobRunner).run('daily', DAY);
  }

  beforeEach(start);
  afterEach(async () => {
    await app?.close();
  });

  it('shows every CSM the adoption rate: modules in use against modules bought', async () => {
    const o = await get('/adoption');
    expect(o.portfolio).toMatchObject({ clients: 6, withModuleData: 4, modulesBought: 16, modulesInUse: 12, adoptionRatePct: 75 });
    expect(o.portfolio.bands).toEqual({ strong: 2, partial: 1, weak: 1, unknown: 2 });
    expect(o.portfolio.adoptionRateArrWeightedPct).toBeGreaterThan(0);
    const by = Object.fromEntries(o.clients.map((c: { name: string }) => [c.name, c]));
    expect(by['Adebayo Logistics'].adoption).toEqual({ purchased: 4, inUse: 4, unused: 0, ratePct: 100, band: 'strong' });
    expect(by['Kano Holdings Group'].adoption).toMatchObject({ purchased: 6, inUse: 5, unused: 1, ratePct: 83 });
    expect(by['Abuja Tech Hub'].adoption).toMatchObject({ ratePct: 0, band: 'weak' }); // bought payroll and HR, uses neither
    expect(by['Ibadan Clinics'].adoption.ratePct).toBeNull(); // no module data: not counted as zero
    // purchase against use, module by module
    const m = Object.fromEntries(o.matrix.map((r: { key: string }) => [r.key, r]));
    expect(m.PAYROLL).toMatchObject({ purchased: 4, inUse: 3, unusedClients: ['Abuja Tech Hub'] });
    expect(m.LOANS).toMatchObject({ purchased: 1, inUse: 0 });
    expect(m.PERFORMANCE).toMatchObject({ purchased: 0 });
    // and a CSM sees the rate for their own portfolio only
    const mine = await get('/adoption', NGOZI);
    expect(mine.portfolio).toMatchObject({ clients: 2, modulesBought: 8, modulesInUse: 7, adoptionRatePct: 88 });
  });

  it('turns adoption into churn and partial churn risk, with the reasons', async () => {
    const o = await get('/adoption');
    const by = Object.fromEntries(o.clients.map((c: { name: string }) => [c.name, c]));
    expect(by['Adebayo Logistics'].churn).toMatchObject({ score: 0, level: 'low' });
    expect(by['Lekki Foods'].churn.level).toBe('high'); // dormant admin, detractor-range NPS, late payroll, tickets past SLA
    const why = by['Lekki Foods'].churn.reasons.map((r: { text: string }) => r.text);
    expect(why).toEqual(expect.arrayContaining(['Primary admin has not logged in for over 30 days', 'NPS is 6 (a detractor)', 'A support ticket is past its SLA', '3 of 4 modules bought are in use (75%)']));
    expect(by['Abuja Tech Hub'].churn.reasons.map((r: { text: string }) => r.text)).toContain('0 of 2 modules bought are in use (0%)');
    // partial churn: the module they may drop even though they stay
    expect(by['Kano Holdings Group'].churn.level).toBe('low');
    expect(by['Kano Holdings Group'].partial.level).toBe('high'); // bought Loans, nobody uses it
    expect(by['Kano Holdings Group'].partial.modules).toEqual([{ module: 'LOANS', label: 'Loans', risk: 'high', reasons: ['Bought but not used in the last 30 days', 'Support tickets are past their SLA'] }]);
    expect(by['Abuja Tech Hub'].partial.modules.map((x: { module: string }) => x.module).sort()).toEqual(['CORE_HR', 'PAYROLL']);
    expect(o.portfolio.churn).toMatchObject({ high: 1, medium: 2, low: 3 });
    expect(o.portfolio.partialChurn.clients).toBe(3);
    // the ARR at risk is exact kobo, as text
    expect(typeof o.portfolio.churn.highArrKobo).toBe('string');
  });

  it('scores upsell from the six data points, and explains each one', async () => {
    const adebayo = await get('/adoption/clients/1001');
    const stat = opp(adebayo, 'STATUTORY');
    const text = stat.reasons.map((r) => r.text);
    expect(text).toEqual(expect.arrayContaining([
      expect.stringMatching(/% of customers have it/), // 1 purchased (peers)
      'Uses Payroll and runs payroll but does remittance by hand', // 1 purchased (adjacent)
      'Uses 4 of 4 modules bought (100%)', // 2 in use
      'NPS is 9 (a promoter)', 'CSAT is 92%', // 3 experience
    ]));
    expect(stat.band).not.toBe('cool');
    expect(stat.holds).toEqual([]);
    // 3 experience: a poor experience takes points off the same module
    const lekki = await get('/adoption/clients/1002');
    expect(opp(lekki, 'TIME').reasons.map((r) => r.text)).toEqual(expect.arrayContaining(['NPS is 6 (a detractor)', '1 support ticket is past SLA', 'Uses 3 of 4 modules bought (75%)']));
    expect(opp(lekki, 'TIME').holds.length).toBeGreaterThan(0);
  });

  it('4 seasonality: the same client scores higher in a buying season, and is told when to ask', async () => {
    const off = opp(await get('/adoption/clients/1001'), 'PERFORMANCE');
    expect(off.reasons.map((r) => r.text).some((t) => /performance reviews/i.test(t))).toBe(false);
    expect(off.when).toMatch(/^Next buying season: Jun to Jul|^Start the conversation now: the season opens/);
    // a snapshot taken in November lands inside the year-end review window
    world.now = new Date('2026-11-10T12:00:00Z');
    await app.get(JobRunner).run('ingest', '2026-11-10');
    const nov = async () => opp((await http().get('/adoption/clients/1001?date=2026-11-10').set(as('director@example.com')).expect(200)).body, 'PERFORMANCE');
    const inSeason = await nov();
    expect(inSeason.reasons).toContainEqual({ points: 20, text: 'Year-end performance reviews (Nov to Dec)' });
    expect(inSeason.when).toBe('Buying season is open now (Nov to Dec)');
    // everything else the same, take the seasons away: exactly the boost goes
    const original = (await http().get('/adoption/catalog').set(as('director@example.com'))).body.windows.filter((w: { module: string }) => w.module === 'PERFORMANCE');
    await http().put('/adoption/catalog/seasonality/PERFORMANCE').set(as('director@example.com')).send({ windows: [] }).expect(200);
    expect(inSeason.score - (await nov()).score).toBe(20);
    expect(original).toHaveLength(2);
  });

  it('5 new module launches: set a launch date and every customer that has not bought it sees it', async () => {
    expect(opp(await get('/adoption/clients/1001'), 'PERFORMANCE').isNewLaunch).toBe(false);
    const before = opp(await get('/adoption/clients/1001'), 'PERFORMANCE').score;
    await http().put('/adoption/catalog/modules/PERFORMANCE').set(as('director@example.com')).send({ launchedOn: '2026-02-20', launchNote: 'with 360 feedback' }).expect(200);
    const after = opp(await get('/adoption/clients/1001'), 'PERFORMANCE');
    expect(after.isNewLaunch).toBe(true);
    expect(after.score - before).toBe(12);
    expect(after.reasons.map((r) => r.text)).toContain('New module, launched 18 days ago: with 360 feedback');
    const o = await get('/adoption');
    expect(o.newLaunches).toEqual([{ key: 'PERFORMANCE', label: 'Performance management', launchedOn: '2026-02-20', note: 'with 360 feedback' }]);
    expect(o.opportunities.filter((x: { module: string; isNewLaunch: boolean }) => x.module === 'PERFORMANCE' && x.isNewLaunch).length).toBeGreaterThan(0);
  });

  it('6 growth plans: a CSM records a fund raise or expansion, and it lifts the modules it points to', async () => {
    const before = opp(await get('/adoption/clients/1001', NGOZI), 'PERFORMANCE').score;
    const made = await http().post('/adoption/signals').set(as(NGOZI)).send({ hubspotId: '1001', kind: 'FUNDRAISE', detail: 'Closed a Series A', happenedOn: daysAgoIso(10) }).expect(201);
    expect(made.body).toMatchObject({ kind: 'FUNDRAISE', addedBy: NGOZI, validUntil: new Date(Date.now() + 170 * 86_400_000).toISOString().slice(0, 10) });
    const after = opp(await get('/adoption/clients/1001', NGOZI), 'PERFORMANCE');
    expect(after.score - before).toBe(15);
    expect(after.reasons.map((r) => r.text)).toContain('Fund raise: Closed a Series A');
    const expansion = await http().post('/adoption/signals').set(as(NGOZI)).send({ hubspotId: '1001', kind: 'EXPANSION', detail: 'Opening a Port Harcourt depot', happenedOn: daysAgoIso(8) }).expect(201);
    expect(opp(await get('/adoption/clients/1001', NGOZI), 'TIME').reasons.map((r) => r.text)).toContain('Expansion plans: Opening a Port Harcourt depot');
    // listing, scope and removal
    const list = (await http().get('/adoption/signals').set(as(NGOZI)).expect(200)).body;
    expect(list.signals.map((s: { client: string }) => s.client)).toEqual(['Adebayo Logistics', 'Adebayo Logistics']);
    expect(list.clients.map((c: { hubspotId: string }) => c.hubspotId).sort()).toEqual(['1001', '1002']);
    await http().post('/adoption/signals').set(as(NGOZI)).send({ hubspotId: '1003', kind: 'FUNDRAISE', detail: 'Not my client', happenedOn: daysAgoIso(10) }).expect(404);
    await http().delete(`/adoption/signals/${expansion.body.id}`).set(as(TUNDE)).expect(404); // not Tunde's client
    await http().delete(`/adoption/signals/${expansion.body.id}`).set(as('lead@example.com')).expect(403); // the lead did not add it, and is not Head of CX
    await http().delete(`/adoption/signals/${expansion.body.id}`).set(as(NGOZI)).expect(200);
    await http().delete(`/adoption/signals/${made.body.id}`).set(as('director@example.com')).expect(200); // Head of CX can remove any
    expect((await http().get('/adoption/signals').set(as(NGOZI))).body.signals).toEqual([]);
  });

  it('checks what is entered as a growth signal', async () => {
    const bad = (body: object) => http().post('/adoption/signals').set(as(NGOZI)).send({ hubspotId: '1001', kind: 'FUNDRAISE', detail: 'Series A', happenedOn: daysAgoIso(10), ...body });
    await bad({ kind: 'GOSSIP' }).expect(400);
    await bad({ detail: 'x' }).expect(400);
    await bad({ happenedOn: 'last week' }).expect(400);
    const html = (await bad({ detail: 'Raised <script>alert(1)</script> funds' }).expect(201)).body.detail;
    expect(html).not.toContain('<');
    await http().post('/adoption/signals').set(as('support@example.com')).send({ hubspotId: '1001', kind: 'FUNDRAISE', detail: 'Series A', happenedOn: daysAgoIso(10) }).expect(403);
    await http().post('/adoption/signals').set(as('admin@example.com', NGOZI)).send({ hubspotId: '1001', kind: 'FUNDRAISE', detail: 'Series A', happenedOn: daysAgoIso(10) }).expect(403); // view-as is read-only
  });

  it('lets the Head of CX manage modules and buying seasons, and nobody else', async () => {
    const cat = (await http().get('/adoption/catalog').set(as(NGOZI)).expect(200)).body;
    expect(cat.modules.map((m: { key: string }) => m.key)).toContain('PERFORMANCE');
    expect(cat.windows.filter((w: { module: string }) => w.module === 'PERFORMANCE')).toHaveLength(2);
    expect(cat.windowsConfirmed).toBe(false);
    expect(cat.scoring.upsell.length).toBeGreaterThan(5);
    await http().put('/adoption/catalog/modules/PERFORMANCE').set(as(NGOZI)).send({ launchedOn: '2026-02-20' }).expect(403);
    await http().put('/adoption/catalog/seasonality/PERFORMANCE').set(as('lead@example.com')).send({ windows: [] }).expect(403);
    // a new module appears as an upsell option straight away
    await http().post('/adoption/catalog/modules').set(as('director@example.com')).send({ key: 'BENEFITS', label: 'Benefits administration' }).expect(201);
    await http().post('/adoption/catalog/modules').set(as('director@example.com')).send({ key: 'BENEFITS', label: 'x' }).expect(409);
    await http().post('/adoption/catalog/modules').set(as('director@example.com')).send({ key: 'bad key', label: 'x' }).expect(400);
    expect(opp(await get('/adoption/clients/1001'), 'BENEFITS')).toBeTruthy();
    // switching it off removes it
    await http().put('/adoption/catalog/modules/BENEFITS').set(as('director@example.com')).send({ active: false }).expect(200);
    expect((await get('/adoption/clients/1001')).opportunities.map((o: { module: string }) => o.module)).not.toContain('BENEFITS');
    // seasons
    await http().put('/adoption/catalog/seasonality/BENEFITS').set(as('director@example.com')).send({ windows: [{ startMonth: 13, endMonth: 2, boost: 10, reason: 'x' }] }).expect(400);
    const set = await http().put('/adoption/catalog/seasonality/PERFORMANCE').set(as('director@example.com')).send({ windows: [{ startMonth: 3, endMonth: 4, boost: 25, reason: 'Our review cycle' }] }).expect(200);
    expect(set.body).toHaveLength(1);
    const inSeason = opp(await get('/adoption/clients/1001'), 'PERFORMANCE');
    expect(inSeason.reasons).toContainEqual({ points: 25, text: 'Our review cycle (Mar to Apr)' });
    expect((await http().get('/adoption/catalog').set(as(NGOZI))).body.windowsConfirmed).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM action_log WHERE object_type = 'adoption'`)).rows[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it('keeps churn and upsell to each CSM and their team, and puts them in the flat opportunity list', async () => {
    const mine = await get('/adoption', NGOZI);
    expect(mine.clients.map((c: { name: string }) => c.name).sort()).toEqual(['Adebayo Logistics', 'Lekki Foods']);
    expect(new Set(mine.opportunities.map((o: { client: string }) => o.client))).toEqual(new Set(['Adebayo Logistics']));
    expect(mine.opportunities.every((o: { client: string }) => ['Adebayo Logistics', 'Lekki Foods'].includes(o.client))).toBe(true);
    expect(mine.opportunities[0].score).toBeGreaterThanOrEqual(mine.opportunities.at(-1).score); // best first
    expect(mine.opportunities.every((o: { score: number }) => o.score >= 20)).toBe(true);
    await http().get('/adoption/clients/1003').set(as(NGOZI)).expect(404);
    const held = mine.opportunities.filter((o: { held: boolean }) => o.held);
    expect(held.every((o: { holds: string[] }) => o.holds.length > 0)).toBe(true);
    const lead = await get('/adoption', 'lead@example.com');
    expect(lead.clients).toHaveLength(5);
  });
});
