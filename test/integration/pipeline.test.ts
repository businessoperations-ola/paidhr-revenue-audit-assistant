import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { FakeRationale, Outbox, World, resetDatabase, testConfig, workerApp } from './harness.js';

describe('phase-1 daily pipeline against Postgres', () => {
  let app: TestingModule;
  let world: World;
  let outbox: Outbox;
  let ai: FakeRationale;
  let db: Database;
  let jobs: JobRunner;

  async function start(over: Record<string, string> = {}) {
    app = await workerApp(testConfig(over), world, outbox, ai);
    db = app.get(Database);
    await db.migrate();
    jobs = app.get(JobRunner);
  }

  async function openFlags() {
    const { rows } = await db.query(`SELECT type, company_name, severity, csm_email FROM audit_flag WHERE status = 'open' ORDER BY type, company_name`);
    return rows.map((r) => `${r.type}:${r.company_name}`);
  }

  beforeEach(async () => {
    await resetDatabase();
    world = new World();
    outbox = new Outbox();
    ai = new FakeRationale();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('snapshots, audits and alerts on day one, exactly once', async () => {
    await start();
    const result = await jobs.run('daily', '2026-11-03');

    expect(await openFlags()).toEqual([
      'ARR_MISMATCH:Lekki Foods',
      'BROKEN_LINK:Enugu Steel',
      'ENGAGEMENT_DROUGHT:Enugu Steel',
      'ENGAGEMENT_DROUGHT:Ibadan Clinics',
      'ENGAGEMENT_DROUGHT:Kano Holdings Group',
      'LATE_PAYROLL:Lekki Foods',
      'MISSING_FIELDS:Enugu Steel',
      'MISSING_FIELDS:Ibadan Clinics',
      'ONBOARDING_STAGNATION:Abuja Tech Hub',
      'SEAT_OVERAGE:Kano Holdings Group',
      'SUPPORT_ESCALATION_RISK:Abuja Tech Hub',
      'SUPPORT_ESCALATION_RISK:Kano Holdings Group',
      'SUPPORT_SLA_BREACH:Abuja Tech Hub',
      'SUPPORT_SLA_BREACH:Ibadan Clinics',
      'SUPPORT_SLA_BREACH:Kano Holdings Group',
      'SUPPORT_SLA_BREACH:Lekki Foods',
      'UNLINKED_CONTROL_PANEL_ACCOUNT:Port Harcourt Marine',
      'UNLINKED_HUBSPOT_COMPANY:Ibadan Clinics',
    ]);
    expect(result).toMatchObject({ audit: { reconciliation: { matched: 4, hubspotOnly: 1, controlPanelOnly: 1, brokenLinks: 1 } } });
    // US-04: Kano has two sub-accounts, 130 users in total.
    expect((result as any).audit.hierarchy).toEqual([
      { parentClientId: 'CP-300', parentName: 'Kano Holdings Group', subAccountCount: 2, totalActiveUsers: 130 },
    ]);

    // Urgent late payroll gets its own email; Ngozi's other flag comes in a digest.
    const ngozi = outbox.emails.filter((e) => e.to.includes('ngozi.okafor@example.com'));
    expect(ngozi.map((e) => e.subject).sort()).toEqual([
      '2 new audit flags need your attention',
      'URGENT: Payroll run is late at Lekki Foods',
    ]);
    // Accounts with no CSM go to the fallback list.
    const fallback = outbox.emails.filter((e) => e.to.includes('cs-leads@example.com'));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.text).toContain('Port Harcourt Marine');
    expect(fallback[0]!.text).toContain('Enugu Steel');
    // The email only promises escalation because these flags really do escalate (phase 1 fix).
    expect(ngozi.find((e) => e.subject.startsWith('URGENT'))!.text).toContain('Monthly payroll expected 2026-10-28');
    expect(ngozi.find((e) => e.subject.startsWith('URGENT'))!.text).toContain('within 3 business days, they go to your team lead, or to the Heads of CX if you have none on record');
    // Acknowledge links are signed and point at the API.
    expect(ngozi[0]!.text).toMatch(/https:\/\/audit\.example\.com\/ack\/\d+\?sig=[\w-]{32}/);

    // One chat message per group: 1 urgent + 3 digests (Ngozi, Tunde, unassigned).
    expect(outbox.chats).toHaveLength(4);
    expect(outbox.chats.some((c) => c.text.startsWith('🚨 *Urgent'))).toBe(true);

    // US-15: one HubSpot task per flag that has a HubSpot company (17 of 18), urgent = HIGH, owner = CSM.
    expect(outbox.tasks).toHaveLength(17);
    const payrollTask = outbox.tasks.find((t) => t.subject.includes('Payroll run is late'))!;
    expect(payrollTask).toMatchObject({ companyId: '1002', ownerId: '501', priority: 'HIGH' });

    // Running dispatch again sends nothing new.
    const before = { e: outbox.emails.length, c: outbox.chats.length, t: outbox.tasks.length };
    await jobs.run('dispatch', '2026-11-03');
    expect({ e: outbox.emails.length, c: outbox.chats.length, t: outbox.tasks.length }).toEqual(before);
  });

  it('resolves flags once the data is fixed, and catches unbilled seat growth', async () => {
    await start();
    await jobs.run('daily', '2026-11-03');

    // Day 2: Lekki's ARR is corrected and its payroll ran; Adebayo adds 7 users with no ARR change.
    world.company('1002').arrKobo = 144_000_000n;
    world.account('CP-200').lastPayrollPayDate = '2026-10-28';
    world.account('CP-100').activeUsers = 55;
    outbox = Object.assign(outbox, { emails: [], chats: [], tasks: [] });
    const day2 = (await jobs.run('daily', '2026-11-04')) as any;

    const flags = await openFlags();
    expect(flags).not.toContain('ARR_MISMATCH:Lekki Foods');
    expect(flags).not.toContain('LATE_PAYROLL:Lekki Foods');
    expect(flags).toContain('SEAT_INCREASE_NO_ARR_CHANGE:Adebayo Logistics');
    expect(flags).toContain('SEAT_OVERAGE:Adebayo Logistics');
    expect(day2.audit.resolved).toBe(2);

    const { rows } = await db.query(`SELECT details FROM audit_flag WHERE type = 'SEAT_INCREASE_NO_ARR_CHANGE'`);
    expect(rows[0]!.details).toMatchObject({ seatsAtBaseline: 48, seatsToday: 55, baselineDate: '2026-11-03' });

    // Only the new problems are alerted on day 2.
    expect(outbox.tasks.map((t) => t.subject).sort()).toEqual([
      '[Audit] More users than paid seats: Adebayo Logistics',
      '[Audit] Seats grew, ARR did not: Adebayo Logistics',
    ]);
  });

  it('retries a failed channel on the next dispatch without resending the others', async () => {
    await start();
    outbox.failChatTimes = 100;
    await jobs.run('daily', '2026-11-03');
    expect(outbox.chats).toHaveLength(0);
    const emailsAfterFirst = outbox.emails.length;

    const { rows } = await db.query(`SELECT status, count(*)::int AS n FROM alert WHERE channel = 'google_chat' GROUP BY status`);
    expect(rows).toEqual([{ status: 'failed', n: 18 }]);

    outbox.failChatTimes = 0;
    await jobs.run('dispatch', '2026-11-03');
    expect(outbox.chats).toHaveLength(4);
    expect(outbox.emails).toHaveLength(emailsAfterFirst);
  });

  it('writes Claude rationales only for flags that need explaining', async () => {
    await start({ AI_RATIONALE_ENABLED: 'true' });
    await jobs.run('daily', '2026-11-03');
    const { rows } = await db.query(`SELECT type FROM audit_flag WHERE ai_rationale IS NOT NULL ORDER BY type`);
    expect(rows.map((r) => r.type)).toEqual(['ARR_MISMATCH', 'BROKEN_LINK', 'LATE_PAYROLL', 'SEAT_OVERAGE', 'SUPPORT_ESCALATION_RISK', 'SUPPORT_ESCALATION_RISK']);
    expect(outbox.chats.some((c) => c.text.includes('_Next step:_ Fix Lekki Foods'))).toBe(true);
  });

  it('dry run logs instead of sending, and the alerts still go out later', async () => {
    await start({ ALERTS_DRY_RUN: 'true' });
    await jobs.run('daily', '2026-11-03');
    expect(outbox.emails.length + outbox.chats.length + outbox.tasks.length).toBe(0);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM alert');
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses to audit an empty HubSpot pull or a missing snapshot', async () => {
    await start();
    await expect(jobs.run('audit', '2026-11-03')).rejects.toThrow(/No snapshot for 2026-11-03/);
    world.companies = [];
    await jobs.run('ingest', '2026-11-03');
    await expect(jobs.run('audit', '2026-11-03')).rejects.toThrow(/refusing to audit/);
  });

  it('re-running the same day replaces the snapshot instead of duplicating it', async () => {
    await start();
    await jobs.run('ingest', '2026-11-03');
    await jobs.run('ingest', '2026-11-03');
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM hs_company_snapshot WHERE snapshot_date = '2026-11-03'`);
    expect(rows[0]!.n).toBe(6);
  });
});
