import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { todayInLagos } from '../../src/common/calendar.js';
import { Database } from '../../src/db/database.js';
import { CxService } from '../../src/cx/cx.service.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { FakeAi, Outbox, World, apiApp, resetDatabase, testConfig, workerApp } from './harness.js';

const DAY = '2026-11-03';
const AI_ON = { AI_FEATURES_ENABLED: 'true' };

describe('phase 4 CX tools against Postgres', () => {
  let app: TestingModule;
  let world: World;
  let ai: FakeAi;
  let db: Database;
  let cx: CxService;
  let jobs: JobRunner;

  async function start(env: Record<string, string> = AI_ON) {
    await resetDatabase();
    world = new World();
    ai = new FakeAi();
    app = await workerApp(testConfig({ ALERTS_DRY_RUN: 'true', ...env }), world, new Outbox(), undefined, ai);
    db = app.get(Database);
    await db.migrate();
    cx = app.get(CxService);
    jobs = app.get(JobRunner);
  }

  afterEach(async () => {
    await app?.close();
  });

  it('scores the tone of open tickets, ignoring ids it was not asked about', async () => {
    await start();
    ai.frustrated.add('T-1009');
    await jobs.run('ingest', DAY);
    const res = await cx.scoreSentiment();
    expect(res.scored).toBe(res.attempted);
    const { rows } = await db.query<{ ticket_id: string; sentiment: number }>('SELECT ticket_id, sentiment FROM ticket WHERE sentiment IS NOT NULL');
    expect(rows.find((r) => r.ticket_id === 'T-1009')!.sentiment).toBe(-2);
    expect(rows.some((r) => r.ticket_id === 'T-NOT-ASKED')).toBe(false);
    expect(rows.every((r) => !world.ticket(r.ticket_id).isClosed)).toBe(true); // closed tickets are not scored
    expect((await cx.scoreSentiment()).attempted).toBe(0); // already scored: nothing to do twice
  });

  it('raises a support escalation alert from a frustrated ticket and reopen counts', async () => {
    await start();
    ai.frustrated.add('T-1009');
    await jobs.run('daily', DAY);
    const flags = (await db.query<{ type: string; company_name: string }>(`SELECT type, company_name FROM audit_flag WHERE type = 'SUPPORT_ESCALATION_RISK' AND status = 'open'`)).rows;
    expect(flags.map((f) => f.company_name)).toContain('Abuja Tech Hub');
  });

  it('keeps working when Claude is down: no scores, no playbooks, nothing thrown', async () => {
    await start();
    ai.down = true;
    const out = (await jobs.run('daily', DAY)) as any;
    expect(out.sentiment.scored).toBe(0);
    expect(out.playbooks.written).toBe(0);
    expect(out.audit.findings).toBeGreaterThan(0);
  });

  it('does nothing with Claude while the feature switch is off', async () => {
    await start({ AI_FEATURES_ENABLED: 'false' });
    const out = (await jobs.run('daily', DAY)) as any;
    expect(out.sentiment).toEqual({ attempted: 0, scored: 0 });
    expect(out.playbooks).toEqual({ written: 0 });
    expect(ai.calls).toEqual({ playbook: 0, qbr: 0, clusters: 0, sentiment: 0 });
    await expect(cx.clusterTickets(DAY)).rejects.toThrow(/not enabled/);
  });

  it('writes one trimmed playbook per onboarding alert, and only once', async () => {
    await start();
    const out = (await jobs.run('daily', DAY)) as any;
    expect(out.playbooks.written).toBe(1);
    const flag = (await db.query<{ id: number }>(`SELECT id FROM audit_flag WHERE type = 'ONBOARDING_STAGNATION' AND status = 'open'`)).rows[0]!;
    const pb = (await cx.latestPlaybook(flag.id))!;
    expect(pb.content.steps.length).toBeLessThanOrEqual(6);
    expect(pb.content.likely_blockers.length).toBeLessThanOrEqual(4);
    expect(pb.content.summary).toContain('Abuja Tech Hub');
    expect(ai.lastPlaybookFacts!.openTickets.map((t) => t.subject)).toContain('Unable to configure payroll pay schedule');
    expect(JSON.stringify(ai.lastPlaybookFacts)).not.toContain('@'); // no personal data goes to Claude
    expect((await cx.writePlaybooks()).written).toBe(0);
    expect(ai.calls.playbook).toBe(1);
  });

  it('groups tickets into themes using only real ids, each ticket once, counts from code', async () => {
    await start();
    await jobs.run('ingest', DAY);
    const out = (await cx.clusterTickets(DAY))!;
    const known = new Set(world.tickets.map((t) => t.ticketId));
    const seen = new Set<string>();
    for (const t of out.content.themes) {
      expect(t.ticketCount).toBe(t.ticketIds.length);
      expect(t.ticketCount).toBeGreaterThan(0);
      for (const id of t.ticketIds) {
        expect(known.has(id)).toBe(true);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(out.content.themes.map((t) => t.name)).not.toContain('Ghost theme');
    expect(out.content.themes.length).toBeLessThanOrEqual(5);
    expect(out.content.themes[0]!.ticketCount).toBeGreaterThanOrEqual(out.content.themes.at(-1)!.ticketCount);
    expect((await cx.latestClusters())!.id).toBe(out.id);
    // what was sent to Claude carried no personal data
    expect(JSON.stringify(ai.lastTickets)).not.toMatch(/@/);
  });

  it('drafts a QBR from verified facts, capped at eight slides, without contact details', async () => {
    await start();
    await jobs.run('ingest', DAY);
    const out = (await cx.qbr('1003', DAY, 'director@example.com'))!;
    expect(out.content.slides.length).toBeLessThanOrEqual(8);
    expect(out.content.slides.every((s) => s.bullets.length <= 5)).toBe(true);
    expect(JSON.stringify(ai.lastQbrFacts)).not.toContain('@');
    expect((ai.lastQbrFacts!.company as { name: string }).name).toBe('Kano Holdings Group');
    expect((await cx.latestQbr('1003'))!.id).toBe(out.id);
    expect(await cx.qbr('nope', DAY, 'director@example.com')).toBeNull();
    ai.down = true;
    expect(await cx.qbr('1003', DAY, 'director@example.com')).toBeNull();
  });

  it('puts the 90-day scorecard and radar together from the snapshot', async () => {
    await start();
    await jobs.run('ingest', DAY);
    const sc = (await cx.scorecard(DAY))!;
    expect(sc.asOf).toBe(DAY);
    expect(JSON.stringify(sc)).toContain('Abuja Tech Hub');
    const radar = (await cx.radar(DAY))!;
    expect(radar.entries.length).toBeGreaterThan(0);
    expect(await cx.radar('2020-01-01')).toBeNull();
  });

  it('finds seat growth over the window when there is history', async () => {
    await start();
    await jobs.run('ingest', '2026-08-05');
    world.account('CP-100').activeUsers = Math.ceil(world.account('CP-100').activeUsers * 1.5);
    await jobs.run('ingest', DAY);
    const radar = (await cx.radar(DAY))!;
    const entry = radar.entries.find((e) => e.hubspotId === '1001')!;
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toMatch(/seat/i);
  });
});

describe('phase 4 CX API', () => {
  let app: INestApplication;
  let ai: FakeAi;
  const as = (email: string) => ({ authorization: `Bearer ${email}` });
  const http = () => request(app.getHttpServer());

  async function start(env: Record<string, string> = AI_ON) {
    await resetDatabase();
    ai = new FakeAi();
    app = await apiApp(testConfig({ ALERTS_DRY_RUN: 'true', ...env }), new World(), new Outbox(), ai);
    const db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('director@example.com', 'cs_director'), ('viewer@example.com', 'viewer'),
      ('ngozi.okafor@example.com', 'csm'), ('tunde.bello@example.com', 'csm'), ('support@example.com', 'support_specialist'), ('impl@example.com', 'implementation_manager')`);
    await app.get(JobRunner).run('ingest', todayInLagos());
  }

  afterEach(async () => {
    await app?.close();
  });

  it('shows a CSM only their own accounts on the radar, and refuses other roles', async () => {
    await start();
    const all = (await http().get('/cx/radar').set(as('director@example.com')).expect(200)).body.entries as Array<{ csmEmail: string }>;
    const mine = (await http().get('/cx/radar').set(as('ngozi.okafor@example.com')).expect(200)).body.entries as Array<{ csmEmail: string }>;
    expect(mine.every((e) => e.csmEmail === 'ngozi.okafor@example.com')).toBe(true);
    expect(mine.length).toBeLessThanOrEqual(all.length);
    await http().get('/cx/radar').set(as('support@example.com')).expect(403);
    await http().get('/cx/scorecard').set(as('impl@example.com')).expect(200);
    await http().get('/cx/scorecard').set(as('ngozi.okafor@example.com')).expect(403);
    await http().get('/cx/radar?date=nonsense').set(as('director@example.com')).expect(400);
  });

  it('lets support run clustering, and only a director draft a QBR for any account', async () => {
    await start();
    const run = await http().post('/cx/clusters/run').set(as('support@example.com')).expect(200);
    expect(run.body.content.themes.length).toBeGreaterThan(0);
    await http().get('/cx/clusters').set(as('ngozi.okafor@example.com')).expect(403);
    expect((await http().get('/cx/clusters').set(as('support@example.com')).expect(200)).body.aiEnabled).toBe(true);
    await http().post('/cx/accounts/1003/qbr').set(as('director@example.com')).expect(200);
    await http().post('/cx/accounts/1003/qbr').set(as('viewer@example.com')).expect(403);
  });

  it('lets a CSM draft a QBR only for an account they own', async () => {
    await start();
    // 1001 belongs to one CSM and 1003 to the other; whichever the fixture assigns, the other CSM must get 404
    const res = await http().get('/analytics/portfolio').set(as('director@example.com'));
    expect(res.status).toBeLessThan(500);
    const owner = await Promise.all(['ngozi.okafor@example.com', 'tunde.bello@example.com'].map(async (e) => ({ e, s: (await http().post('/cx/accounts/1001/qbr').set(as(e))).status })));
    expect(owner.map((o) => o.s).sort()).toEqual([200, 404]);
  });

  it('reports a clear error when Claude is off', async () => {
    await start({ AI_FEATURES_ENABLED: 'false' });
    await http().post('/cx/clusters/run').set(as('support@example.com')).expect(503);
    expect((await http().get('/cx/clusters').set(as('support@example.com')).expect(200)).body).toMatchObject({ aiEnabled: false, latest: null });
  });
});
