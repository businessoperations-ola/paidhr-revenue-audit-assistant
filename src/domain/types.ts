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
  /** Last logged call, meeting or email (HubSpot "Last contacted"), as a WAT date. */
  lastActivityDate: IsoDate | null;
  /** Where client broadcasts go (HubSpot company property; may hold several addresses). */
  primaryContactEmail: string | null;
  /** Latest NPS survey score for the customer, as HubSpot holds it (scale set by NPS_SCALE). */
  nps?: number | null;
  /** Latest CSAT score, as HubSpot holds it (scale set by CSAT_SCALE_MAX). */
  csat?: number | null;
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
  /** When the account was created: the start of onboarding (US-26). */
  createdOn: IsoDate | null;
  /** When payroll was first set up (pay schedule + employees). Null = not configured yet. */
  payrollConfiguredOn: IsoDate | null;
  /** Pay date of the first completed payroll run: time-to-first-value (US-26). */
  firstPayrollRunOn: IsoDate | null;
  /** Last day an employee used Earned Wage Access (US-08). */
  ewaLastUsedOn: IsoDate | null;
  /** EWA volume withdrawn in the last 30 days, in kobo (expansion radar, US-27). */
  ewaVolume30dKobo: Kobo | null;
  /** Last day a statutory remittance was processed (US-08). */
  statutoryLastUsedOn: IsoDate | null;
}

export type RevenueCategory = 'UPSELL' | 'CROSS_SELL_EWA' | 'CROSS_SELL_STATUTORY' | 'CROSS_SELL_OTHER';

/** One line of expansion revenue from billing (US-07). */
export interface RevenueLine {
  clientId: string;
  revenueDate: IsoDate;
  category: RevenueCategory;
  amountKobo: Kobo;
}

/** A HubSpot support ticket. Text is already redacted and truncated (US-12, 28). */
export interface Ticket {
  ticketId: string;
  hubspotCompanyId: string | null;
  subject: string;
  content: string;
  priority: string | null;
  createdAt: string;
  closedAt: string | null;
  isClosed: boolean;
  /** The ticket's pipeline stage, as a readable label ("Waiting on customer"). */
  statusLabel?: string | null;
  /** When support first replied. Null until they have. */
  firstResponseAt?: string | null;
  /** Who raised it at the customer, when HubSpot says (first name and initial only). */
  raisedBy?: string | null;
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
  | 'LATE_PAYROLL' // US-24
  | 'ENGAGEMENT_DROUGHT' // US-14
  | 'ONBOARDING_STAGNATION' // US-26
  | 'SUPPORT_ESCALATION_RISK' // CSAT & escalation early warning
  | 'SUPPORT_SLA_BREACH'; // tickets past their first-response or resolution target

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

export type AdminLevel = 'PRIMARY' | 'SECONDARY';

/** A customer's administrator in the Control Panel. */
export interface ClientAdmin {
  clientId: string;
  email: string;
  name: string | null;
  level: AdminLevel;
  lastLoginAt: string | null;
}

/** Something an administrator did on the platform. */
export interface AdminAction {
  clientId: string;
  email: string;
  at: string;
  action: string;
}

/** One day of employee activity for a customer: how many times, and by how many people. */
export interface EmployeeActivity {
  clientId: string;
  date: IsoDate;
  /** Product module the activity belongs to, e.g. LEAVE, LOANS, CORE_HR, PLATFORM. */
  module: string;
  /** What happened, e.g. SIGN_IN, LEAVE_REQUEST, LOAN_REQUEST, PROFILE_UPDATE. */
  eventType: string;
  events: number;
  /** Distinct employees who did this that day. */
  activeEmployees: number;
}

/** A module a customer has bought. */
export interface ClientModule {
  clientId: string;
  module: string;
  purchasedOn: IsoDate | null;
  /** When it was set up. Null = not set up yet. Undefined = the Control Panel does not say. */
  configuredOn?: IsoDate | null;
}
