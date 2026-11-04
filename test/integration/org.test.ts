import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayInLagos } from '../../src/common/calendar.js';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { OrgService } from '../../src/org/org.service.js';
import { ReportService } from '../../src/reports/report.service.js';
import { Outbox, World, apiApp, resetDatabase, testConfig } from './harness.js';

describe('organogram, view-as and the CSM dashboard', () => {
  let app: INestApplication;
  let db: Database;
  let outbox: Outbox;
  const as = (email: string, viewAs?: string) => ({ authorization: `Bearer ${email}`, ...(viewAs ? { 'x-view-as': viewAs } : {}) });
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await resetDatabase();
    outbox = new Outbox();
    app = await apiApp(testConfig({ ALERTS_DRY_RUN: 'false' }), new World(), outbox);
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'),
      ('lead@example.com', 'cs_team_lead'), ('otherlead@example.com', 'cs_team_lead'), ('ngozi.okafor@example.com', 'csm'), ('tunde.bello@example.com', 'csm'), ('support@example.com', 'support_specialist')`);
    // Ngozi reports to Lead through the Users screen; Tunde through the Team leads screen (escalation table).
    await db.query(`UPDATE app_user SET manager_email = 'lead@example.com' WHERE email = 'ngozi.okafor@example.com'`);
    await db.query(`INSERT INTO csm_team (csm_email, team_lead_email, updated_by) VALUES ('tunde.bello@example.com', 'otherlead@example.com', 'test')`);
    await app.get(JobRunner).run('ingest', todayInLagos());
    await app.get(JobRunner).run('audit', todayInLagos());
  });

  afterEach(async () => {
    await app?.close();
  });

  it('works out who sees whom from both places reporting lines are kept', async () => {
    const org = app.get(OrgService);
    expect([...(await org.descendants('lead@example.com'))]).toEqual(['ngozi.okafor@example.com']);
    expect([...(await org.descendants('otherlead@example.com'))]).toEqual(['tunde.bello@example.com']);
    expect((await org.scopeFor({ email: 'director@example.com', role: 'cs_director' })).all).toBe(true);
    expect([...(await org.scopeFor({ email: 'ngozi.okafor@example.com', role: 'csm' })).emails]).toEqual(['ngozi.okafor@example.com']);
    expect(await org.wouldLoop('lead@example.com', 'ngozi.okafor@example.com')).toBe(true);
  });

  it('shows a CSM only their own clients, with the numbers that matter', async () => {
    const d = (await http().get('/portfolio').set(as('ngozi.okafor@example.com')).expect(200)).body;
    const names = d.clients.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Adebayo Logistics', 'Lekki Foods']));
    expect(names).not.toContain('Kano Holdings Group');
    expect(d.summary.clients).toBe(names.length);
    expect(typeof d.summary.arrKobo).toBe('string'); // exact kobo as text
    const lekki = d.clients.find((c: { name: string }) => c.name === 'Lekki Foods');
    expect(lekki).toMatchObject({ payroll: { status: 'late' }, topSeverity: 'urgent' });
    expect(lekki.openAlerts).toBeGreaterThan(0);
    expect(lekki.utilisationPct).not.toBeNull();
    expect(d.team).toHaveLength(1);
    await http().get('/portfolio?csm=tunde.bello@example.com').set(as('ngozi.okafor@example.com')).expect(404);
  });

  it('gives a team lead their team, a director everyone, and keeps other teams out', async () => {
    const lead = (await http().get('/portfolio').set(as('lead@example.com')).expect(200)).body;
    expect(lead.clients.every((c: { csmEmail: string }) => c.csmEmail === 'ngozi.okafor@example.com')).toBe(true);
    expect(lead.people.map((p: { email: string }) => p.email)).toEqual(['ngozi.okafor@example.com']);
    await http().get('/portfolio?csm=tunde.bello@example.com').set(as('lead@example.com')).expect(404);
    const dir = (await http().get('/portfolio').set(as('director@example.com')).expect(200)).body;
    expect(dir.team.length).toBeGreaterThan(2); // both CSMs and the unassigned group
    expect(dir.clients.some((c: { csmEmail: string | null }) => c.csmEmail === null)).toBe(true);
    expect(dir.summary.clients).toBe(dir.clients.length);
    const one = (await http().get('/portfolio?csm=tunde.bello@example.com').set(as('director@example.com')).expect(200)).body;
    expect(one.clients.every((c: { csmEmail: string }) => c.csmEmail === 'tunde.bello@example.com')).toBe(true);
  });

  it('opens one client in full, but only inside your scope', async () => {
    const mine = (await http().get('/portfolio/clients/1002').set(as('ngozi.okafor@example.com')).expect(200)).body;
    expect(mine.client.name).toBe('Lekki Foods');
    expect(mine.alerts.length).toBeGreaterThan(0);
    expect(Array.isArray(mine.seatHistory)).toBe(true);
    expect(Array.isArray(mine.tickets)).toBe(true);
    await http().get('/portfolio/clients/1003').set(as('ngozi.okafor@example.com')).expect(404);
    await http().get('/portfolio/clients/1003').set(as('lead@example.com')).expect(404);
    await http().get('/portfolio/clients/1003').set(as('director@example.com')).expect(200);
    await http().get('/portfolio').set(as('support@example.com')).expect(403);
  });

  it('limits alerts to your team, for CSMs and team leads alike', async () => {
    const own = (await http().get('/flags').set(as('lead@example.com')).expect(200)).body as Array<{ csmEmail: string | null; id: number }>;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((f) => f.csmEmail === 'ngozi.okafor@example.com')).toBe(true);
    const all = (await http().get('/flags').set(as('director@example.com')).expect(200)).body as Array<{ csmEmail: string | null; id: number }>;
    const tundes = all.find((f) => f.csmEmail === 'tunde.bello@example.com')!;
    await http().get(`/flags/${tundes.id}`).set(as('lead@example.com')).expect(404);
    await http().post(`/flags/${tundes.id}/acknowledge`).set(as('lead@example.com')).expect(404);
    await http().post(`/flags/${own[0]!.id}/acknowledge`).set(as('lead@example.com')).expect(200);
  });

  it('builds a report of your work and everyone under you', async () => {
    const mine = (await http().get('/reports/preview?audience=csm&cadence=weekly').set(as('ngozi.okafor@example.com')).expect(200)).body;
    expect(mine.title).toBe('Weekly portfolio report');
    const team = (await http().get('/reports/preview?audience=csm&cadence=weekly').set(as('lead@example.com')).expect(200)).body;
    expect(team.title).toBe('Weekly team report');
    expect(JSON.stringify(team)).toContain('Adebayo Logistics');
    expect(JSON.stringify(team)).not.toContain('Kano Holdings');
    expect(JSON.stringify(team.sections)).toContain('By CSM');
    const person = (await http().get('/reports/preview?audience=csm&cadence=weekly&csm=ngozi.okafor@example.com').set(as('lead@example.com')).expect(200)).body;
    expect(person.title).toBe('Weekly portfolio report');
    await http().get('/reports/preview?audience=csm&cadence=weekly&csm=tunde.bello@example.com').set(as('lead@example.com')).expect(404);
    await http().get('/reports/preview?audience=csm&cadence=weekly').set(as('director@example.com')).expect(200);
    await http().get('/reports/preview?audience=csm&cadence=weekly').set(as('otherlead@example.com')).expect(200);
    await db.query(`DELETE FROM csm_team`);
    await http().get('/reports/preview?audience=csm&cadence=weekly').set(as('otherlead@example.com')).expect(400); // nobody under them now
  });

  it('emails each team lead their team report on the schedule, once', async () => {
    const reports = app.get(ReportService);
    const res = await reports.run(todayInLagos(), { cadences: ['weekly'] });
    expect(res.failed).toBe(0);
    const toLead = outbox.emails.filter((e) => e.to.includes('lead@example.com'));
    expect(toLead).toHaveLength(1);
    expect(toLead[0]!.subject).toMatch(/team report/i);
    expect(outbox.emails.filter((e) => e.to.includes('ngozi.okafor@example.com'))[0]!.subject).toMatch(/portfolio report/i);
    await reports.run(todayInLagos(), { cadences: ['weekly'] });
    expect(outbox.emails.filter((e) => e.to.includes('lead@example.com'))).toHaveLength(1);
  });

  it('lets a super admin look at the app as someone else, read-only, and nobody else', async () => {
    const me = (await http().get('/me').set(as('admin@example.com', 'ngozi.okafor@example.com')).expect(200)).body;
    expect(me).toMatchObject({ email: 'ngozi.okafor@example.com', role: 'csm', isAdmin: false, canViewAs: true, viewingAs: { actual: { email: 'admin@example.com', role: 'super_admin' } } });
    expect(me.people.length).toBeGreaterThan(3);
    const view = (await http().get('/portfolio').set(as('admin@example.com', 'ngozi.okafor@example.com')).expect(200)).body;
    expect(view.clients.every((c: { csmEmail: string }) => c.csmEmail === 'ngozi.okafor@example.com')).toBe(true);
    await http().get('/users').set(as('admin@example.com', 'ngozi.okafor@example.com')).expect(403); // sees what a CSM sees
    await http().get('/users').set(as('admin@example.com', 'director@example.com')).expect(200);
    const flag = (await http().get('/flags').set(as('admin@example.com', 'ngozi.okafor@example.com')).expect(200)).body[0];
    await http().post(`/flags/${flag.id}/acknowledge`).set(as('admin@example.com', 'ngozi.okafor@example.com')).expect(403); // read-only
    await http().post('/users').set(as('admin@example.com', 'director@example.com')).send({ email: 'x@example.com', role: 'csm' }).expect(403);
    await http().get('/me').set(as('admin@example.com', 'nobody@example.com')).expect(403);
    // not a super admin: the header is ignored
    const sneaky = (await http().get('/me').set(as('ngozi.okafor@example.com', 'director@example.com')).expect(200)).body;
    expect(sneaky).toMatchObject({ role: 'csm', viewingAs: null, canViewAs: false });
    await http().get('/users').set(as('ngozi.okafor@example.com', 'director@example.com')).expect(403);
    expect((await db.query(`SELECT count(*)::int AS n FROM action_log WHERE action = 'view_as'`)).rows[0]!.n).toBeGreaterThan(0);
  });

  it('sets who someone reports to, with checks', async () => {
    const put = (email: string, body: object, by = 'director@example.com') => http().put(`/users/${email}`).set(as(by)).send(body);
    await put('support@example.com', { managerEmail: 'lead@example.com' }).expect(200);
    expect([...(await app.get(OrgService).descendants('lead@example.com'))].sort()).toEqual(['ngozi.okafor@example.com', 'support@example.com']);
    await put('support@example.com', { managerEmail: 'ngozi.okafor@example.com' }).expect(400); // a CSM cannot be a manager
    await put('lead@example.com', { managerEmail: 'support@example.com' }).expect(400);
    await put('otherlead@example.com', { managerEmail: 'lead@example.com' }).expect(200);
    await put('lead@example.com', { managerEmail: 'otherlead@example.com' }).expect(409); // loop
    await put('support@example.com', { managerEmail: 'ghost@example.com' }).expect(400);
    await put('support@example.com', { managerEmail: null }).expect(200);
    expect((await http().get('/users').set(as('director@example.com')).expect(200)).body.find((u: { email: string }) => u.email === 'ngozi.okafor@example.com').managerEmail).toBe('lead@example.com');
    // otherlead now reports to lead, so lead sees otherlead's team too (but not the other way round)
    expect([...(await app.get(OrgService).descendants('lead@example.com'))].sort()).toEqual(['ngozi.okafor@example.com', 'otherlead@example.com', 'tunde.bello@example.com']);
    expect([...(await app.get(OrgService).descendants('otherlead@example.com'))]).toEqual(['tunde.bello@example.com']);
  });

  it('serves one sign-in page with no separate admin entry', async () => {
    const html = (await http().get('/').expect(200)).text;
    expect(html).not.toContain('id="tab-admin"');
    expect(html).toContain('id="view-dashboard"');
    expect(html).toContain('bring to light');
  });
});
