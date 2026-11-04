import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { todayInLagos } from '../../src/common/calendar.js';
import { Database } from '../../src/db/database.js';
import { BroadcastError, BroadcastService, type Actor, type RunRecord } from '../../src/broadcasts/broadcast.service.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { Outbox, World, apiApp, resetDatabase, testConfig, workerApp } from './harness.js';

const ADMIN: Actor = { email: 'admin@example.com', role: 'super_admin' };
const DIRECTOR: Actor = { email: 'director@example.com', role: 'cs_director' };
const CSM: Actor = { email: 'ngozi.okafor@example.com', role: 'csm' };

const CLIENT_DRAFT = {
  name: 'Payroll deadline', subject: 'Hello {{company_name}}', body: 'Hi team at {{company_name}},\n\nYour **payroll** deadline is near. <script>alert(1)</script>',
  audience: 'clients', filters: {}, channels: ['email'],
};
const CSM_DRAFT = { name: 'CSM note', subject: 'Check in with {{company_name}}', body: 'Please review {{company_name}} ({{health_status}}).', audience: 'csms', filters: {}, channels: ['email', 'google_chat', 'hubspot_task'] };

async function expectError(p: Promise<unknown>, status: number, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BroadcastError);
  expect((err as BroadcastError).status).toBe(status);
  if (message) expect((err as BroadcastError).message).toMatch(message);
}

describe('phase 4 broadcasts against Postgres', () => {
  let app: TestingModule;
  let world: World;
  let outbox: Outbox;
  let db: Database;
  let svc: BroadcastService;

  async function start(env: Record<string, string> = {}) {
    await resetDatabase();
    world = new World();
    outbox = new Outbox();
    app = await workerApp(testConfig({ BROADCASTS_LIVE: 'true', BROADCAST_SEND_DELAY_MS: '0', ...env }), world, outbox);
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'),
      ('ngozi.okafor@example.com', 'csm'), ('support@example.com', 'support_specialist')`);
    await app.get(JobRunner).run('ingest', todayInLagos());
    svc = app.get(BroadcastService);
  }

  async function finish(runId: number, user: Actor = ADMIN): Promise<RunRecord & { recipients: Array<{ status: string; recipient: string; channel: string; company: string | null; error: string | null }> }> {
    for (let i = 0; i < 100; i++) {
      const r = await svc.run(runId, user);
      if (r.status !== 'running') return r as never;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('run did not finish');
  }

  afterEach(async () => {
    await app?.close();
  });

  it('limits broadcasts to super admins and directors, and clients to super admins', async () => {
    await start();
    expect(await svc.access(ADMIN)).toMatchObject({ allowed: true, canSendToClients: true, live: true });
    expect(await svc.access(DIRECTOR)).toMatchObject({ allowed: true, canSendToClients: false });
    expect(await svc.access(CSM)).toMatchObject({ allowed: false });
    await expectError(svc.create(CLIENT_DRAFT, CSM), 403);
    await expectError(svc.create(CLIENT_DRAFT, DIRECTOR), 403, /super admins/);
    expect((await svc.create(CSM_DRAFT, DIRECTOR)).status).toBe('draft');
  });

  it('can also require the sender to be a Control Panel admin', async () => {
    await start({ BROADCAST_REQUIRE_CP_ADMIN: 'true' });
    expect((await svc.access(ADMIN)).allowed).toBe(true);
    world.adminEmails = [];
    const other = { email: 'someone@example.com', role: 'cs_director' };
    expect(await svc.access(other)).toMatchObject({ allowed: false, reason: expect.stringMatching(/Control Panel/) });
  });

  it('rejects drafts with unknown tokens, forbidden channels, or empty content', async () => {
    await start();
    await expectError(svc.create({ ...CLIENT_DRAFT, body: 'Hi {{secret}}' }, ADMIN), 422, /Unknown token/);
    await expectError(svc.create({ ...CLIENT_DRAFT, channels: ['hubspot_task'] }, ADMIN), 422, /cannot use/);
    await expectError(svc.create({ ...CLIENT_DRAFT, name: '' }, ADMIN), 422);
    await expectError(svc.create({ ...CSM_DRAFT, audience: 'cx_team', channels: ['email'] }, ADMIN), 422, /tokens/);
  });

  it('previews who gets what: skips companies without a contact, one message per valid address', async () => {
    await start();
    const p = await svc.preview(CLIENT_DRAFT, ADMIN);
    // 1001, 1002, 1003, 1005, 1006(two addresses) have contacts; 1004 has none
    expect(p.sendable).toBe(6);
    expect(p.counts.email).toBe(6);
    expect(p.skipped).toEqual([expect.objectContaining({ company: 'Ibadan Clinics', reason: expect.stringMatching(/No contact email/) })]);
    expect(p.live).toBe(true);
    expect(p.samples[0]!.subject).toMatch(/^Hello /);
    const filtered = await svc.preview({ ...CLIENT_DRAFT, filters: { health: ['At Risk'] } }, ADMIN);
    expect(filtered.sendable).toBeLessThan(p.sendable);
  });

  it('refuses to send unless the confirmed count matches the preview', async () => {
    await start();
    const b = await svc.create(CLIENT_DRAFT, ADMIN);
    await expectError(svc.send(b.id, 5, ADMIN), 409, /not 5/);
    expect(outbox.emails).toHaveLength(0);
    expect((await db.query('SELECT count(*)::int AS n FROM broadcast_run')).rows[0]!.n).toBe(0);
  });

  it('sends to clients, writes a CRM note per company, escapes HTML, and cannot be sent twice', async () => {
    await start();
    const b = await svc.create(CLIENT_DRAFT, ADMIN);
    const started = await svc.send(b.id, 6, ADMIN);
    const run = await finish(started.id);
    expect(run).toMatchObject({ status: 'completed', live: true, total: 7, sent: 6, failed: 0, skipped: 1 }); // the 7th row is Ibadan, which has no contact
    expect(outbox.emails).toHaveLength(6);
    const kano = outbox.emails.find((e) => e.to.includes('hr@kanoholdings.example'))!;
    expect(kano.subject).toBe('Hello Kano Holdings Group');
    expect(kano.html).toContain('<strong>payroll</strong>');
    expect(kano.html).not.toContain('<script>');
    expect(kano.text).not.toContain('**');
    // one note per company, not one per address
    expect(world.notes.map((n) => n.companyId).sort()).toEqual(['1001', '1002', '1003', '1005', '1006']);
    expect((await svc.get(b.id, ADMIN)).status).toBe('sent');
    await expectError(svc.send(b.id, 6, ADMIN), 409, /already been sent/);
    await expectError(svc.update(b.id, CLIENT_DRAFT, ADMIN), 409);
    const audit = await db.query(`SELECT action FROM action_log WHERE action LIKE 'broadcast.%'`);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['broadcast.create', 'broadcast.send']));
  });

  it('is a dry run unless BROADCASTS_LIVE is on: records the run, sends nothing', async () => {
    await start({ BROADCASTS_LIVE: 'false' });
    const b = await svc.create(CLIENT_DRAFT, ADMIN);
    const run = await finish((await svc.send(b.id, 6, ADMIN)).id);
    expect(run).toMatchObject({ live: false, status: 'completed' });
    expect(outbox.emails).toHaveLength(0);
    expect(world.notes).toHaveLength(0);
    expect((await svc.preview(CLIENT_DRAFT, ADMIN)).live).toBe(false);
  });

  it('records failures per recipient and carries on with the rest', async () => {
    await start();
    const realSend = outbox.email.send;
    outbox.email.send = async (m) => {
      if (m.to.includes('people@lekkifoods.example')) throw new Error('mailbox full');
      return realSend(m);
    };
    const b = await svc.create(CLIENT_DRAFT, ADMIN);
    const run = await finish((await svc.send(b.id, 6, ADMIN)).id);
    expect(run).toMatchObject({ sent: 5, failed: 1, status: 'completed' });
    expect(run.recipients.find((r) => r.status === 'failed')).toMatchObject({ recipient: 'people@lekkifoods.example', error: expect.stringMatching(/mailbox full/) });
  });

  it('sends to CSMs by email, chat and HubSpot task, skipping accounts with no CSM', async () => {
    await start();
    const b = await svc.create(CSM_DRAFT, DIRECTOR);
    const p = await svc.preview(CSM_DRAFT, DIRECTOR);
    const run = await finish((await svc.send(b.id, p.sendable, DIRECTOR)).id, DIRECTOR);
    expect(run.status).toBe('completed');
    expect(run.failed).toBe(0);
    expect(outbox.emails.length).toBeGreaterThan(0);
    expect(outbox.chats.length).toBeGreaterThan(0);
    expect(outbox.tasks.length).toBeGreaterThan(0);
    expect(outbox.emails.every((e) => /^Check in with /.test(e.subject))).toBe(true);
  });

  it('writes to the CX team by role', async () => {
    await start();
    const draft = { name: 'Team', subject: 'Heads up', body: 'Month-end is Friday.', audience: 'cx_team', filters: { roles: ['support_specialist'] }, channels: ['email'] };
    const b = await svc.create(draft, DIRECTOR);
    const run = await finish((await svc.send(b.id, 1, DIRECTOR)).id, DIRECTOR);
    expect(run.sent).toBe(1);
    expect(outbox.emails.map((e) => e.to)).toEqual([['support@example.com']]);
  });

  it('schedules, runs when due, advances to the next slot, and can be paused', async () => {
    await start();
    const b = await svc.create(CSM_DRAFT, DIRECTOR);
    await expectError(svc.schedule(b.id, { kind: 'monthly', dayOfMonth: 31, time: '08:00' }, DIRECTOR), 422);
    const s = await svc.schedule(b.id, { kind: 'weekly', dayOfWeek: 1, time: '08:00' }, DIRECTOR);
    expect(s.status).toBe('scheduled');
    expect(new Date(s.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(await svc.runDue()).toEqual({ started: 0, resumed: 0 });
    await db.query(`UPDATE broadcast SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [b.id]);
    expect(await svc.runDue()).toEqual({ started: 1, resumed: 0 });
    const runs = await svc.runs(b.id, DIRECTOR);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'completed' });
    const after = await svc.get(b.id, DIRECTOR);
    expect(after.status).toBe('scheduled');
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(await svc.runDue()).toMatchObject({ started: 0 }); // the same slot is never sent twice
    expect((await svc.pause(b.id, DIRECTOR)).status).toBe('paused');
    await db.query(`UPDATE broadcast SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [b.id]);
    expect((await svc.runDue()).started).toBe(0);
  });

  it('a one-off schedule is marked sent after it runs', async () => {
    await start();
    const b = await svc.create(CSM_DRAFT, DIRECTOR);
    await svc.schedule(b.id, { kind: 'once', runAt: new Date(Date.now() + 3_600_000).toISOString() }, DIRECTOR);
    // time passes: the slot is now in the past
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.query(`UPDATE broadcast SET next_run_at = $2::timestamptz, schedule = jsonb_build_object('kind', 'once', 'runAt', $3::text) WHERE id = $1`, [b.id, past, past]);
    await svc.runDue();
    expect((await svc.get(b.id, DIRECTOR)).status).toBe('sent');
  });

  it('resumes a run that stopped halfway: waiting messages go out, a half-sent one is failed, never repeated', async () => {
    await start();
    const b = await svc.create(CLIENT_DRAFT, ADMIN);
    const started = await svc.send(b.id, 6, ADMIN);
    await finish(started.id);
    const sentBefore = outbox.emails.length;
    // pretend the worker died: the run looks unfinished, one message was mid-send and one never started
    await db.query(`UPDATE broadcast_run SET status = 'running', finished_at = NULL WHERE id = $1`, [started.id]);
    const ids = (await db.query<{ id: string }>(`SELECT id FROM broadcast_recipient WHERE run_id = $1 AND status = 'sent' ORDER BY id DESC LIMIT 2`, [started.id])).rows.map((r) => r.id);
    await db.query(`UPDATE broadcast_recipient SET status = 'sending', sent_at = NULL, updated_at = now() - interval '1 hour' WHERE id = $1`, [ids[0]]);
    await db.query(`UPDATE broadcast_recipient SET status = 'pending', sent_at = NULL, updated_at = now() - interval '1 hour' WHERE id = $1`, [ids[1]]);
    expect((await svc.runDue()).resumed).toBe(1);
    const run = await finish(started.id);
    expect(run.status).toBe('completed');
    expect(outbox.emails.length - sentBefore).toBe(1); // only the one that never started
    expect(run.recipients.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(run.recipients.find((r) => r.status === 'failed')!.error).toMatch(/not retried/);
  });

  it('refuses a run with a limit breach', async () => {
    await start({ BROADCAST_MAX_RECIPIENTS: '3' });
    const p = await svc.preview(CLIENT_DRAFT, ADMIN);
    expect(p.limit).toBe(3);
    expect(p.warnings.join(' ')).toMatch(/limit|more than/i);
    const b = await svc.create(CLIENT_DRAFT, ADMIN);
    await expectError(svc.send(b.id, p.sendable, ADMIN), 409);
  });
});

describe('phase 4 broadcast API', () => {
  let app: INestApplication;
  const as = (email: string) => ({ authorization: `Bearer ${email}` });
  const http = () => request(app.getHttpServer());

  it('keeps broadcasts away from everyone but directors and super admins', async () => {
    await resetDatabase();
    app = await apiApp(testConfig({ BROADCAST_SEND_DELAY_MS: '0' }), new World(), new Outbox());
    const db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'), ('viewer@example.com', 'viewer'), ('ngozi.okafor@example.com', 'csm')`);
    await app.get(JobRunner).run('ingest', todayInLagos());

    await http().get('/broadcasts').set(as('viewer@example.com')).expect(403);
    await http().get('/broadcasts').set(as('ngozi.okafor@example.com')).expect(403);
    await http().get('/broadcasts').expect(401);
    expect((await http().get('/broadcasts/access').set(as('viewer@example.com')).expect(200)).body).toMatchObject({ allowed: false });
    await http().post('/broadcasts').set(as('director@example.com')).send({ ...CLIENT_DRAFT }).expect(403);
    const bad = await http().post('/broadcasts').set(as('admin@example.com')).send({ ...CLIENT_DRAFT, body: '{{nope}}' }).expect(422);
    expect(bad.body.message).toMatch(/Unknown token/);
    const created = await http().post('/broadcasts').set(as('admin@example.com')).send(CLIENT_DRAFT).expect(201);
    const preview = await http().post('/broadcasts/preview').set(as('admin@example.com')).send(CLIENT_DRAFT).expect(200);
    expect(preview.body.live).toBe(false); // default: dry run
    await http().post(`/broadcasts/${created.body.id}/send`).set(as('admin@example.com')).send({}).expect(400);
    await http().post(`/broadcasts/${created.body.id}/send`).set(as('admin@example.com')).send({ confirmCount: 1 }).expect(409);
    const sent = await http().post(`/broadcasts/${created.body.id}/send`).set(as('admin@example.com')).send({ confirmCount: preview.body.sendable }).expect(200);
    expect(sent.body.live).toBe(false);
    await app.close();
  });
});
