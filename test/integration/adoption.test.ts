import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayInLagos } from '../../src/common/calendar.js';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { Outbox, World, apiApp, resetDatabase, testConfig } from './harness.js';

describe('product adoption', () => {
  let app: INestApplication;
  let db: Database;
  let world: World;
  const as = (email: string, viewAs?: string) => ({ authorization: `Bearer ${email}`, ...(viewAs ? { 'x-view-as': viewAs } : {}) });
  const http = () => request(app.getHttpServer());
  const NGOZI = 'ngozi.okafor@example.com';
  const TUNDE = 'tunde.bello@example.com';

  async function start(configure?: (w: World) => void) {
    await resetDatabase();
    world = new World();
    configure?.(world);
    app = await apiApp(testConfig({ ALERTS_DRY_RUN: 'true' }), world, new Outbox());
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'), ('lead@example.com', 'cs_team_lead'), ('${NGOZI}', 'csm'), ('${TUNDE}', 'csm'), ('support@example.com', 'support_specialist')`);
    await db.query(`UPDATE app_user SET manager_email = 'lead@example.com' WHERE role = 'csm'`);
    return app.get(JobRunner);
  }

  afterEach(async () => {
    await app?.close();
  });

  describe('with data', () => {
    let jobs: JobRunner;
    beforeEach(async () => {
      jobs = await start();
      await jobs.run('daily', todayInLagos());
    });

    it('stores administrators, employee activity and modules from the Control Panel', async () => {
      const n = async (t: string) => (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
      expect(await n('cp_client_admin')).toBe(8);
      expect(await n('cp_admin_action')).toBeGreaterThan(5);
      expect(await n('cp_employee_activity')).toBeGreaterThan(500);
      expect(await n('cp_client_module')).toBe(world.modules.length);
      // ticket status, first reply and who raised it are kept
      const t = (await db.query(`SELECT status_label, first_response_at, raised_by FROM ticket WHERE ticket_id = 'T-1001'`)).rows[0]!;
      expect(t).toMatchObject({ status_label: 'Waiting on support', first_response_at: null, raised_by: 'Chidi O.' });
    });

    it('shows the last time the primary and secondary admin logged in, and what they did', async () => {
      const c = (await http().get('/adoption/clients/1003').set(as('director@example.com')).expect(200)).body;
      expect(c.admins.map((a: { level: string }) => a.level)).toEqual(['PRIMARY', 'SECONDARY']);
      const [primary, secondary] = c.admins;
      expect(primary).toMatchObject({ name: 'Halima Sani', status: 'active', daysSinceLogin: 3 });
      expect(primary.recentActions.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['Ran October payroll for Kano Cement']));
      expect(primary.recentActions[0].at >= primary.recentActions[1].at).toBe(true); // newest first
      expect(secondary).toMatchObject({ lastLoginAt: null, status: 'never', daysSinceLogin: null });
      const lekki = (await http().get('/adoption/clients/1002').set(as('director@example.com')).expect(200)).body;
      expect(lekki.admins[0]).toMatchObject({ level: 'PRIMARY', status: 'dormant', daysSinceLogin: 41 });
      expect(lekki.admins[1]).toMatchObject({ level: 'SECONDARY', status: 'active', daysSinceLogin: 12 });
    });

    it('shows employee activity for sign-ins, leave, loans and profile updates, with the change on the month before', async () => {
      const e = (await http().get('/adoption/clients/1003').set(as('director@example.com')).expect(200)).body.employees;
      const by = Object.fromEntries(e.lines.map((l: { eventType: string }) => [l.eventType, l]));
      expect(by.SIGN_IN.last30).toBeGreaterThan(500);
      expect(by.LEAVE_REQUEST.last30).toBeGreaterThan(30);
      expect(by.PROFILE_UPDATE.last30).toBeGreaterThan(10);
      expect(by.LOAN_REQUEST).toBeUndefined(); // Kano bought Loans and nobody uses it
      expect(typeof by.SIGN_IN.changePct).toBe('number');
      expect(e.lines.slice(0, 3).map((l: { eventType: string }) => l.eventType)).toEqual(['SIGN_IN', 'LEAVE_REQUEST', 'PROFILE_UPDATE']); // the four headline events come first
      expect(e.weekly).toHaveLength(8);
      expect(e.dailyActive).toBeGreaterThan(20);
      expect(e.activeSeats).toBe(130); // parent and both sub-accounts
      // sub-account activity rolls up to the parent: Kano's own account has none
      const kano = (await http().get('/adoption').set(as('director@example.com')).expect(200)).body.clients.find((c: { name: string }) => c.name === 'Kano Holdings Group');
      expect(kano.activityLast30).toBeGreaterThan(0);
      expect(kano.engagementPct).toBeGreaterThan(0);
    });

    it('lists support tickets with status, who raised them and SLA state, so a CSM can step in', async () => {
      const s = (await http().get('/adoption/clients/1003').set(as('director@example.com')).expect(200)).body.support;
      expect(s.targets).toMatchObject({ firstResponseHigh: 4, resolutionNormal: 72 });
      const t1001 = s.tickets.find((t: { id: string }) => t.id === 'T-1001');
      expect(t1001).toMatchObject({ status: 'Waiting on support', raisedBy: 'Chidi O.', priority: 'HIGH', open: true });
      expect(t1001.sla.firstResponse.state).toBe('breached'); // never answered
      expect(t1001.sla.openBreach).toBe(true);
      expect(s.summary.open).toBe(2);
      expect(s.summary.breached).toBe(2);
      const closed = s.tickets.find((t: { id: string }) => t.id === 'T-1002');
      expect(closed).toMatchObject({ open: false, status: 'Closed' });
      expect(closed.sla.openBreach).toBe(false);
      expect(s.summary.avgFirstResponseHours).not.toBeNull();
    });

    it('raises a support SLA alert for the CSM, and clears it once the tickets are answered', async () => {
      const open = async () => (await db.query(`SELECT company_name, severity FROM audit_flag WHERE type = 'SUPPORT_SLA_BREACH' AND status = 'open' ORDER BY company_name`)).rows;
      expect(await open()).toEqual([
        { company_name: 'Abuja Tech Hub', severity: 'high' }, { company_name: 'Ibadan Clinics', severity: 'medium' },
        { company_name: 'Kano Holdings Group', severity: 'high' }, { company_name: 'Lekki Foods', severity: 'medium' },
      ]);
      const alerts = (await http().get('/flags?type=SUPPORT_SLA_BREACH').set(as(TUNDE)).expect(200)).body;
      expect(alerts.map((f: { companyName: string }) => f.companyName).sort()).toEqual(['Abuja Tech Hub', 'Ibadan Clinics', 'Kano Holdings Group']);
      // Support answers and closes Kano's two open tickets
      for (const id of ['T-1001', 'T-1012']) Object.assign(world.ticket(id), { firstResponseAt: new Date().toISOString(), closedAt: new Date().toISOString(), isClosed: true, statusLabel: 'Closed' });
      await jobs.run('daily', todayInLagos());
      expect((await open()).map((r) => r.company_name)).not.toContain('Kano Holdings Group');
    });

    it('compares modules most purchased, in use, and open for upsell', async () => {
      const o = (await http().get('/adoption').set(as('director@example.com')).expect(200)).body;
      expect(o.modulesKnown).toBe(true);
      const m = Object.fromEntries(o.matrix.map((r: { key: string }) => [r.key, r]));
      expect(o.matrix[0].purchased).toBeGreaterThanOrEqual(o.matrix.at(-1).purchased); // most purchased first
      expect(m.PAYROLL.purchased).toBe(4); // Port Harcourt Marine is not linked in HubSpot, so it is not a customer here
      expect(m.LOANS).toMatchObject({ purchased: 1, inUse: 0, unusedClients: ['Kano Holdings Group'] });
      expect(m.STATUTORY.upsellClients.map((c: { name: string }) => c.name)).toContain('Adebayo Logistics'); // runs payroll, healthy, no urgent alerts
      expect(m.PAYROLL.unusedClients).toContain('Abuja Tech Hub'); // bought, payroll never set up
      const kano = (await http().get('/adoption/clients/1003').set(as('director@example.com')).expect(200)).body;
      expect(Object.fromEntries(kano.modules.map((x: { key: string; status: string }) => [x.key, x.status]))).toMatchObject({ PAYROLL: 'in_use', LEAVE: 'in_use', LOANS: 'unused', EWA: 'in_use', STATUTORY: 'in_use', TIME: 'not_purchased' });
      expect(kano.opportunities.find((u: { module: string }) => u.module === 'TIME').holds).toContain('Urgent or high alerts are open'); // fix the alerts first
      const adebayo = (await http().get('/adoption/clients/1001').set(as('director@example.com')).expect(200)).body;
      const stat = adebayo.opportunities.find((u: { module: string }) => u.module === 'STATUTORY');
      expect(stat.holds).toEqual([]);
      const why = stat.reasons.map((r: { text: string }) => r.text).join(' | ');
      expect(why).toMatch(/Uses Payroll/);
      expect(why).toMatch(/of customers have it/);
    });

    it('keeps each CSM and team lead to their own clients', async () => {
      const mine = (await http().get('/adoption').set(as(NGOZI)).expect(200)).body;
      expect(mine.clients.map((c: { name: string }) => c.name).sort()).toEqual(['Adebayo Logistics', 'Lekki Foods']);
      expect(mine.matrix.find((m: { key: string }) => m.key === 'LOANS').purchased).toBe(0); // scope-level, not company-wide
      await http().get('/adoption/clients/1003').set(as(NGOZI)).expect(404);
      await http().get('/adoption?csm=' + TUNDE).set(as(NGOZI)).expect(404);
      const lead = (await http().get('/adoption').set(as('lead@example.com')).expect(200)).body;
      expect(lead.clients.length).toBe(5);
      expect(lead.people).toHaveLength(2);
      await http().get('/adoption/clients/1003').set(as('lead@example.com')).expect(200);
      await http().get('/adoption').set(as('support@example.com')).expect(403);
      const asNgozi = (await http().get('/adoption').set(as('admin@example.com', NGOZI)).expect(200)).body;
      expect(asNgozi.clients).toHaveLength(2);
    });
  });

  it('keeps working when the Control Panel has not been given the adoption views yet', async () => {
    const jobs = await start();
    const { CONTROL_PANEL_SOURCE } = await import('../../src/sources/source.types.js');
    const src = app.get(CONTROL_PANEL_SOURCE) as Record<string, unknown>;
    for (const k of ['fetchClientAdmins', 'fetchAdminActions', 'fetchEmployeeActivity', 'fetchClientModules']) {
      src[k] = async () => { throw new Error(`relation "audit.v_${k}" does not exist`); };
    }
    const out = (await jobs.run('daily', todayInLagos())) as { ingest: { warnings: string[] }; audit: { findings: number } };
    expect(out.ingest.warnings).toHaveLength(3);
    expect(out.ingest.warnings.join(' ')).toMatch(/Administrator activity not loaded/);
    expect(out.audit.findings).toBe(18); // billing and support audits are unaffected
    const o = (await http().get('/adoption').set(as('director@example.com')).expect(200)).body;
    expect(o.modulesKnown).toBe(false);
    const c = (await http().get('/adoption/clients/1003').set(as('director@example.com')).expect(200)).body;
    expect(c.admins).toEqual([]);
    expect(c.employees.lines).toEqual([]);
    expect(c.opportunities).toEqual([]);
    expect(c.support.tickets.length).toBeGreaterThan(0); // support still comes from HubSpot
  });

  it('keeps yesterday’s adoption data when tonight’s pull fails', async () => {
    const jobs = await start();
    await jobs.run('daily', todayInLagos());
    const before = (await db.query(`SELECT count(*)::int AS n FROM cp_employee_activity`)).rows[0]!.n;
    const { CONTROL_PANEL_SOURCE } = await import('../../src/sources/source.types.js');
    (app.get(CONTROL_PANEL_SOURCE) as Record<string, unknown>).fetchEmployeeActivity = async () => { throw new Error('timeout'); };
    await jobs.run('ingest', todayInLagos());
    expect((await db.query(`SELECT count(*)::int AS n FROM cp_employee_activity`)).rows[0]!.n).toBe(before);
  });
});
