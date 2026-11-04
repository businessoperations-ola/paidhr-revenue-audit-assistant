import type { AppConfig } from '../../config/config.js';
import { redactText } from '../../common/redact.js';
import type { HubSpotCompany, Ticket } from '../../domain/types.js';
import type { HubSpotSource, HubSpotTaskInput } from '../source.types.js';
import {
  mapCompany,
  propertyMapFromConfig,
  requestedProperties,
  type HubSpotCompanyRecord,
  type HubSpotPropertyMap,
} from './hubspot.mapper.js';

/** HubSpot's documented association type id for task → company. */
const TASK_TO_COMPANY_ASSOCIATION = 192;
/** HubSpot's documented association type id for note → company. */
const NOTE_TO_COMPANY_ASSOCIATION = 190;
const MAX_SEARCH_PAGES = 100; // HubSpot search returns at most 10,000 results
const PAGE_SIZE = 100;
const MAX_RETRIES = 5;

type FetchFn = typeof fetch;

/**
 * Minimal HubSpot CRM v3 client: paginated company search, owners lookup, task creation.
 * Retries 429 and 5xx with backoff, honouring Retry-After.
 */
export class HubSpotClient implements HubSpotSource {
  private readonly map: HubSpotPropertyMap;

  constructor(
    private readonly cfg: AppConfig,
    private readonly fetchFn: FetchFn = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!cfg.HUBSPOT_TOKEN) throw new Error('HUBSPOT_TOKEN is required when SOURCE_MODE=live');
    this.map = propertyMapFromConfig(cfg);
  }

  async fetchActiveCustomers(): Promise<HubSpotCompany[]> {
    const ownerEmails = await this.fetchOwnerEmails();
    const records: HubSpotCompanyRecord[] = [];
    let after: string | undefined;
    do {
      const body = {
        filterGroups: [
          { filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: this.cfg.HS_CUSTOMER_LIFECYCLE_STAGE }] },
        ],
        properties: requestedProperties(this.map),
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      };
      const page = await this.request<{ results: HubSpotCompanyRecord[]; paging?: { next?: { after: string } } }>(
        'POST',
        '/crm/v3/objects/companies/search',
        body,
      );
      records.push(...page.results);
      after = page.paging?.next?.after;
    } while (after);
    return records.map((r) => mapCompany(r, this.map, ownerEmails));
  }

  async createTask(task: HubSpotTaskInput): Promise<string> {
    const properties: Record<string, string> = {
      hs_timestamp: task.dueAt.toISOString(),
      hs_task_subject: task.subject.slice(0, 255),
      hs_task_body: task.body,
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: task.priority,
      hs_task_type: 'TODO',
    };
    if (task.ownerId) properties.hubspot_owner_id = task.ownerId;
    const created = await this.request<{ id: string }>('POST', '/crm/v3/objects/tasks', {
      properties,
      associations: [
        {
          to: { id: task.companyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_COMPANY_ASSOCIATION }],
        },
      ],
    });
    return created.id;
  }

  async createNote(note: { companyId: string; body: string; at: Date }): Promise<string> {
    const created = await this.request<{ id: string }>('POST', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: note.at.toISOString(), hs_note_body: note.body },
      associations: [
        {
          to: { id: note.companyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_COMPANY_ASSOCIATION }],
        },
      ],
    });
    return created.id;
  }

  /** Tickets changed since `sinceIso`, with their company, redacted and truncated. */
  async fetchTickets(sinceIso: string): Promise<Ticket[]> {
    const closedStages = new Set(
      this.cfg.HS_TICKET_CLOSED_STAGE_IDS.split(',').map((s) => s.trim()).filter(Boolean),
    );
    const records: Array<{ id: string; properties: Record<string, string | null | undefined> }> = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const res = await this.request<{
        results: Array<{ id: string; properties: Record<string, string | null | undefined> }>;
        paging?: { next?: { after: string } };
      }>('POST', '/crm/v3/objects/tickets/search', {
        filterGroups: [
          { filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(Date.parse(sinceIso)) }] },
        ],
        properties: ['subject', 'content', 'createdate', 'closed_date', 'hs_pipeline_stage', 'hs_ticket_priority'],
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      });
      records.push(...res.results);
      after = res.paging?.next?.after;
      if (!after) break;
    }
    const companyOf = await this.ticketCompanies(records.map((r) => r.id));
    const iso = (v: string | null | undefined): string | null => {
      if (!v) return null;
      const d = new Date(/^\d+$/.test(v) ? Number(v) : v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    return records.map((r) => {
      const p = r.properties;
      const stage = p.hs_pipeline_stage ?? '';
      const closedAt = iso(p.closed_date);
      const isClosed = closedStages.size > 0 ? closedStages.has(stage) : closedAt !== null;
      return {
        ticketId: r.id,
        hubspotCompanyId: companyOf.get(r.id) ?? null,
        subject: redactText(p.subject, 200) || '(no subject)',
        content: redactText(p.content, 500),
        priority: p.hs_ticket_priority ?? null,
        createdAt: iso(p.createdate) ?? new Date().toISOString(),
        closedAt: isClosed ? (closedAt ?? new Date().toISOString()) : null,
        isClosed,
      };
    });
  }

  private async ticketCompanies(ticketIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let i = 0; i < ticketIds.length; i += PAGE_SIZE) {
      const chunk = ticketIds.slice(i, i + PAGE_SIZE);
      const res = await this.request<{ results: Array<{ from: { id: string }; to: Array<{ toObjectId: number | string }> }> }>(
        'POST',
        '/crm/v4/associations/tickets/companies/batch/read',
        { inputs: chunk.map((id) => ({ id })) },
      );
      for (const r of res.results ?? []) {
        const first = r.to?.[0];
        if (first) map.set(String(r.from.id), String(first.toObjectId));
      }
    }
    return map;
  }

  private async fetchOwnerEmails(): Promise<Map<string, string>> {
    const emails = new Map<string, string>();
    let after: string | undefined;
    do {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), ...(after ? { after } : {}) });
      const page = await this.request<{
        results: Array<{ id: string; email?: string }>;
        paging?: { next?: { after: string } };
      }>('GET', `/crm/v3/owners?${qs}`);
      for (const o of page.results) if (o.email) emails.set(o.id, o.email.toLowerCase());
      after = page.paging?.next?.after;
    } while (after);
    return emails;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.fetchFn(`${this.cfg.HUBSPOT_BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.HUBSPOT_TOKEN}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        const text = await res.text().catch(() => '');
        throw new Error(`HubSpot ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await this.sleep(delay);
    }
  }
}
