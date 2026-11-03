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
      CREATE TABLE companies (id text PRIMARY KEY, parent_id text, name text NOT NULL, status text NOT NULL);
      CREATE TABLE employees (company_id text, status text, type text);
      CREATE TABLE payroll_schedules (company_id text, frequency text, pay_day int);
      CREATE TABLE payroll_runs (company_id text, pay_date date, status text, completed_at timestamptz);
      INSERT INTO companies VALUES ('P', NULL, 'Parent', 'active'), ('C', 'P', 'Child', 'active'), ('Z', NULL, 'Closed', 'churned');
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

  it('runs every query in a read-only session', async () => {
    await expect((repo as any).pool.query('CREATE TABLE should_fail (x int)')).rejects.toThrow(/read-only/);
  });
});
