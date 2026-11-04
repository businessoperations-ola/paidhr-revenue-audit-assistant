/**
 * Adoption and upsell become configurable: what counts as "in use" for each module, and every
 * weight and threshold behind churn and upsell scoring. Rows here override built-in defaults.
 */
export const migration009 = /* sql */ `
-- Whether a module has been set up, as far as the Control Panel can tell.
ALTER TABLE cp_client_module
  ADD COLUMN configured_on    date,
  ADD COLUMN configured_known boolean NOT NULL DEFAULT false;

-- Requisitions: a request type admins asked to measure alongside leave and loans.
INSERT INTO product_module (key, label, sort_order) VALUES ('REQUISITION', 'Requisitions', 45) ON CONFLICT (key) DO NOTHING;

-- One rule per module: which criteria show it is in use, and whether any or all must be met.
CREATE TABLE module_usage_rule (
  module     text PRIMARY KEY REFERENCES product_module (key) ON DELETE CASCADE,
  mode       text  NOT NULL CHECK (mode IN ('ANY', 'ALL')),
  criteria   jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Weights, thresholds and relationships for adoption, churn and upsell scoring. One document, edited as a whole.
CREATE TABLE adoption_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
