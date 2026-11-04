import type { TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { Outbox, World, resetDatabase, testConfig, workerApp } from './harness.js';

/**
 * US-16 end to end: alerts sent on Tuesday 3 Nov 2026, escalated on Friday 6 Nov
 * (3 business days), then to directors on Tuesday 10 Nov (2 more business days).
 */
describe('escalation against Postgres', () => {
  let app: TestingModule;
  let db: Database;
  let jobs: JobRunner;
  let outbox: Outbox;

  const flagId = async (type: string, company: string) =>
    Number((await db.query('SELECT id FROM audit_flag WHERE type = $1 AND company_name = $2', [type, company])).rows[0]!.id);

  beforeEach(async () => {
    await resetDatabase();
    outbox = new Outbox();
    app = await workerApp(testConfig(), new World(), outbox);
    db = app.get(Database);
    await db.migrate();
    jobs = app.get(JobRunner);
    await db.query(`INSERT INTO app_user (email, role) VALUES ('director@example.com', 'cs_director'), ('director2@example.com', 'cs_director')`);
    await db.query(`INSERT INTO csm_team (csm_email, team_lead_email) VALUES ('tunde.bello@example.com', 'lead@example.com')`);

    await jobs.run('daily', '2026-11-03');
    // These scenarios are about billing and engagement alerts, so support SLA alerts start out handled.
    await db.query(`UPDATE audit_flag SET acknowledged_at = now(), acknowledged_by = 'test' WHERE type = 'SUPPORT_SLA_BREACH'`);
    // Pin the clock: every alert went out at 05:00 WAT on Tuesday 3 Nov.
    await db.query(`UPDATE audit_flag SET notified_at = '2026-11-03T05:00:00+01:00' WHERE notified_at IS NOT NULL`);
    outbox.emails = [];
    outbox.chats = [];
  });

  afterEach(async () => {
    await app?.close();
  });

  it('waits 3 business days, then goes to the team lead, or straight to directors when there is none', async () => {
    // Kano's overage is acknowledged; Ibadan's drought is acknowledged but nobody called them.
    await db.query(`UPDATE audit_flag SET acknowledged_at = now(), acknowledged_by = 'tunde' WHERE id = ANY($1)`, [
      [await flagId('SEAT_OVERAGE', 'Kano Holdings Group'), await flagId('ENGAGEMENT_DROUGHT', 'Ibadan Clinics')],
    ]);

    const thursday = (await jobs.run('escalate', '2026-11-05')) as any;
    expect(thursday.escalate).toMatchObject({ toLeads: 0, toDirectors: 0 });
    expect(outbox.emails).toHaveLength(0);

    const friday = (await jobs.run('escalate', '2026-11-06')) as any;
    // Lead: Ibadan drought (high, acknowledged but no contact logged).
    // Directors: Lekki ARR + late payroll (Ngozi has no lead), Enugu broken link + drought (no CSM).
    expect(friday.escalate).toMatchObject({ toLeads: 1, toDirectors: 4, failed: 0 });

    const toLead = outbox.emails.filter((e) => e.to.includes('lead@example.com'));
    expect(toLead).toHaveLength(1);
    expect(toLead[0]!.subject).toBe('Escalation: 1 alert for tunde.bello@example.com needs follow-up');
    expect(toLead[0]!.text).toContain('Ibadan Clinics: No contact within the limit');
    expect(toLead[0]!.text).toContain('Open 3 business days, acknowledged, but no call, meeting or email logged yet.');
    expect(toLead[0]!.text).not.toContain('Kano'); // acknowledged, so handled

    const toDirectors = outbox.emails.filter((e) => e.to.includes('director@example.com'));
    expect(toDirectors.map((e) => e.to)).toEqual([
      ['director2@example.com', 'director@example.com'],
      ['director2@example.com', 'director@example.com'],
    ]);
    expect(toDirectors.map((e) => e.subject).sort()).toEqual([
      'Director escalation: 2 alerts for ngozi.okafor@example.com (no team lead on record)',
      'Director escalation: 2 alerts on accounts with no CSM',
    ]);
    const noLead = toDirectors.find((e) => e.subject.includes('no team lead'))!;
    expect(noLead.text).toContain('has no team lead on record, so they come straight to you');
    expect(noLead.text).not.toContain('were escalated to their team lead');
    expect(noLead.text).toContain('Open 3 business days, not acknowledged.');
    expect(outbox.chats.every((c) => c.text.startsWith('⏫'))).toBe(true);

    // Low and medium flags never escalate.
    const { rows: levels } = await db.query(`SELECT severity, max(escalation_level) AS lvl FROM audit_flag GROUP BY severity ORDER BY severity`);
    expect(Object.fromEntries(levels.map((r) => [r.severity, r.lvl]))).toEqual({ high: 2, low: 0, medium: 0, urgent: 2 });

    // Running the sweep again the same day sends nothing new.
    const before = outbox.emails.length;
    await jobs.run('escalate', '2026-11-06');
    expect(outbox.emails).toHaveLength(before);

    const log = await db.query(`SELECT count(*)::int AS n FROM action_log WHERE action = 'flag.escalate'`);
    expect(log.rows[0]!.n).toBe(5);
  });

  it('moves from team lead to directors after 2 more business days', async () => {
    await db.query(`UPDATE audit_flag SET acknowledged_at = now() WHERE csm_email IS DISTINCT FROM 'tunde.bello@example.com'`);
    await jobs.run('escalate', '2026-11-06');
    outbox.emails = [];

    expect(((await jobs.run('escalate', '2026-11-09')) as any).escalate.toDirectors).toBe(0); // Mon: 1 day
    const tuesday = (await jobs.run('escalate', '2026-11-10')) as any; // Tue: 2 days
    expect(tuesday.escalate).toMatchObject({ toLeads: 0, toDirectors: 2 });
    expect(outbox.emails[0]!.subject).toBe('Director escalation: 2 alerts for tunde.bello@example.com still unhandled after team lead');
    expect(outbox.emails[0]!.text).toContain('were escalated to their team lead and are still unhandled');
  });

  it('logging contact resolves a drought before it escalates', async () => {
    const world = new World();
    world.company('1004').lastActivityDate = '2026-11-04'; // Ibadan called on Wednesday
    world.company('1005').lastActivityDate = '2026-11-04';
    world.company('1003').lastActivityDate = '2026-11-04';
    await app.close();
    app = await workerApp(testConfig(), world, outbox);
    db = app.get(Database);
    jobs = app.get(JobRunner);
    await jobs.run('daily', '2026-11-05');

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_flag WHERE type = 'ENGAGEMENT_DROUGHT' AND status = 'open'`);
    expect(rows[0]!.n).toBe(0);
    outbox.emails = [];
    const friday = (await jobs.run('escalate', '2026-11-06')) as any;
    // Kano's seat overage still escalates; no drought does.
    expect(friday.escalate.toLeads).toBe(1);
    const toLead = outbox.emails.find((e) => e.to.includes('lead@example.com'))!;
    expect(toLead.text).toContain('Kano Holdings Group: More users than paid seats');
    expect(toLead.text).not.toContain('No contact within the limit');
  });

  it('keeps retrying when an escalation cannot be delivered', async () => {
    outbox.failChatTimes = 100;
    outbox.email.send = async () => {
      throw new Error('SMTP down');
    };
    const res = (await jobs.run('escalate', '2026-11-06')) as any;
    expect(res.escalate).toMatchObject({ toLeads: 0, toDirectors: 0, failed: 6 });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_flag WHERE escalation_level > 0`);
    expect(rows[0]!.n).toBe(0);
  });
});
