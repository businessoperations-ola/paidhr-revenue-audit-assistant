import pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import type { IsoDate } from '../../common/calendar.js';
import { redactText } from '../../common/redact.js';
import type { AdminAction, ClientAdmin, ClientModule, ControlPanelAccount, EmployeeActivity, PayFrequency, RevenueCategory, RevenueLine } from '../../domain/types.js';
import type { ControlPanelSource } from '../source.types.js';

const FREQUENCIES: ReadonlySet<string> = new Set(['MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'WEEKLY']);

interface AccountRow {
  client_id: string | number;
  parent_client_id: string | number | null;
  name: string;
  is_active: boolean;
  active_users: number | string;
  contractor_users: number | string;
  pay_frequency: string | null;
  pay_day: number | null;
  last_payroll_pay_date: string | Date | null;
  last_payroll_completed_at: string | Date | null;
  // Added for phases 3 and 4. Absent when the Control Panel view has not been updated yet.
  created_on?: string | Date | null;
  payroll_configured_on?: string | Date | null;
  first_payroll_run_on?: string | Date | null;
  ewa_last_used_on?: string | Date | null;
  ewa_volume_30d_kobo?: string | number | bigint | null;
  statutory_last_used_on?: string | Date | null;
}

const REVENUE_CATEGORIES: ReadonlySet<string> = new Set(['UPSELL', 'CROSS_SELL_EWA', 'CROSS_SELL_STATUTORY', 'CROSS_SELL_OTHER']);

function isoDate(v: string | Date | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

export function mapAccountRow(r: AccountRow): ControlPanelAccount {
  const freq = r.pay_frequency?.trim().toUpperCase().replace(/[-\s]/g, '_') ?? null;
  return {
    clientId: String(r.client_id),
    parentClientId: r.parent_client_id === null ? null : String(r.parent_client_id),
    name: r.name,
    isActive: r.is_active,
    activeUsers: Number(r.active_users),
    contractorUsers: Number(r.contractor_users),
    payFrequency: freq && FREQUENCIES.has(freq) ? (freq as PayFrequency) : null,
    payDay: r.pay_day,
    lastPayrollPayDate: isoDate(r.last_payroll_pay_date),
    lastPayrollCompletedAt:
      r.last_payroll_completed_at === null
        ? null
        : typeof r.last_payroll_completed_at === 'string'
          ? r.last_payroll_completed_at
          : r.last_payroll_completed_at.toISOString(),
    createdOn: isoDate(r.created_on ?? null),
    payrollConfiguredOn: isoDate(r.payroll_configured_on ?? null),
    firstPayrollRunOn: isoDate(r.first_payroll_run_on ?? null),
    ewaLastUsedOn: isoDate(r.ewa_last_used_on ?? null),
    ewaVolume30dKobo: r.ewa_volume_30d_kobo === null || r.ewa_volume_30d_kobo === undefined ? null : BigInt(r.ewa_volume_30d_kobo),
    statutoryLastUsedOn: isoDate(r.statutory_last_used_on ?? null),
  };
}

/**
 * Reads the Control Panel through the `audit.v_accounts` view (see
 * docs/control-panel-views.sql). The view is the contract: the Control Panel
 * team can change their tables freely as long as the view keeps its columns.
 */
export class ControlPanelRepository implements ControlPanelSource {
  private readonly pool: pg.Pool;
  private readonly schema: string;

  constructor(cfg: AppConfig) {
    if (!cfg.CONTROL_PANEL_DATABASE_URL) {
      throw new Error('CONTROL_PANEL_DATABASE_URL is required when SOURCE_MODE=live');
    }
    if (!/^[a-z_][a-z0-9_]*$/i.test(cfg.CONTROL_PANEL_SCHEMA)) throw new Error('Invalid CONTROL_PANEL_SCHEMA');
    this.schema = cfg.CONTROL_PANEL_SCHEMA;
    this.pool = new pg.Pool({
      connectionString: cfg.CONTROL_PANEL_DATABASE_URL,
      max: 2,
      // Belt and braces: the role is read-only, and so is every session.
      options: '-c default_transaction_read_only=on -c statement_timeout=120000',
    });
  }

  async fetchAccounts(): Promise<ControlPanelAccount[]> {
    const base = `client_id, parent_client_id, name, is_active, active_users, contractor_users,
              pay_frequency, pay_day, last_payroll_pay_date, last_payroll_completed_at`;
    try {
      const { rows } = await this.pool.query<AccountRow>(
        `SELECT ${base}, created_on, payroll_configured_on, first_payroll_run_on,
                ewa_last_used_on, ewa_volume_30d_kobo, statutory_last_used_on
           FROM ${this.schema}.v_accounts`,
      );
      return rows.map(mapAccountRow);
    } catch (err) {
      // 42703 = undefined column: the view has not been updated for phases 3 and 4 yet.
      // Billing audits keep working; onboarding, adoption and radar data stay empty.
      if ((err as { code?: string }).code !== '42703') throw err;
      const { rows } = await this.pool.query<AccountRow>(`SELECT ${base} FROM ${this.schema}.v_accounts`);
      return rows.map(mapAccountRow);
    }
  }

  async fetchRevenueLines(since: IsoDate): Promise<RevenueLine[]> {
    const { rows } = await this.pool.query<{ client_id: string | number; revenue_date: string | Date; category: string; amount_kobo: string | number | bigint }>(
      `SELECT client_id, revenue_date, category, amount_kobo FROM ${this.schema}.v_revenue_lines WHERE revenue_date >= $1`,
      [since],
    );
    return rows
      .filter((r) => REVENUE_CATEGORIES.has(r.category))
      .map((r) => ({
        clientId: String(r.client_id),
        revenueDate: isoDate(r.revenue_date)!,
        category: r.category as RevenueCategory,
        amountKobo: BigInt(r.amount_kobo),
      }));
  }

  async fetchAdminEmails(): Promise<string[]> {
    const { rows } = await this.pool.query<{ email: string }>(`SELECT lower(email) AS email FROM ${this.schema}.v_admin_users`);
    return rows.map((r) => r.email);
  }

  async fetchClientAdmins(): Promise<ClientAdmin[]> {
    const { rows } = await this.pool.query<{ client_id: string | number; email: string; name: string | null; admin_level: string; last_login_at: Date | string | null }>(
      `SELECT client_id, lower(email) AS email, name, upper(admin_level) AS admin_level, last_login_at FROM ${this.schema}.v_client_admins`,
    );
    return rows.map((r) => ({
      clientId: String(r.client_id), email: r.email, name: r.name, level: r.admin_level === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY',
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    }));
  }

  async fetchAdminActions(since: IsoDate): Promise<AdminAction[]> {
    const { rows } = await this.pool.query<{ client_id: string | number; email: string; action_at: Date | string; action: string }>(
      `SELECT client_id, lower(email) AS email, action_at, action FROM ${this.schema}.v_client_admin_actions WHERE action_at >= $1 ORDER BY action_at DESC LIMIT 200000`,
      [since],
    );
    return rows.map((r) => ({ clientId: String(r.client_id), email: r.email, at: new Date(r.action_at).toISOString(), action: redactText(r.action, 160) }));
  }

  async fetchEmployeeActivity(since: IsoDate): Promise<EmployeeActivity[]> {
    const { rows } = await this.pool.query<{ client_id: string | number; activity_date: string | Date; module: string; event_type: string; events: string | number; active_employees: string | number }>(
      `SELECT client_id, activity_date, upper(module) AS module, upper(event_type) AS event_type, events, active_employees
         FROM ${this.schema}.v_employee_activity_daily WHERE activity_date >= $1`,
      [since],
    );
    return rows.map((r) => ({ clientId: String(r.client_id), date: isoDate(r.activity_date)!, module: r.module, eventType: r.event_type, events: Number(r.events), activeEmployees: Number(r.active_employees) }));
  }

  async fetchClientModules(): Promise<ClientModule[]> {
    type Row = { client_id: string | number; module: string; purchased_on: string | Date | null; configured_on?: string | Date | null };
    try {
      const { rows } = await this.pool.query<Row>(`SELECT client_id, upper(module) AS module, purchased_on, configured_on FROM ${this.schema}.v_client_modules`);
      return rows.map((r) => ({ clientId: String(r.client_id), module: r.module, purchasedOn: isoDate(r.purchased_on ?? null), configuredOn: isoDate(r.configured_on ?? null) }));
    } catch (err) {
      // 42703: the view has no configured_on column yet. Everything else still works; "is it configured" is simply unknown.
      if ((err as { code?: string }).code !== '42703') throw err;
      const { rows } = await this.pool.query<Row>(`SELECT client_id, upper(module) AS module, purchased_on FROM ${this.schema}.v_client_modules`);
      return rows.map((r) => ({ clientId: String(r.client_id), module: r.module, purchasedOn: isoDate(r.purchased_on ?? null) }));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
