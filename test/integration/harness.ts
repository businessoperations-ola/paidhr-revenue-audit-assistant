import pg from 'pg';
import { Test } from '@nestjs/testing';
import { RATIONALE_GENERATOR, type RationaleGenerator } from '../../src/ai/rationale.service.js';
import { ALERT_SENDERS, type AlertSenders } from '../../src/alerts/channels/channels.js';
import { ApiModule, WorkerModule } from '../../src/app.module.js';
import type { AiRationale, StoredFlag } from '../../src/audits/flag.repository.js';
import { IDENTITY_VERIFIER } from '../../src/auth/auth.js';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import type { ControlPanelAccount, HubSpotCompany } from '../../src/domain/types.js';
import { FIXTURE_ACCOUNTS, FIXTURE_COMPANIES } from '../../src/sources/fixtures/fixture.sources.js';
import { CONTROL_PANEL_SOURCE, HUBSPOT_SOURCE, type HubSpotTaskInput } from '../../src/sources/source.types.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://audit:audit@localhost:5432/audit_test';
export const TEST_CP_DB = process.env.TEST_CP_DATABASE_URL ?? 'postgresql://audit:audit@localhost:5432/control_panel_test';

export async function resetDatabase(url = TEST_DB): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}

/** Mutable in-memory sources, so a test can change "reality" between days. */
export class World {
  companies: HubSpotCompany[] = structuredClone(FIXTURE_COMPANIES);
  accounts: ControlPanelAccount[] = structuredClone(FIXTURE_ACCOUNTS);
  company(id: string) {
    return this.companies.find((c) => c.hubspotId === id)!;
  }
  account(id: string) {
    return this.accounts.find((a) => a.clientId === id)!;
  }
}

/** Records everything that would have been sent. */
export class Outbox implements AlertSenders {
  chats: Array<{ url: string; text: string }> = [];
  emails: Array<{ to: string[]; subject: string; text: string; html: string }> = [];
  tasks: HubSpotTaskInput[] = [];
  failChatTimes = 0;

  chat = {
    send: async (url: string, text: string) => {
      if (this.failChatTimes > 0) {
        this.failChatTimes -= 1;
        throw new Error('Chat is down');
      }
      this.chats.push({ url, text });
      return `spaces/x/messages/${this.chats.length}`;
    },
  };
  email = {
    send: async (msg: { to: string[]; subject: string; text: string; html: string }) => {
      this.emails.push(msg);
      return `<msg-${this.emails.length}@test>`;
    },
  };
  task = {
    create: async (t: HubSpotTaskInput) => {
      this.tasks.push(t);
      return `task-${this.tasks.length}`;
    },
  };
}

export class FakeRationale implements RationaleGenerator {
  calls: number[] = [];
  async generate(flag: StoredFlag): Promise<AiRationale | null> {
    this.calls.push(flag.id);
    return { explanation: `Explained ${flag.type}`, likely_cause: 'cause', recommended_action: `Fix ${flag.companyName}`, model: 'fake' };
  }
}

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: TEST_DB,
    NODE_ENV: 'test',
    SOURCE_MODE: 'fixtures',
    GOOGLE_CHAT_DEFAULT_WEBHOOK: 'https://chat.googleapis.com/v1/spaces/TEST/messages?key=k&token=t',
    MAIL_FROM: 'audit-assistant@example.com',
    FALLBACK_ALERT_EMAILS: 'cs-leads@example.com',
    APP_BASE_URL: 'https://audit.example.com',
    ACK_LINK_SECRET: 'test-secret-0123456789',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client',
    GOOGLE_WORKSPACE_DOMAIN: 'example.com',
    ...over,
  });
}

function overrides(builder: ReturnType<typeof Test.createTestingModule>, world: World, outbox: Outbox, ai: FakeRationale) {
  return builder
    .overrideProvider(HUBSPOT_SOURCE)
    .useValue({
      fetchActiveCustomers: async () => structuredClone(world.companies),
      createTask: (t: HubSpotTaskInput) => outbox.task.create(t),
    })
    .overrideProvider(CONTROL_PANEL_SOURCE)
    .useValue({ fetchAccounts: async () => structuredClone(world.accounts) })
    .overrideProvider(ALERT_SENDERS)
    .useValue(outbox)
    .overrideProvider(RATIONALE_GENERATOR)
    .useValue(ai);
}

export async function workerApp(cfg: AppConfig, world: World, outbox: Outbox, ai = new FakeRationale()) {
  const moduleRef = await overrides(Test.createTestingModule({ imports: [WorkerModule.forRoot(cfg)] }), world, outbox, ai).compile();
  await moduleRef.init();
  return moduleRef;
}

/** Bearer token "<email>" signs in as that email (stands in for a Google ID token). */
export async function apiApp(cfg: AppConfig, world: World, outbox: Outbox) {
  const moduleRef = await overrides(Test.createTestingModule({ imports: [ApiModule.forRoot(cfg)] }), world, outbox, new FakeRationale())
    .overrideProvider(IDENTITY_VERIFIER)
    .useValue({
      verify: async (token: string) => {
        if (!token.endsWith('@example.com')) throw new Error('bad token');
        return token;
      },
    })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
