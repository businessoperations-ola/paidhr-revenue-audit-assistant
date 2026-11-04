import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsService } from '../../src/analytics/analytics.service.js';
import { Database } from '../../src/db/database.js';
import type { HubSpotCompany } from '../../src/domain/types.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { ReportBuilder } from '../../src/reports/report-builder.js';
import { ReportService } from '../../src/reports/report.service.js';
import type { Section } from '../../src/reports/report-types.js';
import { Outbox, World, apiApp, resetDatabase, testConfig, workerApp } from './harness.js';

const N = (naira: number) => BigInt(naira) * 100n;

const IKEJA: HubSpotCompany = {
  hubspotId: '1007', name: 'Ikeja Retail', domain: null, controlPanelId: null, csmName: 'Ngozi Okafor', csmEmail: 'ngozi.okafor@example.com',
  csmOwnerId: '501', industry: 'Retail', contractEndDate: '2027-09-01', seatTier: '10-24', paidSeats: 20, arrKobo: N(600_000),
  pricePerSeatMonthlyKobo: N(2_500), healthStatus: 'Neutral', lastActivityDate: '2026-11-08', primaryContactEmail: 'hr@ikeja.example',
};

/**
 * Two snapshots, nine days apart (1 and 10 November 2026), with every kind of movement:
 * Adebayo renews early and grows, Kano contracts, Enugu leaves, Ikeja joins.
 */
async function buildHistory(world: World, jobs: JobRunner) {
  // --- day 1
  world.company('1001').contractEndDate = '2026-11-15'; // Adebayo is due to renew
  world.company('1004').contractEndDate = '2026-11-08'; // Ibadan's contract expires and is not renewed
  world.revenue = world.revenue.map((l, i) => ({ ...l, revenueDate: `2026-11-0${(i % 8) + 1}` }));
  for (const [id, day] of [['T-1001', '03'], ['T-1002', '04'], ['T-1012', '05'], ['T-1003', '06']] as const) world.ticket(id).createdAt = `2026-11-${day}T10:00:00Z`;
  await jobs.run('baseline', '2026-11-01'); // snapshots the day and locks each CSM's ARR for 2026
  // --- day 10
  world.company('1001').contractEndDate = '2027-11-15';
  world.company('1001').arrKobo = N(1_650_000);
  world.company('1003').arrKobo = N(2_000_000);
  world.companies = world.companies.filter((c) => c.hubspotId !== '1005');
  world.companies.push(structuredClone(IKEJA));
  world.account('CP-100').activeUsers = 60;
  await jobs.run('ingest', '2026-11-10');
}

describe('phase 3 analytics against Postgres', () => {
  let app: TestingModule;
  let world: World;
  let outbox: Outbox;
  let jobs: JobRunner;
  let analytics: AnalyticsService;
  let db: Database;

  beforeEach(async () => {
    await resetDatabase();
    world = new World();
    outbox = new Outbox();
    app = await workerApp(testConfig(), world, outbox);
    db = app.get(Database);
    await db.migrate();
    jobs = app.get(JobRunner);
    analytics = app.get(AnalyticsService);
    await buildHistory(world, jobs);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('US-09 bridges ARR between two days and ties out exactly', async () => {
    const p = (await analytics.period('2026-11-01', '2026-11-30'))!;
    expect(p.coverage).toEqual({ requestedFrom: '2026-11-01', requestedTo: '2026-11-30', from: '2026-11-01', to: '2026-11-10', partial: true });
    const b = p.bridge;
    expect(b).toMatchObject({ startKobo: N(6_840_000), newKobo: N(600_000), expansionKobo: N(150_000), partialChurnKobo: N(400_000), fullChurnKobo: N(900_000), endKobo: N(6_290_000) });
    expect(b.startKobo + b.newKobo + b.expansionKobo - b.partialChurnKobo - b.fullChurnKobo).toBe(b.endKobo);
    expect(b.fullChurn.map((c) => c.name)).toEqual(['Enugu Steel']);
    expect(b.partialChurn.map((c) => c.name)).toEqual(['Kano Holdings Group']);
  });

  it('US-11 counts renewals due in the period, the renewal rate, net renewal and turnaround', async () => {
    const r = (await analytics.period('2026-11-01', '2026-11-30'))!.renewals;
    // Adebayo renewed (due 15 Nov, signed 10 Nov); Ibadan expired 8 Nov unrenewed. Enugu expires 30 Nov, after
    // the last snapshot, so its outcome is not known yet and it is left out rather than counted as lost.
    expect(r).toMatchObject({ eligible: 2, renewed: 1, renewalRatePct: 50, netRenewalPct: 107.58, avgTurnaroundDays: -5 });
    expect(r.details.find((d) => d.hubspotId === '1001')).toMatchObject({ expiry: '2026-11-15', detectedOn: '2026-11-10', turnaroundDays: -5 });
    expect(r.details.map((d) => d.hubspotId).sort()).toEqual(['1001', '1004']);
    expect(r.names['1004']).toBe('Ibadan Clinics');
  });

  it('US-07 and US-12 give expansion revenue with the EWA + statutory share, and the busiest support clients', async () => {
    const p = (await analytics.period('2026-11-01', '2026-11-30'))!;
    expect(p.expansionAvailable).toBe(true);
    expect(p.expansion).toMatchObject({ totalKobo: N(1_900_000), monetizedKobo: N(940_000), monetizedPct: 49.5 });
    expect(p.topTicketClients).toEqual([{ hubspotId: '1003', name: 'Kano Holdings Group', count: 3 }, { hubspotId: '1001', name: 'Adebayo Logistics', count: 1 }]);
    expect(p.ticketsCreated).toBe(4);
  });

  it('US-19, 10, 06 and 08 describe the portfolio on a day', async () => {
    const pf = (await analytics.portfolio('2026-11-10'))!;
    expect(pf).toMatchObject({ asOf: '2026-11-10', customers: 6, totalArrKobo: N(6_290_000), arrAtRiskKobo: N(480_000), arrAtRiskPct: 7.6 });
    expect(pf.health.map((h) => [h.status, h.count, h.pct])).toEqual([['Healthy', 2, 33.3], ['Neutral', 3, 50], ['At Risk', 1, 16.7]]);
    expect(pf.contractors.total).toBe(28); // 3 + (5 + 10 + 8) + 2
    expect(pf.contractors.byParent[0]).toMatchObject({ parentName: 'Kano Holdings Group', contractors: 23, subAccounts: 2 });
    expect(pf.adoption.base).toBe(5);
    expect(pf.adoption.ewa.map((w) => w.users)).toEqual([2, 3, 3]);
    expect(pf.adoption.statutory.map((w) => w.users)).toEqual([2, 3, 3]);
  });

  it('US-18 locks the start-of-year baseline and measures each CSM against it', async () => {
    const l = (await analytics.ledger(2026, '2026-11-10'))!;
    expect(l.baselineDate).toBe('2026-11-01');
    expect(l.rows.map((r) => [r.csmEmail, r.baselineKobo, r.currentKobo, r.deltaKobo, r.deltaPct])).toEqual([
      ['ngozi.okafor@example.com', N(2_700_000), N(3_450_000), N(750_000), 27.78],
      ['tunde.bello@example.com', N(3_240_000), N(2_840_000), -N(400_000), -12.35],
      ['(unassigned)', N(900_000), 0n, -N(900_000), -100],
    ]);
    expect(l.totals).toMatchObject({ baselineKobo: N(6_840_000), currentKobo: N(6_290_000), deltaKobo: -N(550_000) });
  });

  it('never changes a baseline once written, even if the job is run again later', async () => {
    const again = await analytics.captureBaseline(2026, '2026-11-10');
    expect(again).toEqual({ created: 0, existing: 2 }); // Enugu, the only unassigned account, is gone by day 10
    const { rows } = await db.query(`SELECT baseline_arr_kobo FROM csm_arr_baseline WHERE year = 2026 AND csm_email = 'ngozi.okafor@example.com'`);
    expect(rows[0]!.baseline_arr_kobo).toBe(N(2_700_000).toString());
    const log = await db.query(`SELECT count(*)::int AS n FROM action_log WHERE action = 'baseline.capture'`);
    expect(log.rows[0]!.n).toBe(2);
    // A new year starts its own baselines.
    expect(await analytics.captureBaseline(2027, '2026-11-10')).toEqual({ created: 2, existing: 0 });
  });

  it('refuses to write baselines from an empty snapshot', async () => {
    await expect(analytics.captureBaseline(2030, '2030-01-01')).rejects.toThrow(/refusing/);
    world.companies = [];
    await jobs.run('ingest', '2026-11-11');
    await expect(analytics.captureBaseline(2030, '2026-11-11')).rejects.toThrow(/refusing/);
  });

  it('returns nothing, not zeros, before there is data or a baseline', async () => {
    expect(await analytics.portfolio('2020-01-01')).toBeNull();
    expect(await analytics.period('2020-01-01', '2020-01-31')).toBeNull();
    expect(await analytics.ledger(2019, '2026-11-10')).toBeNull();
  });

  it('keeps going when expansion revenue or tickets cannot be loaded, and says so', async () => {
    // Simulate an old Control Panel view: the revenue query fails. The ingestion run still succeeds.
    const ingestion = app.get((await import('../../src/ingestion/ingestion.service.js')).IngestionService);
    const source = (ingestion as any).controlPanel as { fetchRevenueLines: () => Promise<unknown> };
    const original = source.fetchRevenueLines;
    source.fetchRevenueLines = async () => {
      throw new Error('relation "audit.v_revenue_lines" does not exist');
    };
    const res = await jobs.run('ingest', '2026-11-12');
    source.fetchRevenueLines = original;
    expect((res as any).ingest.warnings).toEqual(['Expansion revenue not loaded: relation "audit.v_revenue_lines" does not exist']);
    const { rows } = await db.query(`SELECT status, counts FROM ingestion_run WHERE snapshot_date = '2026-11-12'`);
    expect(rows[0]).toMatchObject({ status: 'succeeded' });
    expect(rows[0]!.counts.warnings).toHaveLength(1);
  });
});

describe('US-25 reports against Postgres', () => {
  let app: TestingModule;
  let world: World;
  let outbox: Outbox;
  let jobs: JobRunner;
  let db: Database;
  let reports: ReportService;
  let builder: ReportBuilder;

  const section = <K extends Section['kind']>(r: { sections: Section[] }, kind: K, heading?: string) =>
    r.sections.find((s) => s.kind === kind && (heading === undefined || ('heading' in s && s.heading === heading))) as Extract<Section, { kind: K }>;

  async function start(over: Record<string, string> = {}) {
    await resetDatabase();
    world = new World();
    outbox = new Outbox();
    app = await workerApp(testConfig(over), world, outbox);
    db = app.get(Database);
    await db.migrate();
    jobs = app.get(JobRunner);
    reports = app.get(ReportService);
    builder = app.get(ReportBuilder);
    await buildHistory(world, jobs);
    await jobs.run('audit', '2026-11-10');
    await db.query(`INSERT INTO app_user (email, role) VALUES
      ('director@example.com', 'cs_director'), ('viewer@example.com', 'viewer'), ('ngozi.okafor@example.com', 'csm'),
      ('impl@example.com', 'implementation_manager'), ('support@example.com', 'support_specialist')`);
  }

  afterEach(async () => {
    await app?.close();
  });

  it('builds the leadership report from real numbers, with the ARR bridge and where ARR was lost', async () => {
    await start();
    const r = (await builder.build('executive', 'weekly', '2026-11-10'))!;
    expect(r.title).toBe('Weekly leadership report');
    const kpis = section(r, 'kpis');
    expect(kpis.items[0]).toMatchObject({ label: 'Total ARR', value: '₦6,290,000.00', note: '6 customers' });
    expect(kpis.items[1]).toMatchObject({ label: 'ARR at risk', value: '₦480,000.00' });
    const bridge = section(r, 'bridge');
    expect(bridge.steps.map((s) => [s.type, s.value])).toEqual([
      ['start', '₦6,840,000.00'], ['up', '+₦600,000.00'], ['up', '+₦150,000.00'], ['down', '-₦400,000.00'], ['down', '-₦900,000.00'], ['end', '₦6,290,000.00'],
    ]);
    expect(section(r, 'table', 'Where ARR was lost').rows).toEqual([['Lost', 'Enugu Steel', '₦900,000.00'], ['Contraction', 'Kano Holdings Group', '₦400,000.00']]);
    expect(section(r, 'table', 'Module adoption: accounts that used it in the last…').rows[0]).toEqual(['Earned Wage Access', '40% (2 of 5)', '60% (3 of 5)', '60% (3 of 5)']);
    expect(section(r, 'table', 'Open alerts by type').rows.length).toBeGreaterThan(0);
    const ledger = section(r, 'table', 'ARR by CSM since 1 Nov 2026');
    expect(ledger.rows.at(-1)).toEqual(['Total', '₦6,840,000.00', '₦6,290,000.00', '-₦550,000.00', '-8%']);
    expect(r.sections.some((s) => s.kind === 'notice' && /Only part/.test(s.text))).toBe(false); // history covers the whole week
  });

  it('keeps the daily leadership report short: no ARR bridge, just what needs attention', async () => {
    await start();
    const r = (await builder.build('executive', 'daily', '2026-11-10'))!;
    expect(r.sections.some((s) => s.kind === 'bridge')).toBe(false);
    expect(section(r, 'table', 'Alerts needing attention')).toBeDefined();
  });

  it("gives each CSM only their own portfolio, alerts and opportunities, never a colleague's", async () => {
    await start();
    const r = (await builder.build('csm', 'weekly', '2026-11-10', 'Ngozi.Okafor@example.com'))!;
    const text = JSON.stringify(r);
    expect(text).toContain('Adebayo Logistics');
    expect(text).toContain('Ikeja Retail');
    for (const other of ['Kano Holdings', 'Ibadan Clinics', 'Abuja Tech Hub']) expect(text).not.toContain(other);
    expect(section(r, 'kpis').items[0]).toMatchObject({ label: 'My ARR', value: '₦3,450,000.00', note: '3 accounts' });
    expect(section(r, 'kpis').items.at(-1)).toMatchObject({ label: 'Since 1 Nov 2026', value: '+₦750,000.00' });
    expect(section(r, 'table', 'My accounts').rows.map((row) => row[0])).toEqual(['Lekki Foods', 'Ikeja Retail', 'Adebayo Logistics']); // At Risk first, then by health and ARR
    await expect(builder.build('csm', 'weekly', '2026-11-10')).rejects.toThrow(/needs a CSM email/);
  });

  it('builds the implementation and support reports', async () => {
    await start();
    const impl = (await builder.build('implementation', 'weekly', '2026-11-10'))!;
    expect(section(impl, 'kpis').items.map((i) => i.label)).toEqual(['Accounts onboarding', 'Time to first payroll', 'First payroll completed', 'Payroll set up']);
    expect(section(impl, 'table', 'Stalled onboardings').rows[0]).toEqual(['Abuja Tech Hub', '29', 'tunde.bello@example.com', 'No playbook yet']);
    const support = (await builder.build('support', 'weekly', '2026-11-10'))!;
    expect(section(support, 'kpis').items[0]).toMatchObject({ label: 'Tickets created', value: '4' });
    expect(section(support, 'table', 'Support early warnings').rows.length).toBeGreaterThan(0);
  });

  it('sends the reports that are switched on to the right people, and posts leadership and support summaries to Chat', async () => {
    await start();
    const res = await reports.run('2026-11-10', { cadences: ['weekly'] });
    expect(res).toMatchObject({ schedulesDue: 4, sent: 7, failed: 0, skipped: 0, dryRun: false });
    const bySubject = (re: RegExp) => outbox.emails.filter((e) => re.test(e.subject));
    expect(bySubject(/leadership report/).flatMap((e) => e.to).sort()).toEqual(['director@example.com', 'viewer@example.com']);
    expect(bySubject(/portfolio report/).flatMap((e) => e.to)).toEqual(['ngozi.okafor@example.com']);
    expect(bySubject(/Onboarding report/).flatMap((e) => e.to)).toEqual(['impl@example.com']);
    expect(bySubject(/Support report/).flatMap((e) => e.to)).toEqual(['support@example.com']);
    expect(outbox.emails).toHaveLength(5);
    expect(outbox.chats.map((c) => c.text.split('\n')[0])).toEqual(['📊 *Weekly leadership report*', '📊 *Support report*']);
    // Personal CSM data never reaches the shared space.
    expect(outbox.chats.some((c) => c.text.includes('My ARR') || c.text.includes('portfolio'))).toBe(false);
    const html = bySubject(/leadership report/)[0]!.html;
    expect(html).toContain('₦6,290,000.00');
    expect(html).toContain('background:#004AF5');
    expect(bySubject(/leadership report/)[0]!.text).toContain('Total ARR: ₦6,290,000.00');
  });

  it('sends each report once per day, and retries only the ones that failed', async () => {
    await start();
    const realSend = outbox.email.send;
    let failSupportOnce = true;
    outbox.email.send = async (msg) => {
      if (failSupportOnce && msg.to.includes('support@example.com')) {
        failSupportOnce = false;
        throw new Error('SMTP busy');
      }
      return realSend(msg);
    };
    const first = await reports.run('2026-11-10', { cadences: ['weekly'] });
    expect(first).toMatchObject({ sent: 6, failed: 1 });
    const second = await reports.run('2026-11-10', { cadences: ['weekly'] });
    expect(second).toMatchObject({ sent: 1, failed: 0, skipped: 6 });
    const third = await reports.run('2026-11-10', { cadences: ['weekly'] });
    expect(third).toMatchObject({ sent: 0, skipped: 7 });
    expect(outbox.emails.filter((e) => e.to.includes('support@example.com'))).toHaveLength(1);
  });

  it('honours the schedule switches: only enabled reports go out', async () => {
    await start();
    await db.query(`UPDATE report_schedule SET enabled = false WHERE audience <> 'csm'`);
    expect((await reports.run('2026-11-10', { cadences: ['weekly'] })).sent).toBe(1);
    await reports.updateSchedule('csm-daily', { enabled: true }, 'admin@example.com');
    const daily = await reports.run('2026-11-10', { cadences: ['daily'] });
    expect(daily.sent).toBe(1);
    expect(outbox.emails.at(-1)!.subject).toContain('Daily portfolio report');
    const log = await db.query(`SELECT actor, details FROM action_log WHERE action = 'report_schedule.update'`);
    expect(log.rows[0]).toMatchObject({ actor: 'admin@example.com' });
  });

  it('refuses schedule changes that would break the rules', async () => {
    await start();
    await expect(reports.updateSchedule('csm-weekly', { channels: ['email', 'google_chat'] }, 'a@x.com')).rejects.toThrow(/personal/);
    await expect(reports.updateSchedule('executive-weekly', { channels: ['google_chat'] }, 'a@x.com')).rejects.toThrow(/include email/);
    await expect(reports.updateSchedule('executive-weekly', { channels: ['email', 'sms'] }, 'a@x.com')).rejects.toThrow(/include email/);
    await expect(reports.updateSchedule('nope', { enabled: true }, 'a@x.com')).rejects.toThrow(/Unknown report schedule/);
  });

  it('dry run records nothing and sends nothing', async () => {
    await start({ ALERTS_DRY_RUN: 'true' });
    const res = await reports.run('2026-11-10', { cadences: ['weekly'] });
    expect(res).toMatchObject({ sent: 0, dryRun: true });
    expect(outbox.emails).toHaveLength(0);
    expect((await db.query('SELECT count(*)::int AS n FROM report_run')).rows[0]!.n).toBe(0);
  });

  it('skips cleanly when there is no data yet', async () => {
    await start();
    expect(await builder.build('executive', 'daily', '2020-01-01')).toBeNull();
    await db.query('TRUNCATE ingestion_run');
    const res = await reports.run('2026-11-10', { cadences: ['weekly'] });
    expect(res.sent).toBe(0);
  });
});

describe('phase 3 API', () => {
  let app: INestApplication;
  let db: Database;
  const as = (email: string) => ({ authorization: `Bearer ${email}` });
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await resetDatabase();
    const world = new World();
    app = await apiApp(testConfig(), world, new Outbox());
    db = app.get(Database);
    await db.migrate();
    await db.query(`INSERT INTO app_user (email, role) VALUES ('admin@example.com', 'super_admin'), ('director@example.com', 'cs_director'),
      ('viewer@example.com', 'viewer'), ('ngozi.okafor@example.com', 'csm'), ('tunde.bello@example.com', 'csm'), ('support@example.com', 'support_specialist')`);
    await buildHistory(world, app.get(JobRunner));
  });

  afterEach(async () => {
    await app?.close();
  });

  it('serves portfolio, period and ledger numbers, with exact kobo amounts as text', async () => {
    const pf = await http().get('/analytics/portfolio?date=2026-11-10').set(as('director@example.com')).expect(200);
    expect(pf.body).toMatchObject({ asOf: '2026-11-10', totalArrKobo: '629000000', customers: 6 });
    const period = await http().get('/analytics/period?from=2026-11-01&to=2026-11-30').set(as('viewer@example.com')).expect(200);
    expect(period.body.bridge).toMatchObject({ startKobo: '684000000', fullChurnKobo: '90000000', endKobo: '629000000' });
    expect(period.body.renewals).toMatchObject({ eligible: 2, renewed: 1 });
    const ledger = await http().get('/analytics/ledger?year=2026&date=2026-11-10').set(as('director@example.com')).expect(200);
    const ngozi = ledger.body.rows.find((x: { csmEmail: string }) => x.csmEmail === 'ngozi.okafor@example.com');
    expect(ngozi).toMatchObject({ currentKobo: '345000000', deltaPct: 27.78 });
  });

  it('keeps portfolio analytics to managers, and validates its inputs', async () => {
    await http().get('/analytics/portfolio').set(as('ngozi.okafor@example.com')).expect(403);
    await http().get('/analytics/period?from=2026-11-30&to=2026-11-01').set(as('director@example.com')).expect(400);
    await http().get('/analytics/period?from=garbage').set(as('director@example.com')).expect(400);
    await http().get('/analytics/ledger?year=1999').set(as('director@example.com')).expect(400);
    await http().get('/analytics/ledger?year=2031').set(as('director@example.com')).expect(404);
    await http().get('/analytics/portfolio').expect(401);
  });

  it('previews reports by role: a CSM sees only their own, support sees only support', async () => {
    const own = await http().get('/reports/preview?audience=csm&cadence=weekly&date=2026-11-10').set(as('ngozi.okafor@example.com')).expect(200);
    expect(JSON.stringify(own.body)).toContain('Adebayo Logistics');
    expect(JSON.stringify(own.body)).not.toContain('Kano Holdings');
    // Asking for a colleague's portfolio with ?csm= is refused for a CSM who has nobody under them.
    await http().get('/reports/preview?audience=csm&cadence=weekly&date=2026-11-10&csm=tunde.bello@example.com').set(as('ngozi.okafor@example.com')).expect(404);
    await http().get('/reports/preview?audience=executive&cadence=weekly&date=2026-11-10').set(as('ngozi.okafor@example.com')).expect(403);
    await http().get('/reports/preview?audience=support&cadence=weekly&date=2026-11-10').set(as('support@example.com')).expect(200);
    await http().get('/reports/preview?audience=executive&cadence=weekly&date=2026-11-10').set(as('support@example.com')).expect(403);
    const exec = await http().get('/reports/preview?audience=executive&cadence=weekly&date=2026-11-10').set(as('director@example.com')).expect(200);
    expect(exec.body.sections[0].items[0].value).toBe('₦6,290,000.00');
    // Without ?csm= a director gets the team report: everyone, one row each.
    const team = await http().get('/reports/preview?audience=csm&cadence=weekly&date=2026-11-10').set(as('director@example.com')).expect(200);
    expect(team.body.title).toBe('Weekly team report');
    expect(JSON.stringify(team.body)).toContain('Kano Holdings');
    expect(JSON.stringify(team.body)).toContain('Adebayo Logistics');
    const forTunde = await http().get('/reports/preview?audience=csm&cadence=weekly&date=2026-11-10&csm=tunde.bello@example.com').set(as('director@example.com')).expect(200);
    expect(JSON.stringify(forTunde.body)).toContain('Kano Holdings');
    await http().get('/reports/preview?audience=bogus').set(as('director@example.com')).expect(400);
    await http().get('/reports/preview?cadence=hourly').set(as('director@example.com')).expect(400);
  });

  it('lets directors switch report schedules on and off, and logs who did', async () => {
    const list = await http().get('/reports/schedules').set(as('viewer@example.com')).expect(200);
    expect(list.body).toHaveLength(12);
    expect(list.body.find((s: any) => s.key === 'csm-weekly')).toMatchObject({ enabled: true, channels: ['email'] });
    await http().put('/reports/schedules/csm-weekly').set(as('viewer@example.com')).send({ enabled: false }).expect(403);
    await http().put('/reports/schedules/csm-weekly').set(as('director@example.com')).send({ enabled: 'yes' }).expect(400);
    await http().put('/reports/schedules/csm-weekly').set(as('director@example.com')).send({ channels: ['email', 'google_chat'] }).expect(400);
    const off = await http().put('/reports/schedules/csm-weekly').set(as('director@example.com')).send({ enabled: false }).expect(200);
    expect(off.body).toMatchObject({ enabled: false, updatedBy: 'director@example.com' });
  });
});
