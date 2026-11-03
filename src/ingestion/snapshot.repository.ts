import { Inject, Injectable } from '@nestjs/common';
import type { IsoDate } from '../common/calendar.js';
import { Database, type Queryable } from '../db/database.js';
import type { CompanyDayPoint, ControlPanelAccount, HubSpotCompany, PayFrequency } from '../domain/types.js';

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));

/** Reads and writes the daily snapshot tables. */
@Injectable()
export class SnapshotRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async replaceSnapshot(
    client: Queryable,
    date: IsoDate,
    companies: HubSpotCompany[],
    accounts: ControlPanelAccount[],
    metrics: Array<{ hubspotId: string; arrKobo: bigint | null; rollupSeats: number | null; contractEndDate: IsoDate | null }>,
  ): Promise<void> {
    await client.query('DELETE FROM hs_company_snapshot WHERE snapshot_date = $1', [date]);
    await client.query('DELETE FROM cp_account_snapshot WHERE snapshot_date = $1', [date]);
    await client.query('DELETE FROM company_daily_metrics WHERE snapshot_date = $1', [date]);

    if (companies.length > 0) {
      await client.query(
        `INSERT INTO hs_company_snapshot (snapshot_date, hubspot_id, name, domain, control_panel_id, csm_name, csm_email,
            csm_owner_id, industry, contract_end_date, seat_tier, paid_seats, arr_kobo, price_per_seat_monthly_kobo, health_status, last_activity_date)
         SELECT $1::date, * FROM jsonb_to_recordset($2::jsonb) AS x(
            hubspot_id text, name text, domain text, control_panel_id text, csm_name text, csm_email text,
            csm_owner_id text, industry text, contract_end_date date, seat_tier text, paid_seats int,
            arr_kobo bigint, price_per_seat_monthly_kobo bigint, health_status text, last_activity_date date)`,
        [
          date,
          JSON.stringify(
            companies.map((c) => ({
              hubspot_id: c.hubspotId,
              name: c.name,
              domain: c.domain,
              control_panel_id: c.controlPanelId,
              csm_name: c.csmName,
              csm_email: c.csmEmail,
              csm_owner_id: c.csmOwnerId,
              industry: c.industry,
              contract_end_date: c.contractEndDate,
              seat_tier: c.seatTier,
              paid_seats: c.paidSeats,
              arr_kobo: c.arrKobo?.toString() ?? null,
              price_per_seat_monthly_kobo: c.pricePerSeatMonthlyKobo?.toString() ?? null,
              health_status: c.healthStatus,
              last_activity_date: c.lastActivityDate,
            })),
          ),
        ],
      );
    }

    if (accounts.length > 0) {
      await client.query(
        `INSERT INTO cp_account_snapshot (snapshot_date, client_id, parent_client_id, name, is_active, active_users,
            contractor_users, pay_frequency, pay_day, last_payroll_pay_date, last_payroll_completed_at)
         SELECT $1::date, * FROM jsonb_to_recordset($2::jsonb) AS x(
            client_id text, parent_client_id text, name text, is_active boolean, active_users int, contractor_users int,
            pay_frequency text, pay_day int, last_payroll_pay_date date, last_payroll_completed_at timestamptz)`,
        [
          date,
          JSON.stringify(
            accounts.map((a) => ({
              client_id: a.clientId,
              parent_client_id: a.parentClientId,
              name: a.name,
              is_active: a.isActive,
              active_users: a.activeUsers,
              contractor_users: a.contractorUsers,
              pay_frequency: a.payFrequency,
              pay_day: a.payDay,
              last_payroll_pay_date: a.lastPayrollPayDate,
              last_payroll_completed_at: a.lastPayrollCompletedAt,
            })),
          ),
        ],
      );
    }

    if (metrics.length > 0) {
      await client.query(
        `INSERT INTO company_daily_metrics (snapshot_date, hubspot_id, arr_kobo, rollup_seats, contract_end_date)
         SELECT $1::date, * FROM jsonb_to_recordset($2::jsonb) AS x(
            hubspot_id text, arr_kobo bigint, rollup_seats int, contract_end_date date)`,
        [
          date,
          JSON.stringify(
            metrics.map((m) => ({
              hubspot_id: m.hubspotId,
              arr_kobo: m.arrKobo?.toString() ?? null,
              rollup_seats: m.rollupSeats,
              contract_end_date: m.contractEndDate,
            })),
          ),
        ],
      );
    }
  }

  async latestSnapshotDate(onOrBefore: IsoDate): Promise<IsoDate | null> {
    // A snapshot exists when ingestion succeeded for that date, even if a source returned no rows.
    const { rows } = await this.db.query<{ d: string | null }>(
      `SELECT max(snapshot_date) AS d FROM ingestion_run WHERE status = 'succeeded' AND snapshot_date <= $1`,
      [onOrBefore],
    );
    return rows[0]?.d ?? null;
  }

  async loadCompanies(date: IsoDate): Promise<HubSpotCompany[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM hs_company_snapshot WHERE snapshot_date = $1 ORDER BY hubspot_id`,
      [date],
    );
    return rows.map((r) => ({
      hubspotId: r.hubspot_id,
      name: r.name,
      domain: r.domain,
      controlPanelId: r.control_panel_id,
      csmName: r.csm_name,
      csmEmail: r.csm_email,
      csmOwnerId: r.csm_owner_id,
      industry: r.industry,
      contractEndDate: r.contract_end_date,
      seatTier: r.seat_tier,
      paidSeats: r.paid_seats,
      arrKobo: big(r.arr_kobo),
      pricePerSeatMonthlyKobo: big(r.price_per_seat_monthly_kobo),
      healthStatus: r.health_status,
      lastActivityDate: r.last_activity_date,
    }));
  }

  async loadAccounts(date: IsoDate): Promise<ControlPanelAccount[]> {
    const { rows } = await this.db.query(
      `SELECT *, to_char(last_payroll_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_iso
         FROM cp_account_snapshot WHERE snapshot_date = $1 ORDER BY client_id`,
      [date],
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      parentClientId: r.parent_client_id,
      name: r.name,
      isActive: r.is_active,
      activeUsers: r.active_users,
      contractorUsers: r.contractor_users,
      payFrequency: r.pay_frequency as PayFrequency | null,
      payDay: r.pay_day,
      lastPayrollPayDate: r.last_payroll_pay_date,
      lastPayrollCompletedAt: r.completed_iso,
    }));
  }

  /** Daily points per company between two dates (inclusive), oldest first. */
  async loadHistory(from: IsoDate, to: IsoDate): Promise<Map<string, CompanyDayPoint[]>> {
    const { rows } = await this.db.query(
      `SELECT hubspot_id, snapshot_date, arr_kobo, rollup_seats, contract_end_date
         FROM company_daily_metrics
        WHERE snapshot_date BETWEEN $1 AND $2
        ORDER BY hubspot_id, snapshot_date`,
      [from, to],
    );
    const history = new Map<string, CompanyDayPoint[]>();
    for (const r of rows) {
      const list = history.get(r.hubspot_id) ?? [];
      list.push({
        date: r.snapshot_date,
        arrKobo: big(r.arr_kobo),
        seats: r.rollup_seats,
        contractEndDate: r.contract_end_date,
      });
      history.set(r.hubspot_id, list);
    }
    return history;
  }
}
