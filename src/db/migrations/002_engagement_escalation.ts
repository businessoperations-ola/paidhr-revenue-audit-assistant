/**
 * Phase 2: engagement drought (US-13, US-14) and escalation (US-16).
 */
export const migration002 = /* sql */ `
-- Last logged call, meeting or email per company, from HubSpot (US-14).
ALTER TABLE hs_company_snapshot ADD COLUMN last_activity_date date;

-- Who each CSM escalates to (US-16). Directors are every user with the cs_director role.
CREATE TABLE csm_team (
  csm_email        text PRIMARY KEY,
  team_lead_email  text        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text        NOT NULL DEFAULT 'system'
);

-- Escalation state lives on the flag.
ALTER TABLE audit_flag
  ADD COLUMN notified_at       timestamptz,
  ADD COLUMN escalation_level  smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 2),
  ADD COLUMN escalated_at      timestamptz,
  -- The working day the sweep escalated it on; the next step is counted from this.
  ADD COLUMN escalated_on      date;

-- First successful delivery marks the flag as notified; existing flags are backfilled.
UPDATE audit_flag f SET notified_at = a.first_sent
  FROM (SELECT flag_id, min(sent_at) AS first_sent FROM alert WHERE status = 'sent' GROUP BY flag_id) a
 WHERE a.flag_id = f.id;

-- An alert is now one of: the first notification, or an escalation to a lead or director.
ALTER TABLE alert ADD COLUMN kind text NOT NULL DEFAULT 'notify'
  CHECK (kind IN ('notify', 'escalation_lead', 'escalation_director'));
ALTER TABLE alert DROP CONSTRAINT alert_flag_id_channel_recipient_key;
ALTER TABLE alert ADD CONSTRAINT alert_flag_channel_recipient_kind_key UNIQUE (flag_id, channel, recipient, kind);

INSERT INTO rules_config (key, value, description) VALUES
  ('inactivity_days_by_health', '{"At Risk": 7, "Neutral": 14, "Healthy": 30, "default": 14}',
   'US-13: maximum days without a logged call, meeting or email, per HubSpot health status ("default" covers blank or other values)'),
  ('escalation_business_days', '3',
   'US-16: business days an alert can stay unacknowledged before it goes to the CSM''s team lead'),
  ('director_escalation_business_days', '2',
   'US-16: further business days before an unacknowledged alert goes to the Heads of CX'),
  ('escalate_severities', '["urgent", "high"]',
   'US-16: alert levels that escalate. Medium and low flags stay with the CSM');
`;
