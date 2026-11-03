import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ackSignature } from '../../src/alerts/ack-link.js';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { Outbox, World, apiApp, resetDatabase, testConfig } from './harness.js';

describe('API with Google sign-in and roles', () => {
  let app: INestApplication;
  let db: Database;
  const secret = 'test-secret-0123456789';
  const as = (email: string) => ({ authorization: `Bearer ${email}` });

  beforeAll(async () => {
    await resetDatabase();
    app = await apiApp(testConfig(), new World(), new Outbox());
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES
      ('admin@example.com', 'super_admin'), ('ngozi.okafor@example.com', 'csm'), ('director@example.com', 'cs_director')`);
    await app.get(JobRunner).run('daily', '2026-11-03');
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('serves health without sign-in and rejects everything else', async () => {
    await http().get('/health').expect(200, { status: 'ok' });
    await http().get('/flags').expect(401);
    await http().get('/flags').set(as('stranger@gmail.com')).expect(401);
    await http().get('/flags').set(as('nobody@example.com')).expect(403);
  });

  it('shows a CSM only their own portfolio', async () => {
    const mine = await http().get('/flags').set(as('ngozi.okafor@example.com')).expect(200);
    expect(mine.body.length).toBe(2);
    expect(new Set(mine.body.map((f: any) => f.csmEmail))).toEqual(new Set(['ngozi.okafor@example.com']));

    const all = await http().get('/flags').set(as('director@example.com')).expect(200);
    expect(all.body.length).toBe(8);
    expect(all.body[0].severity).toBe('urgent'); // most severe first

    const other = all.body.find((f: any) => f.csmEmail === 'tunde.bello@example.com');
    await http().get(`/flags/${other.id}`).set(as('ngozi.okafor@example.com')).expect(404);
    const detail = await http().get(`/flags/${other.id}`).set(as('director@example.com')).expect(200);
    expect(detail.body.alerts.length).toBeGreaterThan(0);
  });

  it('acknowledges from the alert link only on POST, with a valid signature', async () => {
    const { rows } = await db.query(`SELECT id FROM audit_flag WHERE type = 'LATE_PAYROLL'`);
    const id = Number(rows[0]!.id);
    const sig = ackSignature(secret, id);

    const page = await http().get(`/ack/${id}?sig=${sig}`).expect(200);
    expect(page.text).toContain('Payroll run is late');
    expect(page.text).toContain('<form method="post"');
    let { rows: after } = await db.query('SELECT acknowledged_at FROM audit_flag WHERE id = $1', [id]);
    expect(after[0]!.acknowledged_at).toBeNull(); // a link scanner's GET changes nothing

    await http().post(`/ack/${id}?sig=wrong`).expect(403);
    await http().post(`/ack/${id}?sig=${sig}`).expect(200);
    ({ rows: after } = await db.query('SELECT acknowledged_at, acknowledged_by FROM audit_flag WHERE id = $1', [id]));
    expect(after[0]!.acknowledged_by).toBe('ngozi.okafor@example.com (via alert link)');

    const log = await db.query(`SELECT count(*)::int AS n FROM action_log WHERE action = 'flag.acknowledge'`);
    expect(log.rows[0]!.n).toBe(1);
  });

  it('lets a CSM acknowledge in the API', async () => {
    const { rows } = await db.query(`SELECT id FROM audit_flag WHERE type = 'ARR_MISMATCH'`);
    const res = await http().post(`/flags/${rows[0]!.id}/acknowledge`).set(as('ngozi.okafor@example.com')).expect(200);
    expect(res.body).toEqual({ acknowledged: true, alreadyAcknowledged: false });
  });

  it('returns the latest reconciliation and hierarchy report to managers', async () => {
    const res = await http().get('/reports/latest').set(as('director@example.com')).expect(200);
    expect(res.body.summary.reconciliation).toMatchObject({ matched: 3 });
    await http().get('/reports/latest').set(as('ngozi.okafor@example.com')).expect(403);
  });

  it('lets only super admins change rules, and validates the value', async () => {
    await http().put('/rules/payroll_grace_business_days').set(as('director@example.com')).send({ value: 3 }).expect(403);
    await http().put('/rules/payroll_grace_business_days').set(as('admin@example.com')).send({ value: 'soon' }).expect(400);
    await http().put('/rules/no_such_rule').set(as('admin@example.com')).send({ value: 1 }).expect(400);
    await http().put('/rules/payroll_grace_business_days').set(as('admin@example.com')).send({ value: 3 }).expect(200);
    const rules = await http().get('/rules').set(as('director@example.com')).expect(200);
    expect(rules.body.find((r: any) => r.key === 'payroll_grace_business_days')).toMatchObject({ value: 3, updated_by: 'admin@example.com' });
  });

  it('runs jobs on demand for super admins', async () => {
    await http().post('/jobs/dispatch').set(as('director@example.com')).expect(403);
    await http().post('/jobs/nope').set(as('admin@example.com')).expect(400);
    const res = await http().post('/jobs/dispatch').set(as('admin@example.com')).expect(200);
    expect(res.body.dispatch.flagsConsidered).toBe(0);
  });
});
