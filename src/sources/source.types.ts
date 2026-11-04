import type { IsoDate } from '../common/calendar.js';
import type { ControlPanelAccount, HubSpotCompany, RevenueLine, Severity, Ticket } from '../domain/types.js';

export interface HubSpotTaskInput {
  companyId: string;
  ownerId: string | null;
  subject: string;
  body: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  dueAt: Date;
}

/** Read customers from HubSpot and write follow-up tasks back. */
export interface HubSpotSource {
  fetchActiveCustomers(): Promise<HubSpotCompany[]>;
  createTask(task: HubSpotTaskInput): Promise<string>;
  /** Tickets created or changed since the given moment (US-12, 28). */
  fetchTickets(sinceIso: string): Promise<Ticket[]>;
  /** Log a note on the company's activity feed (US-23). */
  createNote(note: { companyId: string; body: string; at: Date }): Promise<string>;
}

/** Read accounts from the Control Panel read replica. */
export interface ControlPanelSource {
  fetchAccounts(): Promise<ControlPanelAccount[]>;
  /** Expansion revenue lines since a date (US-07). */
  fetchRevenueLines(since: IsoDate): Promise<RevenueLine[]>;
  /** Emails of Control Panel admins, for the broadcast permission check (US-20). */
  fetchAdminEmails(): Promise<string[]>;
}

export const HUBSPOT_SOURCE = Symbol('HUBSPOT_SOURCE');
export const CONTROL_PANEL_SOURCE = Symbol('CONTROL_PANEL_SOURCE');

export function hubspotPriority(severity: Severity): HubSpotTaskInput['priority'] {
  return severity === 'urgent' || severity === 'high' ? 'HIGH' : severity === 'medium' ? 'MEDIUM' : 'LOW';
}
