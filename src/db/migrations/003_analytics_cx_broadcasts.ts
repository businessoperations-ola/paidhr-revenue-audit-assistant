/**
 * Phases 3 and 4: analytics, reports, CX tools and admin broadcasts.
 */
export const migration003 = /* sql */ `
-- ---------- extra snapshot columns ----------
ALTER TABLE hs_company_snapshot ADD COLUMN primary_contact_email text;

ALTER TABLE cp_account_snapshot
  ADD COLUMN created_on              date,
  ADD COLUMN payroll_configured_on   date,
  ADD COLUMN first_payroll_run_on    date,
  ADD COLUMN ewa_last_used_on        date,
  ADD COLUMN ewa_volume_30d_kobo     bigint,
  ADD COLUMN statutory_last_used_on  date;

-- Expansion revenue from billing, replaced on every ingestion (US-07).
CREATE TABLE cp_revenue_line (
  revenue_date date   NOT NULL,
  client_id    text   NOT NULL,
  category     text   NOT NULL CHECK (category IN ('UPSELL', 'CROSS_SELL_EWA', 'CROSS_SELL_STATUTORY', 'CROSS_SELL_OTHER')),
  amount_kobo  bigint NOT NULL
);
CREATE INDEX cp_revenue_line_date_idx ON cp_revenue_line (revenue_date);

-- Support tickets: latest state, plus re-open counting and sentiment (US-12, 28).
CREATE TABLE ticket (
  ticket_id          text PRIMARY KEY,
  hubspot_company_id text,
  subject            text        NOT NULL,
  content            text        NOT NULL DEFAULT '',
  priority           text,
  created_at         timestamptz NOT NULL,
  closed_at          timestamptz,
  is_closed          boolean     NOT NULL,
  reopen_count       integer     NOT NULL DEFAULT 0,
  sentiment          smallint CHECK (sentiment BETWEEN -2 AND 2),
  sentiment_signal   text,
  sentiment_at       timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_company_idx ON ticket (hubspot_company_id, created_at);
CREATE INDEX ticket_created_idx ON ticket (created_at);

-- Start-of-year ARR per CSM, locked once written (US-18).
CREATE TABLE csm_arr_baseline (
  year              integer NOT NULL,
  csm_email         text    NOT NULL,
  csm_name          text,
  baseline_arr_kobo bigint  NOT NULL,
  accounts          integer NOT NULL,
  snapshot_date     date    NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (year, csm_email)
);

-- Everything Claude writes: playbooks, QBR drafts, ticket clusters (phase 4).
CREATE TABLE ai_output (
  id            bigserial PRIMARY KEY,
  kind          text        NOT NULL,
  subject_key   text        NOT NULL,
  content       jsonb       NOT NULL,
  model         text        NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  requested_by  text        NOT NULL DEFAULT 'scheduler',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_output_kind_idx ON ai_output (kind, subject_key, created_at DESC);

-- ---------- scheduled reports (US-25) ----------
CREATE TABLE report_schedule (
  key        text PRIMARY KEY,
  audience   text    NOT NULL CHECK (audience IN ('executive', 'csm', 'implementation', 'support')),
  cadence    text    NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  enabled    boolean NOT NULL DEFAULT false,
  channels   text[]  NOT NULL DEFAULT '{email}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text    NOT NULL DEFAULT 'system',
  UNIQUE (audience, cadence)
);

CREATE TABLE report_run (
  id           bigserial PRIMARY KEY,
  schedule_key text        NOT NULL,
  period_key   text        NOT NULL,
  recipient    text        NOT NULL,
  channel      text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_key, period_key, recipient, channel)
);

INSERT INTO report_schedule (key, audience, cadence, enabled, channels) VALUES
  ('executive-daily',        'executive',      'daily',   false, '{email}'),
  ('executive-weekly',       'executive',      'weekly',  true,  '{email,google_chat}'),
  ('executive-monthly',      'executive',      'monthly', true,  '{email,google_chat}'),
  ('csm-daily',              'csm',            'daily',   false, '{email}'),
  ('csm-weekly',             'csm',            'weekly',  true,  '{email}'),
  ('csm-monthly',            'csm',            'monthly', false, '{email}'),
  ('implementation-daily',   'implementation', 'daily',   false, '{email}'),
  ('implementation-weekly',  'implementation', 'weekly',  true,  '{email}'),
  ('implementation-monthly', 'implementation', 'monthly', false, '{email}'),
  ('support-daily',          'support',        'daily',   false, '{email}'),
  ('support-weekly',         'support',        'weekly',  true,  '{email,google_chat}'),
  ('support-monthly',        'support',        'monthly', false, '{email}');

-- ---------- admin broadcasts (US-20 to 23) ----------
CREATE TABLE broadcast (
  id          bigserial PRIMARY KEY,
  name        text    NOT NULL,
  subject     text    NOT NULL,
  body        text    NOT NULL,
  audience    text    NOT NULL CHECK (audience IN ('clients', 'csms', 'cx_team')),
  filters     jsonb   NOT NULL DEFAULT '{}',
  channels    text[]  NOT NULL,
  status      text    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'paused', 'sent')),
  schedule    jsonb,
  next_run_at timestamptz,
  created_by  text    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text    NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broadcast_due_idx ON broadcast (next_run_at) WHERE status = 'scheduled';

CREATE TABLE broadcast_run (
  id           bigserial PRIMARY KEY,
  broadcast_id bigint  NOT NULL REFERENCES broadcast (id),
  trigger      text    NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  status       text    NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  live         boolean NOT NULL,
  total        integer NOT NULL DEFAULT 0,
  sent         integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,
  started_by   text    NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  error        text
);
CREATE INDEX broadcast_run_broadcast_idx ON broadcast_run (broadcast_id, started_at DESC);

CREATE TABLE broadcast_recipient (
  id                 bigserial PRIMARY KEY,
  run_id             bigint NOT NULL REFERENCES broadcast_run (id),
  hubspot_company_id text,
  company_name       text,
  recipient          text   NOT NULL,
  channel            text   NOT NULL,
  status             text   NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'dry_run')),
  rendered_subject   text,
  rendered_body      text,
  rendered_html      text,
  external_ref       text,
  error              text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz
);
CREATE UNIQUE INDEX broadcast_recipient_unique_idx
  ON broadcast_recipient (run_id, channel, recipient, coalesce(hubspot_company_id, ''));
CREATE INDEX broadcast_recipient_pending_idx ON broadcast_recipient (run_id) WHERE status IN ('pending', 'sending');

-- ---------- phase 3 and 4 rules ----------
INSERT INTO rules_config (key, value, description) VALUES
  ('onboarding_sla_days', '14',
   'US-26: days an active account may go without payroll configured before an onboarding alert'),
  ('radar_seat_growth_pct', '20',
   'US-27: seat growth (%) over the window below that marks an account as an expansion target'),
  ('radar_seat_growth_days', '90',
   'US-27: window, in days, for measuring seat growth'),
  ('radar_ewa_volume_kobo', '500000000',
   'US-27: EWA volume in the last 30 days (kobo; 500000000 = ₦5,000,000) that marks high usage'),
  ('radar_contractor_min', '5',
   'US-27: contractor users at or above which an account is flagged as a contractor-heavy target'),
  ('support_reopen_threshold', '1',
   'Support early warning: re-opens on one ticket that raise an escalation-risk alert'),
  ('support_open_days', '7',
   'Support early warning: days a ticket can stay open before it counts as a risk signal');
`;
