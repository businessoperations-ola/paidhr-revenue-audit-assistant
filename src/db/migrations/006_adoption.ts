/** Product adoption: administrators, employee activity, modules bought, and support SLA data. */
export const migration006 = /* sql */ `
-- Administrators per Control Panel client, with their last login (full replace each night).
CREATE TABLE cp_client_admin (
  client_id     text        NOT NULL,
  email         text        NOT NULL,
  name          text,
  level         text        NOT NULL CHECK (level IN ('PRIMARY', 'SECONDARY')),
  last_login_at timestamptz,
  PRIMARY KEY (client_id, email)
);

-- What administrators did recently (full replace of the recent window each night).
CREATE TABLE cp_admin_action (
  client_id text        NOT NULL,
  email     text        NOT NULL,
  action_at timestamptz NOT NULL,
  action    text        NOT NULL
);
CREATE INDEX cp_admin_action_idx ON cp_admin_action (client_id, action_at DESC);

-- Employee activity per customer per day, by module and event (full replace of the recent window).
CREATE TABLE cp_employee_activity (
  activity_date    date    NOT NULL,
  client_id        text    NOT NULL,
  module           text    NOT NULL,
  event_type       text    NOT NULL,
  events           integer NOT NULL,
  active_employees integer NOT NULL
);
CREATE INDEX cp_employee_activity_idx ON cp_employee_activity (client_id, activity_date);

-- Modules each customer has bought.
CREATE TABLE cp_client_module (
  client_id    text NOT NULL,
  module       text NOT NULL,
  purchased_on date,
  PRIMARY KEY (client_id, module)
);

ALTER TABLE ticket
  ADD COLUMN status_label      text,
  ADD COLUMN first_response_at timestamptz,
  ADD COLUMN raised_by         text;

INSERT INTO rules_config (key, value, description) VALUES
  ('sla_first_response_high_hours', '4', 'Support SLA: hours to first reply on a high or urgent ticket'),
  ('sla_first_response_normal_hours', '8', 'Support SLA: hours to first reply on any other ticket'),
  ('sla_resolution_high_hours', '24', 'Support SLA: hours to resolve a high or urgent ticket'),
  ('sla_resolution_normal_hours', '72', 'Support SLA: hours to resolve any other ticket'),
  ('sla_at_risk_pct', '75', 'Support SLA: a ticket is "at risk" once this share of its time has passed');
`;
