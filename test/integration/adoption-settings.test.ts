import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { Outbox, World, apiApp, resetDatabase, testConfig } from './harness.js';

const DAY = '2026-11-03';
const NGOZI = 'ngozi.okafor@example.com';

describe('admins set the criteria for adoption and upsell', () => {
  let app: INestApplication;
  let db: Database;
  const as = (email: string, viewAs?: string) => ({ authorization: `Bearer ${email}`, ...(viewAs ? { 'x-view-as': viewAs } : {}) });
  const http = () => request(app.getHttpServer());
  const HEAD = 'director@example.com';
  const get = async (path: string, who = HEAD) => (await http().get(`${path}${path.includes('?') ? '&' : '?'}date=${DAY}`).set(as(who)).expect(200)).body;
  const modules = async (id: string) => Object.fromEntries((await get(`/adoption/clients/${id}`)).modules.map((m: { key: string }) => [m.key, m])) as Record<string, { status: string; mode: string; criteria: Array<{ type: string; state: string; detail: string; label: string }> }>;
  const putRule = (module: string, rule: object, who = HEAD) => http().put(`/adoption/settings/usage/${module}`).set(as(who)).send(rule);

  beforeEach(async () => {
    await resetDatabase();
    const world = new World();
    world.now = new Date(`${DAY}T12:00:00Z`);
    app = await apiApp(testConfig({ ALERTS_DRY_RUN: 'true' }), world, new Outbox());
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('${HEAD}', 'cs_director'), ('lead@example.com', 'cs_team_lead'), ('${NGOZI}', 'csm')`);
    await db.query(`UPDATE app_user SET manager_email = 'lead@example.com' WHERE role = 'csm'`);
    await db.query('DELETE FROM module_seasonality');
    await app.get(JobRunner).run('daily', DAY);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('shows the Head of CX every setting, with the built-in defaults beside it', async () => {
    const s = await get('/adoption/settings');
    expect(s.usage.find((u: { module: string }) => u.module === 'PAYROLL')).toMatchObject({ isDefault: true, rule: { mode: 'ANY' } });
    expect(s.usage.map((u: { module: string }) => u.module)).toEqual(expect.arrayContaining(['LEAVE', 'LOANS', 'REQUISITION', 'PERFORMANCE']));
    expect(s.criteriaKinds.map((k: { type: string }) => k.type)).toEqual(expect.arrayContaining(['CONFIGURED', 'LAST_REQUEST', 'LOGIN', 'ACTIVITY', 'PAYSLIP', 'PAYROLL_RUN', 'PAY_SCHEDULE']));
    expect(s.windows).toEqual([7, 14, 30, 45, 60, 90]);
    expect(s.scoring.churn.high).toBe(60);
    expect(s.fields.length).toBeGreaterThan(50);
    expect(s.notes.churn.at(-1)).toBe('High is 60 or more, medium 35 or more');
    await http().get('/adoption/settings').set(as(NGOZI)).expect(403);
    await http().get('/adoption/settings').set(as('lead@example.com')).expect(403);
    await http().get('/adoption/settings').set(as('admin@example.com')).expect(200);
  });

  it('says why each module counts as in use, criterion by criterion', async () => {
    const kano = await modules('1003');
    expect(kano.LEAVE!.status).toBe('in_use');
    expect(kano.LEAVE!.criteria.map((c) => [c.type, c.state])).toEqual([['LAST_REQUEST', 'met'], ['ACTIVITY', 'met']]);
    expect(kano.LEAVE!.criteria[0]!.detail).toMatch(/in the last 30 days, latest \d+ days? ago|today/);
    expect(kano.LOANS!).toMatchObject({ status: 'unused', mode: 'ANY' });
    expect(kano.LOANS!.criteria.map((c) => c.detail)).toEqual(['None in the last 30 days', 'No activity in the last 30 days']);
    expect(kano.PAYROLL!.criteria.map((c) => c.type)).toEqual(['PAYROLL_RUN', 'PAYSLIP', 'ACTIVITY']);
    expect(kano.TIME!.criteria).toEqual([]); // not bought, nothing to judge
  });

  it('1 is it configured: counts a module as in use only once it is set up', async () => {
    expect((await modules('1001')).CORE_HR!.status).toBe('in_use');
    expect((await putRule('CORE_HR', { mode: 'ALL', criteria: [{ type: 'CONFIGURED' }, { type: 'ACTIVITY', eventTypes: [], withinDays: 30, minEvents: 1, minActiveEmployees: 0 }] }).expect(200)).body.usage.find((u: { module: string }) => u.module === 'CORE_HR').isDefault).toBe(false);
    expect((await modules('1001')).CORE_HR!.status).toBe('in_use'); // configured and active
    // Abuja bought Core HR and never set it up
    const abuja = (await modules('1006')).CORE_HR!;
    expect(abuja.status).toBe('unused');
    expect(abuja.criteria[0]).toMatchObject({ type: 'CONFIGURED', state: 'not_met', detail: 'Bought but not configured yet' });
    // configured alone is enough if that is what the admin wants
    await putRule('LOANS', { mode: 'ANY', criteria: [{ type: 'CONFIGURED' }] }).expect(200);
    expect((await modules('1003')).LOANS!.status).toBe('unused'); // Kano bought Loans and never configured it
  });

  it('2 last request made: leave, requisition and loans, each with its own window and minimum', async () => {
    const before = (await modules('1001')).LEAVE!;
    expect(before.status).toBe('in_use');
    await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 7, minCount: 100000 }] }).expect(200);
    const strict = (await modules('1001')).LEAVE!;
    expect(strict.status).toBe('unused');
    expect(strict.criteria[0]!.detail).toMatch(/^Only \d+ in the last 7 days \(needs 100000\)$/);
    await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 90, minCount: 1 }] }).expect(200);
    expect((await modules('1001')).LEAVE!.status).toBe('in_use');
    // a request type nobody uses: requisitions
    await http().post('/adoption/signals').set(as(HEAD)).send({ hubspotId: '1001', kind: 'OTHER', detail: 'Test', happenedOn: DAY }).expect(201);
    await putRule('REQUISITION', { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['REQUISITION_REQUEST'], withinDays: 30, minCount: 1 }] }).expect(200);
  });

  it('3 web logins and activity on the module: employee sign-ins and admin logins', async () => {
    await putRule('CORE_HR', { mode: 'ANY', criteria: [{ type: 'LOGIN', withinDays: 14, minActiveEmployees: 5 }] }).expect(200);
    expect((await modules('1001')).CORE_HR!.status).toBe('in_use'); // Adebayo's staff sign in daily
    await putRule('CORE_HR', { mode: 'ANY', criteria: [{ type: 'LOGIN', withinDays: 7, minActiveEmployees: 5000 }] }).expect(200);
    expect((await modules('1001')).CORE_HR!.criteria[0]!.detail).toMatch(/^Only \d+ employees on the busiest day \(needs 5000\)$/);
    // the Lekki primary admin has not logged in for 41 days; the secondary did 12 days ago
    await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'ADMIN_LOGIN', withinDays: 30, who: 'primary' }] }).expect(200);
    expect((await modules('1002')).LEAVE!).toMatchObject({ status: 'unused' });
    await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'ADMIN_LOGIN', withinDays: 30, who: 'any' }] }).expect(200);
    expect((await modules('1002')).LEAVE!.status).toBe('in_use');
    // module activity with a minimum number of people on a day
    await putRule('LEAVE', { mode: 'ALL', criteria: [{ type: 'ACTIVITY', eventTypes: ['LEAVE_REQUEST'], withinDays: 30, minEvents: 5, minActiveEmployees: 100000 }] }).expect(200);
    expect((await modules('1001')).LEAVE!.status).toBe('unused');
  });

  it('4 payslips, payroll runs and pay schedules', async () => {
    const lekki = await modules('1002');
    expect(lekki.PAYROLL!.criteria.map((c) => [c.type, c.state])).toEqual([['PAYROLL_RUN', 'met'], ['PAYSLIP', 'met'], ['ACTIVITY', 'not_met']]);
    // require a pay schedule AND payslips in the last 14 days: Lekki's last run was 36 days ago
    await putRule('PAYROLL', { mode: 'ALL', criteria: [{ type: 'PAY_SCHEDULE' }, { type: 'PAYSLIP', eventTypes: ['PAYSLIP_GENERATED'], withinDays: 14, minCount: 1 }] }).expect(200);
    const after = await modules('1002');
    expect(after.PAYROLL!).toMatchObject({ status: 'unused', mode: 'ALL' });
    expect(after.PAYROLL!.criteria.map((c) => [c.type, c.state])).toEqual([['PAY_SCHEDULE', 'met'], ['PAYSLIP', 'not_met']]);
    // Adebayo ran payroll on 25 Oct, 9 days before 3 Nov
    expect((await modules('1001')).PAYROLL!.status).toBe('in_use');
    // Abuja never created a pay schedule
    const abuja = (await modules('1006')).PAYROLL!;
    expect(abuja.criteria[0]).toMatchObject({ type: 'PAY_SCHEDULE', state: 'not_met', detail: 'No pay schedule has been created' });
    // a payroll-run window
    await putRule('PAYROLL', { mode: 'ANY', criteria: [{ type: 'PAYROLL_RUN', withinDays: 14 }] }).expect(200);
    expect((await modules('1001')).PAYROLL!.status).toBe('in_use');
    expect((await modules('1002')).PAYROLL!.status).toBe('unused');
  });

  it('feeds the criteria through to adoption rate, churn and upsell', async () => {
    const rate = async () => (await get('/adoption')).portfolio;
    expect(await rate()).toMatchObject({ modulesBought: 16, modulesInUse: 12 });
    await putRule('LEAVE', { mode: 'ALL', criteria: [{ type: 'ACTIVITY', eventTypes: ['LEAVE_REQUEST'], withinDays: 7, minEvents: 100000, minActiveEmployees: 0 }] }).expect(200);
    const p = await rate();
    expect(p.modulesInUse).toBe(12 - 3); // Adebayo, Lekki and Kano all stop counting Leave
    expect(p.adoptionRatePct).toBeLessThan(75);
    const kano = (await get('/adoption')).clients.find((c: { name: string }) => c.name === 'Kano Holdings Group');
    expect(kano.partial.modules.map((m: { module: string }) => m.module).sort()).toEqual(['LEAVE', 'LOANS']);
  });

  it('lets an admin try a rule before saving it, and shows who would change', async () => {
    const draft = { mode: 'ALL', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 7, minCount: 100000 }] };
    const r = (await http().post(`/adoption/settings/usage/LEAVE/preview?date=${DAY}`).set(as(HEAD)).send(draft).expect(200)).body;
    expect(r).toMatchObject({ bought: 3, inUseNow: 3, inUseDraft: 0, totalChanges: 3 });
    expect(r.changes[0]).toMatchObject({ now: true, draft: false });
    expect(r.changes.map((c: { name: string }) => c.name).sort()).toEqual(['Adebayo Logistics', 'Kano Holdings Group', 'Lekki Foods']);
    expect((await modules('1001')).LEAVE!.status).toBe('in_use'); // nothing was saved
    expect((await get('/adoption/settings')).usage.find((u: { module: string }) => u.module === 'LEAVE').isDefault).toBe(true);
    await http().post(`/adoption/settings/usage/LEAVE/preview`).set(as(HEAD)).send({ mode: 'ALL', criteria: [] }).expect(400);
    await http().post(`/adoption/settings/usage/LEAVE/preview`).set(as(NGOZI)).send(draft).expect(403);
  });

  it('refuses rules that make no sense, and resets a module to its default', async () => {
    const bad = await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 31, minCount: 1 }] }).expect(400);
    expect(bad.body.message).toBeTruthy();
    await putRule('LEAVE', { mode: 'ANY', criteria: [] }).expect(400);
    await putRule('NOPE', { mode: 'ANY', criteria: [{ type: 'CONFIGURED' }] }).expect(404);
    await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'CONFIGURED' }] }, NGOZI).expect(403);
    await putRule('LEAVE', { mode: 'ANY', criteria: [{ type: 'CONFIGURED' }] }, 'admin@example.com').expect(200);
    const reset = (await http().post('/adoption/settings/usage/LEAVE/reset').set(as(HEAD)).expect(200)).body;
    expect(reset.usage.find((u: { module: string }) => u.module === 'LEAVE')).toMatchObject({ isDefault: true, rule: { criteria: [{ type: 'LAST_REQUEST' }, { type: 'ACTIVITY' }] } });
    expect((await modules('1001')).LEAVE!.mode).toBe('ANY');
  });

  it('a new module gets a sensible rule straight away, which can then be set', async () => {
    await http().post('/adoption/catalog/modules').set(as(HEAD)).send({ key: 'BENEFITS', label: 'Benefits' }).expect(201);
    const s = await get('/adoption/settings');
    expect(s.usage.find((u: { module: string }) => u.module === 'BENEFITS')).toMatchObject({ isDefault: true, rule: { mode: 'ANY', criteria: [{ type: 'ACTIVITY', withinDays: 30 }] } });
    await putRule('BENEFITS', { mode: 'ANY', criteria: [{ type: 'CONFIGURED' }] }).expect(200);
  });

  it('lets the Head of CX change every weight and threshold, and reset them', async () => {
    const level = async (name: string) => (await get('/adoption')).clients.find((c: { name: string }) => c.name === name).churn;
    expect(await level('Lekki Foods')).toMatchObject({ level: 'high', score: 80 });
    const s = await get('/adoption/settings');
    const doc = structuredClone(s.scoring);
    doc.churn.high = 90;
    doc.churn.adminDormant = 0;
    const saved = (await http().put('/adoption/settings/scoring').set(as(HEAD)).send(doc).expect(200)).body;
    expect(saved.scoring.churn.high).toBe(90);
    expect(saved.notes.churn.at(-1)).toBe('High is 90 or more, medium 35 or more');
    expect(saved.scoringChangedBy).toBe(HEAD);
    const after = await level('Lekki Foods');
    expect(after.level).toBe('medium');
    expect(after.score).toBe(80 - 15);
    expect(after.reasons.map((r: { text: string }) => r.text)).not.toContain('Primary admin has not logged in for over 30 days');
    // partial documents are fine: only the numbers sent change
    await http().put('/adoption/settings/scoring').set(as(HEAD)).send({ upsell: { hot: 90, warm: 70, cool: 40 } }).expect(200);
    const o = await get('/adoption');
    expect(o.opportunities.every((x: { score: number }) => x.score >= 40)).toBe(true);
    expect((await get('/adoption/settings')).scoring.churn.high).toBe(90); // earlier change kept
    // reset
    const reset = (await http().post('/adoption/settings/scoring/reset').set(as(HEAD)).expect(200)).body;
    expect(reset.scoring.churn.high).toBe(60);
    expect((await level('Lekki Foods')).level).toBe('high');
    expect((await db.query(`SELECT count(*)::int AS n FROM action_log WHERE action IN ('scoring.save', 'scoring.reset')`)).rows[0]!.n).toBe(3);
  });

  it('turns holds off, and edits related modules and growth-plan affinities', async () => {
    const kano = async () => (await get('/adoption/clients/1003')).opportunities.find((o: { module: string }) => o.module === 'TIME');
    expect((await kano()).holds).toContain('Urgent or high alerts are open');
    await http().put('/adoption/settings/scoring').set(as(HEAD)).send({ holds: { urgentAlerts: false } }).expect(200);
    expect((await kano()).holds).not.toContain('Urgent or high alerts are open');
    await http().put('/adoption/settings/scoring').set(as(HEAD)).send({ related: { TIME: [{ uses: 'PAYROLL', because: 'pays shift workers' }] } }).expect(200);
    expect((await kano()).reasons.map((r: { text: string }) => r.text)).toContain('Uses Payroll and pays shift workers');
    expect((await kano()).reasons.map((r: { text: string }) => r.text)).not.toContain('Uses Leave management and already manages leave in the platform');
  });

  it('refuses settings that make no sense, and says why in plain words', async () => {
    const put = (b: object, who = HEAD) => http().put('/adoption/settings/scoring').set(as(who)).send(b);
    expect((await put({ churn: { high: 500 } }).expect(400)).body.message).toMatch(/High risk from: use a number from 1 to 100/);
    expect((await put({ churn: { medium: 70, high: 60 } }).expect(400)).body.message).toMatch(/Medium churn risk must start below high/);
    expect((await put({ upsell: { hot: 1.5 } }).expect(400)).body.message).toMatch(/Hot from: use a whole number/);
    await put({ holds: { nope: true } }).expect(400);
    await put({ churn: { high: 70 } }, NGOZI).expect(403);
    await http().put('/adoption/settings/scoring').set(as('admin@example.com', HEAD)).send({ churn: { high: 70 } }).expect(403); // view-as is read-only
    expect((await get('/adoption/settings')).scoring.churn.high).toBe(60); // nothing was saved
  });
});
