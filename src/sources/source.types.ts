import type { ControlPanelAccount, HubSpotCompany, Severity } from '../domain/types.js';

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
}

/** Read accounts from the Control Panel read replica. */
export interface ControlPanelSource {
  fetchAccounts(): Promise<ControlPanelAccount[]>;
}

export const HUBSPOT_SOURCE = Symbol('HUBSPOT_SOURCE');
export const CONTROL_PANEL_SOURCE = Symbol('CONTROL_PANEL_SOURCE');

export function hubspotPriority(severity: Severity): HubSpotTaskInput['priority'] {
  return severity === 'urgent' || severity === 'high' ? 'HIGH' : severity === 'medium' ? 'MEDIUM' : 'LOW';
}
