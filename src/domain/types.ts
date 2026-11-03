import type { Kobo } from '../common/money.js';
import type { IsoDate } from '../common/calendar.js';

/** A HubSpot company as the audits see it, after property mapping. */
export interface HubSpotCompany {
  hubspotId: string;
  name: string;
  domain: string | null;
  controlPanelId: string | null;
  csmName: string | null;
  csmEmail: string | null;
  /** HubSpot owner id of the CSM, used to assign follow-up tasks. */
  csmOwnerId: string | null;
  industry: string | null;
  contractEndDate: IsoDate | null;
  seatTier: string | null;
  paidSeats: number | null;
  arrKobo: Kobo | null;
  pricePerSeatMonthlyKobo: Kobo | null;
  healthStatus: string | null;
}

export type PayFrequency = 'MONTHLY' | 'SEMI_MONTHLY' | 'BIWEEKLY' | 'WEEKLY';

/** A Control Panel client account, read from the `audit` views. */
export interface ControlPanelAccount {
  clientId: string;
  parentClientId: string | null;
  name: string;
  isActive: boolean;
  activeUsers: number;
  contractorUsers: number;
  payFrequency: PayFrequency | null;
  /** Monthly: day of month (1–31). Others: ignored. */
  payDay: number | null;
  /** Pay date of the most recent completed payroll run. */
  lastPayrollPayDate: IsoDate | null;
  lastPayrollCompletedAt: string | null;
}

export type FlagType =
  | 'ARR_MISMATCH' // US-01
  | 'SEAT_INCREASE_NO_ARR_CHANGE' // US-02
  | 'RENEWAL_NO_ARR_CHANGE' // US-02
  | 'UNLINKED_HUBSPOT_COMPANY' // US-03
  | 'UNLINKED_CONTROL_PANEL_ACCOUNT' // US-03
  | 'BROKEN_LINK' // US-03
  | 'SEAT_OVERAGE' // US-05
  | 'MISSING_FIELDS' // US-17
  | 'LATE_PAYROLL'; // US-24

export type Severity = 'urgent' | 'high' | 'medium' | 'low';

/** One problem found by an audit, before it is stored as an `audit_flag`. */
export interface Finding {
  type: FlagType;
  severity: Severity;
  /** Stable key: the same problem on the same entity keeps one open flag. */
  entityKey: string;
  hubspotCompanyId: string | null;
  controlPanelId: string | null;
  companyName: string;
  csmEmail: string | null;
  /** One-line, human-readable statement of the problem. */
  summary: string;
  /** Evidence: expected vs actual, inputs used. JSON-safe. */
  details: Record<string, unknown>;
}

/** One day's figures for a company, used to detect changes over time (US-02). */
export interface CompanyDayPoint {
  date: IsoDate;
  arrKobo: Kobo | null;
  /** Active users in Control Panel, rolled up across sub-accounts. */
  seats: number | null;
  contractEndDate: IsoDate | null;
}
