/**
 * Adoption and upsell as a module of its own: a module catalogue (with launch dates), seasonality
 * windows, growth signals entered by CSMs, and the experience scores (NPS, CSAT) from HubSpot.
 */
export const migration008 = /* sql */ `
ALTER TABLE hs_company_snapshot ADD COLUMN nps numeric, ADD COLUMN csat numeric;

CREATE TABLE product_module (
  key         text PRIMARY KEY,
  label       text    NOT NULL,
  launched_on date,
  launch_note text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO product_module (key, label, sort_order) VALUES
  ('PAYROLL', 'Payroll', 10), ('CORE_HR', 'Core HR and profiles', 20), ('LEAVE', 'Leave management', 30),
  ('LOANS', 'Loans', 40), ('EWA', 'Earned Wage Access', 50), ('STATUTORY', 'Statutory remittance', 60),
  ('TIME', 'Time and attendance', 70), ('EXPENSES', 'Expenses', 80), ('PERFORMANCE', 'Performance management', 90);

-- When in the year a module is most likely to be bought. Months are 1-12; a window may wrap the year end.
CREATE TABLE module_seasonality (
  id          serial PRIMARY KEY,
  module      text     NOT NULL REFERENCES product_module (key) ON DELETE CASCADE,
  start_month smallint NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  end_month   smallint NOT NULL CHECK (end_month BETWEEN 1 AND 12),
  boost       smallint NOT NULL CHECK (boost BETWEEN 0 AND 30),
  reason      text     NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX module_seasonality_module_idx ON module_seasonality (module);

-- Starting points, set by the build team. The Head of CX should confirm or change them (Modules and seasons).
INSERT INTO module_seasonality (module, start_month, end_month, boost, reason) VALUES
  ('PERFORMANCE', 11, 12, 20, 'Year-end performance reviews'),
  ('PERFORMANCE', 6, 7, 15, 'Mid-year performance reviews'),
  ('LEAVE', 11, 12, 10, 'Year-end leave planning'),
  ('STATUTORY', 1, 2, 10, 'Annual returns and tax filing'),
  ('TIME', 1, 2, 8, 'New-year attendance and shift policies'),
  ('LOANS', 8, 9, 10, 'School-fees season'),
  ('LOANS', 12, 12, 6, 'Festive-season spending'),
  ('EWA', 12, 12, 10, 'Festive-season cash needs'),
  ('EXPENSES', 1, 1, 8, 'New budget year'),
  ('CORE_HR', 1, 2, 6, 'New-year hiring and records clean-up');

-- What a CSM knows about a customer's plans: a fund raise, an expansion, a hiring push.
CREATE TABLE account_signal (
  id                 bigserial PRIMARY KEY,
  hubspot_company_id text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('FUNDRAISE', 'EXPANSION', 'HIRING_PLAN', 'OTHER')),
  detail             text NOT NULL,
  happened_on        date NOT NULL,
  valid_until        date NOT NULL,
  added_by           text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_signal_company_idx ON account_signal (hubspot_company_id, valid_until);

INSERT INTO rules_config (key, value, description) VALUES
  ('upsell_launch_days', '180', 'Upsell: days after a module launches that it counts as a new launch worth raising with every customer'),
  ('upsell_season_lookahead_days', '60', 'Upsell: how many days before a buying season opens to start the conversation');
`;
