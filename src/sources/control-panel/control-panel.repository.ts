import pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import type { ControlPanelAccount, PayFrequency } from '../../domain/types.js';
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
}

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
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT client_id, parent_client_id, name, is_active, active_users, contractor_users,
              pay_frequency, pay_day, last_payroll_pay_date, last_payroll_completed_at
         FROM ${this.schema}.v_accounts`,
    );
    return rows.map(mapAccountRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
