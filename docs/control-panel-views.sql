-- Contract between the Control Panel database and the Audit Assistant.
--
-- The Control Panel team owns this file and the view behind it. The Audit
-- Assistant only ever runs `SELECT ... FROM audit.v_accounts` through a
-- read-only role on a read replica. Table and column names on the right-hand
-- side below are PLACEHOLDERS: replace them with the real Control Panel schema.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE OR REPLACE VIEW audit.v_accounts AS
SELECT
  c.id                         AS client_id,          -- text or integer, unique per account
  c.parent_id                  AS parent_client_id,   -- NULL for top-level (enterprise) accounts
  c.name                       AS name,
  (c.status = 'active')        AS is_active,
  COALESCE(u.active_users, 0)      AS active_users,      -- employees currently active on this account
  COALESCE(u.contractor_users, 0)  AS contractor_users,  -- of which tagged "Contractor"
  ps.frequency                 AS pay_frequency,      -- 'MONTHLY' | 'SEMI_MONTHLY' | 'BIWEEKLY' | 'WEEKLY'
  ps.pay_day                   AS pay_day,            -- monthly: day of month (1-31); else NULL
  lr.pay_date                  AS last_payroll_pay_date,      -- pay date of the latest COMPLETED run
  lr.completed_at              AS last_payroll_completed_at,  -- when that run completed
  -- Added in phase 3/4. If these columns are missing the Audit Assistant still runs, without
  -- onboarding, module-adoption and expansion-radar features.
  c.created_at::date           AS created_on,                 -- sign-up date
  ps.created_at::date          AS payroll_configured_on,      -- when a pay schedule was first set up (NULL if never)
  fr.pay_date                  AS first_payroll_run_on,       -- pay date of the first COMPLETED run (NULL if none)
  ew.last_used_on              AS ewa_last_used_on,           -- last Earned Wage Access request
  COALESCE(ew.volume_30d_kobo, 0) AS ewa_volume_30d_kobo,     -- EWA disbursed in the last 30 days, in kobo
  st.last_used_on              AS statutory_last_used_on      -- last statutory remittance generated
FROM companies c
LEFT JOIN LATERAL (SELECT min(pr.pay_date) AS pay_date FROM payroll_runs pr WHERE pr.company_id = c.id AND pr.status = 'completed') fr ON true
LEFT JOIN LATERAL (SELECT max(w.requested_at)::date AS last_used_on,
                          COALESCE(sum(w.amount_kobo) FILTER (WHERE w.requested_at > now() - interval '30 days'), 0) AS volume_30d_kobo
                     FROM ewa_requests w WHERE w.company_id = c.id) ew ON true
LEFT JOIN LATERAL (SELECT max(r.generated_at)::date AS last_used_on FROM statutory_remittances r WHERE r.company_id = c.id) st ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE e.status = 'active')                              AS active_users,
         count(*) FILTER (WHERE e.status = 'active' AND e.type = 'contractor')    AS contractor_users
    FROM employees e
   WHERE e.company_id = c.id
) u ON true
LEFT JOIN payroll_schedules ps ON ps.company_id = c.id
LEFT JOIN LATERAL (
  SELECT pr.pay_date, pr.completed_at
    FROM payroll_runs pr
   WHERE pr.company_id = c.id AND pr.status = 'completed'
   ORDER BY pr.pay_date DESC
   LIMIT 1
) lr ON true;

-- Revenue lines for the expansion-revenue report (US-07). category must be one of:
-- 'UPSELL' | 'CROSS_SELL_EWA' | 'CROSS_SELL_STATUTORY' | 'CROSS_SELL_OTHER'. Amounts in kobo.
-- Without this view the report says expansion revenue is not connected, and everything else works.
CREATE OR REPLACE VIEW audit.v_revenue_lines AS
SELECT i.company_id AS client_id, i.invoice_date AS revenue_date,
       CASE i.product WHEN 'seat_upgrade' THEN 'UPSELL' WHEN 'ewa' THEN 'CROSS_SELL_EWA'
                      WHEN 'statutory' THEN 'CROSS_SELL_STATUTORY' ELSE 'CROSS_SELL_OTHER' END AS category,
       (i.amount * 100)::bigint AS amount_kobo
  FROM invoices i
 WHERE i.is_expansion;   -- PLACEHOLDER: however the Control Panel marks add-on revenue

-- Control Panel admins, used only when BROADCAST_REQUIRE_CP_ADMIN=true to confirm a sender is an admin there.
CREATE OR REPLACE VIEW audit.v_admin_users AS
SELECT u.email FROM users u WHERE u.is_admin AND u.is_active;  -- PLACEHOLDER

-- Read-only login used by the Audit Assistant.
-- CREATE ROLE audit_reader LOGIN PASSWORD '<from Key Vault>';
-- GRANT USAGE ON SCHEMA audit TO audit_reader;
-- GRANT SELECT ON audit.v_accounts, audit.v_revenue_lines, audit.v_admin_users TO audit_reader;
-- ALTER ROLE audit_reader SET default_transaction_read_only = on;
