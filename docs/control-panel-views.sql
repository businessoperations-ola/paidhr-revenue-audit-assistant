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
  lr.completed_at              AS last_payroll_completed_at   -- when that run completed
FROM companies c
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

-- Read-only login used by the Audit Assistant.
-- CREATE ROLE audit_reader LOGIN PASSWORD '<from Key Vault>';
-- GRANT USAGE ON SCHEMA audit TO audit_reader;
-- GRANT SELECT ON audit.v_accounts TO audit_reader;
-- ALTER ROLE audit_reader SET default_transaction_read_only = on;
