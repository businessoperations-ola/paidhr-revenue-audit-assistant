/**
 * Phase 1 schema. Money is bigint kobo; dates are WAT calendar dates.
 * Kept as a TS string so it ships inside the compiled container image.
 */
export const migration001 = /* sql */ `
CREATE TABLE ingestion_run (
  id            bigserial PRIMARY KEY,
  snapshot_date date        NOT NULL,
  source_mode   text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  counts        jsonb       NOT NULL DEFAULT '{}',
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- Daily copy of each active HubSpot customer (US-01, 02, 03, 05, 17).
CREATE TABLE hs_company_snapshot (
  snapshot_date                date   NOT NULL,
  hubspot_id                   text   NOT NULL,
  name                         text   NOT NULL,
  domain                       text,
  control_panel_id             text,
  csm_name                     text,
  csm_email                    text,
  csm_owner_id                 text,
  industry                     text,
  contract_end_date            date,
  seat_tier                    text,
  paid_seats                   integer,
  arr_kobo                     bigint,
  price_per_seat_monthly_kobo  bigint,
  health_status                text,
  raw                          jsonb  NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_date, hubspot_id)
);
CREATE INDEX hs_company_snapshot_hubspot_id_idx ON hs_company_snapshot (hubspot_id, snapshot_date);

-- Daily copy of each Control Panel account, active or not (US-02 to 05, 24).
CREATE TABLE cp_account_snapshot (
  snapshot_date              date    NOT NULL,
  client_id                  text    NOT NULL,
  parent_client_id           text,
  name                       text    NOT NULL,
  is_active                  boolean NOT NULL,
  active_users               integer NOT NULL,
  contractor_users           integer NOT NULL,
  pay_frequency              text,
  pay_day                    integer,
  last_payroll_pay_date      date,
  last_payroll_completed_at  timestamptz,
  PRIMARY KEY (snapshot_date, client_id)
);
CREATE INDEX cp_account_snapshot_client_id_idx ON cp_account_snapshot (client_id, snapshot_date);

-- Per-company daily figures for change detection (US-02): ARR, rolled-up seats, contract end.
CREATE TABLE company_daily_metrics (
  snapshot_date      date   NOT NULL,
  hubspot_id         text   NOT NULL,
  arr_kobo           bigint,
  rollup_seats       integer,
  contract_end_date  date,
  PRIMARY KEY (hubspot_id, snapshot_date)
);

-- Thresholds admins can change without a deploy (US-13 in phase 2 adds more).
CREATE TABLE rules_config (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  description text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL DEFAULT 'system'
);

-- Nigerian public holidays for business-day maths. Movable holidays (Eid) are added by admins.
CREATE TABLE public_holiday (
  holiday_date date PRIMARY KEY,
  name         text NOT NULL
);

CREATE TABLE audit_run (
  id          bigserial PRIMARY KEY,
  run_date    date        NOT NULL,
  audits      text[]      NOT NULL,
  status      text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary     jsonb       NOT NULL DEFAULT '{}',
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- One row per problem. The same problem on the same entity keeps one open flag.
CREATE TABLE audit_flag (
  id                 bigserial PRIMARY KEY,
  type               text        NOT NULL,
  entity_key         text        NOT NULL,
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  severity           text        NOT NULL CHECK (severity IN ('urgent', 'high', 'medium', 'low')),
  hubspot_company_id text,
  control_panel_id   text,
  company_name       text        NOT NULL,
  csm_email          text,
  summary            text        NOT NULL,
  details            jsonb       NOT NULL DEFAULT '{}',
  ai_rationale       jsonb,
  first_run_id       bigint      NOT NULL REFERENCES audit_run (id),
  last_run_id        bigint      NOT NULL REFERENCES audit_run (id),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at    timestamptz,
  acknowledged_by    text,
  resolved_at        timestamptz,
  resolution_reason  text
);
CREATE UNIQUE INDEX audit_flag_one_open_idx ON audit_flag (type, entity_key) WHERE status = 'open';
CREATE INDEX audit_flag_status_idx ON audit_flag (status, severity);
CREATE INDEX audit_flag_csm_idx ON audit_flag (csm_email) WHERE status = 'open';

-- Every delivery attempt (US-15). Unique per flag/channel/recipient so a retry never double-sends.
CREATE TABLE alert (
  id            bigserial PRIMARY KEY,
  flag_id       bigint      NOT NULL REFERENCES audit_flag (id),
  channel       text        NOT NULL CHECK (channel IN ('google_chat', 'email', 'hubspot_task')),
  recipient     text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts      integer     NOT NULL DEFAULT 0,
  external_ref  text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  UNIQUE (flag_id, channel, recipient)
);
CREATE INDEX alert_status_idx ON alert (status);

-- Staff allowed into the API, and their role (Google sign-in decides who they are).
CREATE TABLE app_user (
  email      text PRIMARY KEY,
  role       text        NOT NULL CHECK (role IN ('super_admin', 'cs_director', 'cs_team_lead', 'csm', 'implementation_manager', 'support_specialist', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only record of who did what.
CREATE TABLE action_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text        NOT NULL,
  action      text        NOT NULL,
  object_type text        NOT NULL,
  object_id   text,
  details     jsonb       NOT NULL DEFAULT '{}'
);

INSERT INTO rules_config (key, value, description) VALUES
  ('arr_tolerance_kobo', '1', 'US-01: allowed |expected − recorded ARR| in kobo (1 = ₦0.01)'),
  ('payroll_grace_business_days', '2', 'US-24: business days after the expected pay date before a late-payroll alert'),
  ('mandatory_fields', '["CSM Name", "Industry", "Contract End Date", "Seat Tier", "Seat Count", "Deal ARR (₦)", "Price per Seat (₦/month)", "Control Panel ID"]', 'US-17: HubSpot fields every customer must have'),
  ('seat_history_days', '400', 'US-02: how far back to look for the last ARR change');

INSERT INTO public_holiday (holiday_date, name) VALUES
  ('2026-01-01', 'New Year''s Day'),
  ('2026-04-03', 'Good Friday'),
  ('2026-04-06', 'Easter Monday'),
  ('2026-05-01', 'Workers'' Day'),
  ('2026-06-12', 'Democracy Day'),
  ('2026-10-01', 'Independence Day'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-26', 'Boxing Day'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-03-26', 'Good Friday'),
  ('2027-03-29', 'Easter Monday'),
  ('2027-05-01', 'Workers'' Day'),
  ('2027-06-12', 'Democracy Day'),
  ('2027-10-01', 'Independence Day'),
  ('2027-12-25', 'Christmas Day'),
  ('2027-12-26', 'Boxing Day');
`;
