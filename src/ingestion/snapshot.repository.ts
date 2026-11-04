import { Inject, Injectable } from '@nestjs/common';
import type { IsoDate } from '../common/calendar.js';
import { Database, type Queryable } from '../db/database.js';
import type { SupportTicket } from '../cx/cx-rules.js';
import type { CompanyDayPoint, ControlPanelAccount, HubSpotCompany, PayFrequency, RevenueLine, Ticket } from '../domain/types.js';

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
            csm_owner_id, industry, contract_end_date, seat_tier, paid_seats, arr_kobo, price_per_seat_monthly_kobo, health_status, last_activity_date, primary_contact_email, nps, csat)
         SELECT $1::date, * FROM jsonb_to_recordset($2::jsonb) AS x(
            hubspot_id text, name text, domain text, control_panel_id text, csm_name text, csm_email text,
            csm_owner_id text, industry text, contract_end_date date, seat_tier text, paid_seats int,
            arr_kobo bigint, price_per_seat_monthly_kobo bigint, health_status text, last_activity_date date,
            primary_contact_email text, nps numeric, csat numeric)`,
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
              primary_contact_email: c.primaryContactEmail,
              nps: c.nps ?? null,
              csat: c.csat ?? null,
            })),
          ),
        ],
      );
    }

    if (accounts.length > 0) {
      await client.query(
        `INSERT INTO cp_account_snapshot (snapshot_date, client_id, parent_client_id, name, is_active, active_users,
            contractor_users, pay_frequency, pay_day, last_payroll_pay_date, last_payroll_completed_at,
            created_on, payroll_configured_on, first_payroll_run_on, ewa_last_used_on, ewa_volume_30d_kobo, statutory_last_used_on)
         SELECT $1::date, * FROM jsonb_to_recordset($2::jsonb) AS x(
            client_id text, parent_client_id text, name text, is_active boolean, active_users int, contractor_users int,
            pay_frequency text, pay_day int, last_payroll_pay_date date, last_payroll_completed_at timestamptz,
            created_on date, payroll_configured_on date, first_payroll_run_on date, ewa_last_used_on date,
            ewa_volume_30d_kobo bigint, statutory_last_used_on date)`,
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
              created_on: a.createdOn,
              payroll_configured_on: a.payrollConfiguredOn,
              first_payroll_run_on: a.firstPayrollRunOn,
              ewa_last_used_on: a.ewaLastUsedOn,
              ewa_volume_30d_kobo: a.ewaVolume30dKobo?.toString() ?? null,
              statutory_last_used_on: a.statutoryLastUsedOn,
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
      primaryContactEmail: r.primary_contact_email ?? null,
      nps: r.nps === null || r.nps === undefined ? null : Number(r.nps),
      csat: r.csat === null || r.csat === undefined ? null : Number(r.csat),
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
      createdOn: r.created_on ?? null,
      payrollConfiguredOn: r.payroll_configured_on ?? null,
      firstPayrollRunOn: r.first_payroll_run_on ?? null,
      ewaLastUsedOn: r.ewa_last_used_on ?? null,
      ewaVolume30dKobo: big(r.ewa_volume_30d_kobo ?? null),
      statutoryLastUsedOn: r.statutory_last_used_on ?? null,
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

  /** Insert or update tickets. A ticket that was closed and is open again counts as a re-open. */
  async upsertTickets(tickets: Ticket[]): Promise<number> {
    if (tickets.length === 0) return 0;
    await this.db.query(
      `INSERT INTO ticket (ticket_id, hubspot_company_id, subject, content, priority, created_at, closed_at, is_closed, status_label, first_response_at, raised_by)
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         ticket_id text, hubspot_company_id text, subject text, content text, priority text,
         created_at timestamptz, closed_at timestamptz, is_closed boolean, status_label text, first_response_at timestamptz, raised_by text)
       ON CONFLICT (ticket_id) DO UPDATE SET
         hubspot_company_id = EXCLUDED.hubspot_company_id, subject = EXCLUDED.subject, content = EXCLUDED.content,
         priority = EXCLUDED.priority, closed_at = EXCLUDED.closed_at, is_closed = EXCLUDED.is_closed,
         status_label = EXCLUDED.status_label, first_response_at = EXCLUDED.first_response_at, raised_by = EXCLUDED.raised_by,
         reopen_count = ticket.reopen_count + CASE WHEN ticket.is_closed AND NOT EXCLUDED.is_closed THEN 1 ELSE 0 END,
         last_seen_at = now()`,
      [
        JSON.stringify(
          tickets.map((t) => ({
            ticket_id: t.ticketId, hubspot_company_id: t.hubspotCompanyId, subject: t.subject, content: t.content,
            priority: t.priority, created_at: t.createdAt, closed_at: t.closedAt, is_closed: t.isClosed,
            status_label: t.statusLabel ?? null, first_response_at: t.firstResponseAt ?? null, raised_by: t.raisedBy ?? null,
          })),
        ),
      ],
    );
    return tickets.length;
  }

  async ticketCount(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM ticket');
    return Number(rows[0]!.n);
  }

  /** Replace all expansion revenue lines (the source gives the full recent window each time). */
  async replaceRevenueLines(lines: RevenueLine[]): Promise<number> {
    await this.db.transaction(async (client) => {
      await client.query('DELETE FROM cp_revenue_line');
      if (lines.length > 0) {
        await client.query(
          `INSERT INTO cp_revenue_line (revenue_date, client_id, category, amount_kobo)
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(revenue_date date, client_id text, category text, amount_kobo bigint)`,
          [JSON.stringify(lines.map((l) => ({ revenue_date: l.revenueDate, client_id: l.clientId, category: l.category, amount_kobo: l.amountKobo.toString() })))],
        );
      }
    });
    return lines.length;
  }

  /** Open tickets, for the support early warning. */
  async loadOpenTickets(): Promise<SupportTicket[]> {
    const { rows } = await this.db.query(
      `SELECT ticket_id, hubspot_company_id, subject, created_at, is_closed, reopen_count, sentiment, priority, first_response_at, closed_at FROM ticket WHERE NOT is_closed`,
    );
    return rows.map((r) => ({
      ticketId: r.ticket_id,
      hubspotCompanyId: r.hubspot_company_id,
      subject: r.subject,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      isClosed: r.is_closed,
      reopenCount: r.reopen_count,
      sentiment: r.sentiment,
      priority: r.priority,
      firstResponseAt: r.first_response_at instanceof Date ? r.first_response_at.toISOString() : (r.first_response_at ?? null),
      closedAt: null,
    }));
  }
}
