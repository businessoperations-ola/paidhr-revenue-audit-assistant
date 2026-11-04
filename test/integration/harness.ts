import pg from 'pg';
import { Test } from '@nestjs/testing';
import { AI_FEATURES, type AiFeatures, type PlaybookFacts, type TicketInput } from '../../src/ai/features.js';
import { RATIONALE_GENERATOR, type RationaleGenerator } from '../../src/ai/rationale.service.js';
import { ALERT_SENDERS, type AlertSenders } from '../../src/alerts/channels/channels.js';
import { ApiModule, WorkerModule } from '../../src/app.module.js';
import type { AiRationale, StoredFlag } from '../../src/audits/flag.repository.js';
import { IDENTITY_VERIFIER } from '../../src/auth/auth.js';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import type { ClientModule, ControlPanelAccount, HubSpotCompany, RevenueLine, Ticket } from '../../src/domain/types.js';
import { FIXTURE_ACCOUNTS, FIXTURE_COMPANIES, FIXTURE_MODULES, FIXTURE_REVENUE, FIXTURE_TICKETS, fixtureAdminActions, fixtureAdmins, fixtureEmployeeActivity } from '../../src/sources/fixtures/fixture.sources.js';
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
  tickets: Ticket[] = structuredClone(FIXTURE_TICKETS);
  revenue: RevenueLine[] = structuredClone(FIXTURE_REVENUE);
  adminEmails: string[] = ['admin@example.com', 'director@example.com'];
  modules: ClientModule[] = structuredClone(FIXTURE_MODULES);
  /** Anchor for the generated adoption data; tests that need a fixed day can change it. */
  now = new Date();
  /** Notes written to the HubSpot activity feed. */
  notes: Array<{ companyId: string; body: string; at: Date }> = [];
  ticket(id: string) {
    return this.tickets.find((t) => t.ticketId === id)!;
  }
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

/** Scripted Claude: deterministic answers, plus deliberate mistakes to prove the code checks them. */
export class FakeAi implements AiFeatures {
  calls = { playbook: 0, qbr: 0, clusters: 0, sentiment: 0 };
  lastPlaybookFacts: PlaybookFacts | null = null;
  lastQbrFacts: Record<string, unknown> | null = null;
  lastTickets: TicketInput[] = [];
  /** Ticket ids to score as very frustrated. */
  frustrated = new Set<string>();
  /** When true, every call returns nothing, as if Claude refused or was down. */
  down = false;

  private meta = { model: 'fake-claude', inputTokens: 100, outputTokens: 50 };

  async playbook(facts: PlaybookFacts) {
    this.calls.playbook += 1;
    this.lastPlaybookFacts = facts;
    if (this.down) return null;
    return {
      ...this.meta,
      value: {
        summary: `${facts.company} has not set up payroll after ${facts.daysInOnboarding} days.`,
        likely_blockers: ['Pay schedule not configured', 'Employees not imported', 'Extra blocker 3', 'Extra blocker 4', 'Extra blocker 5'],
        steps: Array.from({ length: 8 }, (_, i) => ({ action: `Step ${i + 1} for ${facts.company}`, owner: 'implementation_manager' as const, within: 'today' })),
        escalate_if: 'No reply from the HR admin in 3 days',
      },
    };
  }

  async qbr(facts: Record<string, unknown>) {
    this.calls.qbr += 1;
    this.lastQbrFacts = facts;
    if (this.down) return null;
    const company = (facts.company as { name: string }).name;
    return {
      ...this.meta,
      value: {
        title: `${company} QBR`, executive_summary: 'Summary.', health_narrative: 'Narrative.', wins: ['Win'], risks: ['Risk'],
        growth_opportunities: [{ opportunity: 'EWA', evidence: 'High volume', suggested_ask: 'Cross-sell' }], questions_for_client: ['Q?'],
        slides: Array.from({ length: 10 }, (_, i) => ({ title: `Slide ${i + 1}`, bullets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })),
      },
    };
  }

  async clusters(tickets: TicketInput[]) {
    this.calls.clusters += 1;
    this.lastTickets = tickets;
    if (this.down) return null;
    const ids = (re: RegExp) => tickets.filter((t) => re.test(t.subject)).map((t) => t.id);
    const theme = (name: string, ticket_ids: string[]) => ({
      name, root_cause: `${name} root cause`, ticket_ids, suggested_fix: `Fix ${name}`,
      macro: { subject: `Re: ${name}`, body: 'Hi {{customer_name}}, ...' }, kb_article: { title: `How to fix ${name}`, outline: ['One', 'Two'] },
    });
    return {
      ...this.meta,
      value: {
        themes: [
          theme('Payroll formula setup', [...ids(/formula|PAYE/i), 'T-9999']), // T-9999 does not exist
          theme('Statutory remittance', [...ids(/pension|NHF|remittance/i), ...ids(/formula/i).slice(0, 1)]), // one ticket already used above
          theme('Ghost theme', ['T-8888']), // nothing real in it
          theme('Login and access', ids(/log ?in|password/i)),
        ],
        unclustered_note: 'A few tickets fit no theme.',
      },
    };
  }

  async sentiment(tickets: TicketInput[]) {
    this.calls.sentiment += 1;
    this.lastTickets = tickets;
    if (this.down) return null;
    return {
      ...this.meta,
      value: {
        scores: [
          ...tickets.map((t) => ({ ticket_id: t.id, sentiment: this.frustrated.has(t.id) ? -2 : 0, signal: this.frustrated.has(t.id) ? 'Customer is very frustrated' : 'Neutral' })),
          { ticket_id: 'T-NOT-ASKED', sentiment: -2, signal: 'Not a real ticket' },
        ],
      },
    };
  }
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

function overrides(builder: ReturnType<typeof Test.createTestingModule>, world: World, outbox: Outbox, ai: FakeRationale, aiFeatures: FakeAi) {
  return builder
    .overrideProvider(HUBSPOT_SOURCE)
    .useValue({
      fetchActiveCustomers: async () => structuredClone(world.companies),
      createTask: (t: HubSpotTaskInput) => outbox.task.create(t),
      fetchTickets: async () => structuredClone(world.tickets),
      createNote: async (n: { companyId: string; body: string; at: Date }) => {
        world.notes.push(n);
        return `note-${world.notes.length}`;
      },
    })
    .overrideProvider(CONTROL_PANEL_SOURCE)
    .useValue({
      fetchAccounts: async () => structuredClone(world.accounts),
      fetchRevenueLines: async () => structuredClone(world.revenue),
      fetchAdminEmails: async () => world.adminEmails,
      fetchClientAdmins: async () => fixtureAdmins(world.now),
      fetchAdminActions: async () => fixtureAdminActions(world.now),
      fetchEmployeeActivity: async (since: string) => fixtureEmployeeActivity(world.now, since),
      fetchClientModules: async () => structuredClone(world.modules),
    })
    .overrideProvider(ALERT_SENDERS)
    .useValue(outbox)
    .overrideProvider(RATIONALE_GENERATOR)
    .useValue(ai)
    .overrideProvider(AI_FEATURES)
    .useValue(aiFeatures);
}

export async function workerApp(cfg: AppConfig, world: World, outbox: Outbox, ai = new FakeRationale(), aiFeatures = new FakeAi()) {
  const moduleRef = await overrides(Test.createTestingModule({ imports: [WorkerModule.forRoot(cfg)] }), world, outbox, ai, aiFeatures).compile();
  await moduleRef.init();
  return moduleRef;
}

/** Bearer token "<email>" signs in as that email (stands in for a Google ID token). */
export async function apiApp(cfg: AppConfig, world: World, outbox: Outbox, aiFeatures = new FakeAi()) {
  const moduleRef = await overrides(Test.createTestingModule({ imports: [ApiModule.forRoot(cfg)] }), world, outbox, new FakeRationale(), aiFeatures)
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
