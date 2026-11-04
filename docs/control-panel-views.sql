-- Contract between the Control Panel database and the CX Internal tool.
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
  -- Added in phase 3/4. If these columns are missing the CX Internal tool still runs, without
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

-- ---------- Product adoption (admins, employees, modules) ----------
-- Each view is optional. A missing one only switches off its part of the Adoption screen.

-- Primary and secondary administrators of each client, with their last login.
CREATE OR REPLACE VIEW audit.v_client_admins AS
SELECT a.company_id AS client_id, a.email, a.full_name AS name,
       CASE WHEN a.is_primary THEN 'PRIMARY' ELSE 'SECONDARY' END AS admin_level,
       a.last_login_at
  FROM company_admins a
 WHERE a.is_active;   -- PLACEHOLDER

-- What those administrators did (any user-facing action worth showing a CSM). Free text is shown as is
-- after emails and phone numbers are removed, so keep it to a short description.
CREATE OR REPLACE VIEW audit.v_client_admin_actions AS
SELECT l.company_id AS client_id, l.admin_email AS email, l.occurred_at AS action_at, l.description AS action
  FROM admin_audit_log l;   -- PLACEHOLDER

-- Employee activity per client per day. One row per module and event type. Counts only; no employee names.
-- module: PAYROLL, CORE_HR, LEAVE, LOANS, EWA, STATUTORY, TIME, EXPENSES, or PLATFORM for general sign-in.
-- event_type: SIGN_IN, LEAVE_REQUEST, LOAN_REQUEST, PROFILE_UPDATE (these four are shown first), plus any others.
-- active_employees: distinct employees who did it that day.
CREATE OR REPLACE VIEW audit.v_employee_activity_daily AS
SELECT e.company_id AS client_id, e.occurred_at::date AS activity_date, e.module, e.event_type,
       count(*) AS events, count(DISTINCT e.employee_id) AS active_employees
  FROM employee_events e
 GROUP BY 1, 2, 3, 4;   -- PLACEHOLDER

-- Modules each client has bought. configured_on is when the module was set up (NULL if it has not been);
-- it is optional, and without it "is it configured" is treated as unknown.
CREATE OR REPLACE VIEW audit.v_client_modules AS
SELECT s.company_id AS client_id, s.module, s.purchased_at::date AS purchased_on, s.configured_at::date AS configured_on
  FROM company_subscriptions s
 WHERE s.is_active;   -- PLACEHOLDER

-- Read-only login used by the CX Internal tool.
-- CREATE ROLE audit_reader LOGIN PASSWORD '<from Key Vault>';
-- GRANT USAGE ON SCHEMA audit TO audit_reader;
-- GRANT SELECT ON audit.v_accounts, audit.v_revenue_lines, audit.v_admin_users,
--   audit.v_client_admins, audit.v_client_admin_actions, audit.v_employee_activity_daily, audit.v_client_modules TO audit_reader;
-- ALTER ROLE audit_reader SET default_transaction_read_only = on;
