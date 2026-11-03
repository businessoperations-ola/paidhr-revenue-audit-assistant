import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const csv = (fallback = '') =>
  z
  .string()
  .default(fallback)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/**
 * Every setting the service reads. In Azure these come from Container App
 * environment variables, with secrets referenced from Key Vault.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),

  // Audit database (Azure Database for PostgreSQL).
  DATABASE_URL: z.string().min(1),

  // Where source data comes from: real APIs, or the bundled demo fixtures.
  SOURCE_MODE: z.enum(['live', 'fixtures']).default('live'),

  // Control Panel read replica, reached with the read-only `audit_reader` role.
  CONTROL_PANEL_DATABASE_URL: z.string().optional(),
  CONTROL_PANEL_SCHEMA: z.string().default('audit'),

  // HubSpot private app.
  HUBSPOT_TOKEN: z.string().optional(),
  HUBSPOT_BASE_URL: z.string().default('https://api.hubapi.com'),
  // HubSpot internal property names (portal-specific, so configurable).
  HS_PROP_CONTROL_PANEL_ID: z.string().default('control_panel_id'),
  HS_PROP_CSM_NAME: z.string().default('csm_name'),
  HS_PROP_CSM_EMAIL: z.string().default('csm_email'),
  HS_PROP_INDUSTRY: z.string().default('industry'),
  HS_PROP_CONTRACT_END: z.string().default('contract_end_date'),
  HS_PROP_SEAT_TIER: z.string().default('seat_tier'),
  HS_PROP_PAID_SEATS: z.string().default('paid_seats'),
  HS_PROP_ARR: z.string().default('arr_ngn'),
  HS_PROP_PRICE_PER_SEAT: z.string().default('price_per_seat_monthly_ngn'),
  HS_PROP_HEALTH: z.string().default('health_status'),
  // Only companies in this lifecycle stage are audited.
  HS_CUSTOMER_LIFECYCLE_STAGE: z.string().default('customer'),

  // US-01: which seat count the ARR formula uses.
  ARR_SEAT_SOURCE: z.enum(['hubspot_paid_seats', 'control_panel_active_users']).default('hubspot_paid_seats'),

  // Alert delivery.
  ALERT_CHANNELS: csv('google_chat,email,hubspot_task'),
  ALERTS_DRY_RUN: bool, // log what would be sent; send nothing
  GOOGLE_CHAT_DEFAULT_WEBHOOK: z.string().optional(),
  FALLBACK_ALERT_EMAILS: csv(), // where alerts go when no CSM is assigned
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),

  // Links in alerts ("Acknowledge") point back at the API.
  APP_BASE_URL: z.string().default('http://localhost:8080'),
  ACK_LINK_SECRET: z.string().min(16).default('dev-only-change-me-please'),

  // Staff sign-in with Google Workspace.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_WORKSPACE_DOMAIN: z.string().optional(),
  AUTH_DISABLED: bool, // local development only

  // Claude write-ups on alerts (optional in phase 1).
  AI_RATIONALE_ENABLED: bool,
  CLAUDE_PROVIDER: z.enum(['anthropic', 'foundry']).default('foundry'),
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  AI_MAX_RATIONALES_PER_RUN: z.coerce.number().default(200),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.AUTH_DISABLED) throw new Error('AUTH_DISABLED cannot be used in production');
    if (cfg.ACK_LINK_SECRET.startsWith('dev-only')) throw new Error('Set ACK_LINK_SECRET in production');
  }
  return cfg;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
