import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlPanelRepository } from '../../src/sources/control-panel/control-panel.repository.js';
import { TEST_CP_DB, resetDatabase, testConfig } from './harness.js';

/**
 * Builds placeholder Control Panel tables, installs docs/control-panel-views.sql
 * exactly as shipped, and reads it through the repository.
 */
describe('Control Panel view contract', () => {
  let repo: ControlPanelRepository;

  beforeAll(async () => {
    await resetDatabase(TEST_CP_DB);
    const client = new pg.Client({ connectionString: TEST_CP_DB });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS audit CASCADE');
    await client.query(`
      CREATE TABLE companies (id text PRIMARY KEY, parent_id text, name text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT '2026-10-01T09:00:00Z');
      CREATE TABLE employees (company_id text, status text, type text);
      CREATE TABLE payroll_schedules (company_id text, frequency text, pay_day int, created_at timestamptz DEFAULT '2026-10-03T09:00:00Z');
      CREATE TABLE payroll_runs (company_id text, pay_date date, status text, completed_at timestamptz);
      CREATE TABLE ewa_requests (company_id text, requested_at timestamptz, amount_kobo bigint);
      CREATE TABLE statutory_remittances (company_id text, generated_at timestamptz);
      CREATE TABLE invoices (company_id text, invoice_date date, product text, amount numeric, is_expansion boolean);
      CREATE TABLE users (email text, is_admin boolean, is_active boolean);
      INSERT INTO ewa_requests VALUES ('P', now() - interval '2 days', 500000), ('P', now() - interval '60 days', 900000);
      INSERT INTO statutory_remittances VALUES ('P', '2026-10-20T00:00:00Z');
      INSERT INTO invoices VALUES ('P', '2026-10-10', 'ewa', 1500, true), ('P', '2026-10-11', 'seat_upgrade', 100, false), ('C', '2026-10-12', 'training', 20, true);
      INSERT INTO users VALUES ('Admin@Example.com', true, true), ('gone@example.com', true, false), ('x@example.com', false, true);
      INSERT INTO companies (id, parent_id, name, status) VALUES ('P', NULL, 'Parent', 'active'), ('C', 'P', 'Child', 'active'), ('Z', NULL, 'Closed', 'churned');
      INSERT INTO employees VALUES ('P','active','employee'), ('P','active','contractor'), ('P','terminated','employee'), ('C','active','employee');
      INSERT INTO payroll_schedules VALUES ('P', 'MONTHLY', 25), ('C', 'SEMI_MONTHLY', NULL);
      INSERT INTO payroll_runs VALUES ('P','2026-09-25','completed','2026-09-24T10:00:00Z'), ('P','2026-10-25','completed','2026-10-24T10:00:00Z'), ('P','2026-11-25','draft',NULL);
    `);
    await client.query(readFileSync(new URL('../../docs/control-panel-views.sql', import.meta.url), 'utf8'));
    await client.end();
    repo = new ControlPanelRepository(testConfig({ CONTROL_PANEL_DATABASE_URL: TEST_CP_DB }));
  });

  afterAll(async () => {
    await repo?.close();
  });

  it('maps the view into accounts, using only completed payroll runs', async () => {
    const accounts = await repo.fetchAccounts();
    const byId = Object.fromEntries(accounts.map((a) => [a.clientId, a]));
    expect(byId.P).toMatchObject({ parentClientId: null, isActive: true, activeUsers: 2, contractorUsers: 1, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25' });
    expect(byId.C).toMatchObject({ parentClientId: 'P', activeUsers: 1, payFrequency: 'SEMI_MONTHLY', lastPayrollPayDate: null });
    expect(byId.Z).toMatchObject({ isActive: false, activeUsers: 0 });
  });

  it('maps the phase 3/4 columns', async () => {
    const accounts = await repo.fetchAccounts();
    const p = accounts.find((a) => a.clientId === 'P')!;
    expect(p).toMatchObject({ createdOn: '2026-10-01', payrollConfiguredOn: '2026-10-03', firstPayrollRunOn: '2026-09-25', ewaVolume30dKobo: 500000n, statutoryLastUsedOn: '2026-10-20' });
    expect(p.ewaLastUsedOn).not.toBeNull();
    expect(accounts.find((a) => a.clientId === 'C')!.firstPayrollRunOn).toBeNull();
  });

  it('reads revenue lines and admin emails from their views', async () => {
    const lines = await repo.fetchRevenueLines('2026-01-01');
    expect(lines.map((l) => [l.clientId, l.category, l.amountKobo])).toEqual(expect.arrayContaining([['P', 'CROSS_SELL_EWA', 150000n], ['C', 'CROSS_SELL_OTHER', 2000n]]));
    expect(lines).toHaveLength(2); // the non-expansion invoice is not in the view
    expect(await repo.fetchAdminEmails()).toEqual(['admin@example.com']);
  });

  it('runs every query in a read-only session', async () => {
    await expect((repo as any).pool.query('CREATE TABLE should_fail (x int)')).rejects.toThrow(/read-only/);
  });
});
