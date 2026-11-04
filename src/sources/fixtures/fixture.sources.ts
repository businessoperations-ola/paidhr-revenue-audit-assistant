import type { IsoDate } from '../../common/calendar.js';
import type {
  AdminAction,
  ClientAdmin,
  ClientModule,
  ControlPanelAccount,
  EmployeeActivity,
  HubSpotCompany,
  RevenueLine,
  Ticket,
} from '../../domain/types.js';
import type { ControlPanelSource, HubSpotSource, HubSpotTaskInput } from '../source.types.js';

const NGN = (naira: number) => BigInt(naira) * 100n;

/**
 * Demo data with one example of every problem the system detects, so the pipeline can be
 * run end to end before real credentials exist. All names are fictional.
 * "Today" in the demo is 2026-11-03.
 */
export const FIXTURE_COMPANIES: HubSpotCompany[] = [
  {
    // Clean: 50 × ₦2,500 × 12 = ₦1,500,000
    hubspotId: '1001', name: 'Adebayo Logistics', domain: 'adebayo-logistics.example', controlPanelId: 'CP-100',
    csmName: 'Ngozi Okafor', csmEmail: 'ngozi.okafor@example.com', csmOwnerId: '501', industry: 'Logistics',
    contractEndDate: '2027-03-31', seatTier: '50-99', paidSeats: 50, arrKobo: NGN(1_500_000),
    pricePerSeatMonthlyKobo: NGN(2_500), healthStatus: 'Healthy', lastActivityDate: '2026-10-20',
    primaryContactEmail: 'hr@adebayo-logistics.example',
  },
  {
    // US-01: 40 × ₦3,000 × 12 = ₦1,440,000 but ARR says ₦1,200,000
    hubspotId: '1002', name: 'Lekki Foods', domain: 'lekkifoods.example', controlPanelId: 'CP-200',
    csmName: 'Ngozi Okafor', csmEmail: 'ngozi.okafor@example.com', csmOwnerId: '501', industry: 'FMCG',
    contractEndDate: '2026-12-31', seatTier: '25-49', paidSeats: 40, arrKobo: NGN(1_200_000),
    pricePerSeatMonthlyKobo: NGN(3_000), healthStatus: 'Neutral', lastActivityDate: '2026-10-30',
    primaryContactEmail: 'people@lekkifoods.example',
  },
  {
    // US-05: parent + 2 sub-accounts have 130 users vs 100 paid seats
    hubspotId: '1003', name: 'Kano Holdings Group', domain: 'kanoholdings.example', controlPanelId: 'CP-300',
    csmName: 'Tunde Bello', csmEmail: 'tunde.bello@example.com', csmOwnerId: '502', industry: 'Conglomerate',
    contractEndDate: '2027-06-30', seatTier: '100+', paidSeats: 100, arrKobo: NGN(2_400_000),
    pricePerSeatMonthlyKobo: NGN(2_000), healthStatus: 'Healthy',
    lastActivityDate: '2026-09-20', // US-14: 44 days, Healthy limit is 30
    primaryContactEmail: 'hr@kanoholdings.example',
  },
  {
    // US-17: missing Industry and Seat Tier. US-03: no Control Panel ID.
    hubspotId: '1004', name: 'Ibadan Clinics', domain: null, controlPanelId: null,
    csmName: 'Tunde Bello', csmEmail: 'tunde.bello@example.com', csmOwnerId: '502', industry: null,
    contractEndDate: '2027-01-31', seatTier: null, paidSeats: 20, arrKobo: NGN(480_000),
    pricePerSeatMonthlyKobo: NGN(2_000), healthStatus: 'At Risk',
    lastActivityDate: '2026-10-24', // US-14: 10 days, At Risk limit is 7
    primaryContactEmail: null,
  },
  {
    // US-03: linked to an account that was deactivated
    hubspotId: '1005', name: 'Enugu Steel', domain: 'enugusteel.example', controlPanelId: 'CP-500',
    csmName: null, csmEmail: null, csmOwnerId: null, industry: 'Manufacturing',
    contractEndDate: '2026-11-30', seatTier: '25-49', paidSeats: 30, arrKobo: NGN(900_000),
    pricePerSeatMonthlyKobo: NGN(2_500), healthStatus: 'At Risk',
    lastActivityDate: null, // US-14: never contacted
    primaryContactEmail: 'admin@enugusteel.example',
  },
  {
    // US-26: signed up 22 days ago, payroll still not configured. 15 × ₦2,000 × 12 = ₦360,000
    hubspotId: '1006', name: 'Abuja Tech Hub', domain: 'abujatechhub.example', controlPanelId: 'CP-700',
    csmName: 'Tunde Bello', csmEmail: 'tunde.bello@example.com', csmOwnerId: '502', industry: 'Technology',
    contractEndDate: '2027-10-11', seatTier: '10-24', paidSeats: 15, arrKobo: NGN(360_000),
    pricePerSeatMonthlyKobo: NGN(2_000), healthStatus: 'Neutral', lastActivityDate: '2026-10-30',
    primaryContactEmail: 'ops@abujatechhub.example; hr@abujatechhub.example',
  },
];

export const FIXTURE_ACCOUNTS: ControlPanelAccount[] = [
  {
    clientId: 'CP-100', parentClientId: null, name: 'Adebayo Logistics', isActive: true, activeUsers: 48,
    contractorUsers: 3, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25',
    lastPayrollCompletedAt: '2026-10-24T14:02:00Z',
    createdOn: '2024-02-10', payrollConfiguredOn: '2024-02-20', firstPayrollRunOn: '2024-02-25',
    ewaLastUsedOn: '2026-10-30', ewaVolume30dKobo: NGN(2_400_000), statutoryLastUsedOn: '2026-10-25',
  },
  {
    // US-24: monthly on the 28th; October's run never happened
    clientId: 'CP-200', parentClientId: null, name: 'Lekki Foods', isActive: true, activeUsers: 40,
    contractorUsers: 0, payFrequency: 'MONTHLY', payDay: 28, lastPayrollPayDate: '2026-09-28',
    lastPayrollCompletedAt: '2026-09-26T10:15:00Z',
    createdOn: '2025-03-05', payrollConfiguredOn: '2025-03-12', firstPayrollRunOn: '2025-03-28',
    ewaLastUsedOn: '2026-09-10', ewaVolume30dKobo: 0n, statutoryLastUsedOn: '2026-09-28',
  },
  {
    clientId: 'CP-300', parentClientId: null, name: 'Kano Holdings Group', isActive: true, activeUsers: 60,
    contractorUsers: 5, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25',
    lastPayrollCompletedAt: '2026-10-23T09:00:00Z',
    createdOn: '2023-06-01', payrollConfiguredOn: '2023-06-10', firstPayrollRunOn: '2023-06-25',
    ewaLastUsedOn: '2026-10-31', ewaVolume30dKobo: NGN(7_800_000), statutoryLastUsedOn: '2026-10-25',
  },
  {
    clientId: 'CP-301', parentClientId: 'CP-300', name: 'Kano Holdings – Cement', isActive: true, activeUsers: 45,
    contractorUsers: 10, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25',
    lastPayrollCompletedAt: '2026-10-23T09:30:00Z',
    createdOn: '2023-07-01', payrollConfiguredOn: '2023-07-08', firstPayrollRunOn: '2023-07-25',
    ewaLastUsedOn: '2026-10-29', ewaVolume30dKobo: NGN(3_100_000), statutoryLastUsedOn: '2026-10-25',
  },
  {
    clientId: 'CP-302', parentClientId: 'CP-300', name: 'Kano Holdings – Agro', isActive: true, activeUsers: 25,
    contractorUsers: 8, payFrequency: 'SEMI_MONTHLY', payDay: null, lastPayrollPayDate: '2026-10-31',
    lastPayrollCompletedAt: '2026-10-30T16:00:00Z',
    createdOn: '2024-01-15', payrollConfiguredOn: '2024-01-20', firstPayrollRunOn: '2024-01-31',
    ewaLastUsedOn: null, ewaVolume30dKobo: 0n, statutoryLastUsedOn: '2026-10-31',
  },
  {
    clientId: 'CP-500', parentClientId: null, name: 'Enugu Steel', isActive: false, activeUsers: 0,
    contractorUsers: 0, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-08-25',
    lastPayrollCompletedAt: '2026-08-24T12:00:00Z',
    createdOn: '2022-01-10', payrollConfiguredOn: '2022-01-20', firstPayrollRunOn: '2022-01-25',
    ewaLastUsedOn: null, ewaVolume30dKobo: null, statutoryLastUsedOn: '2026-08-25',
  },
  {
    // US-03: active in Control Panel, missing from HubSpot. Onboarded successfully in 32 days.
    clientId: 'CP-600', parentClientId: null, name: 'Port Harcourt Marine', isActive: true, activeUsers: 12,
    contractorUsers: 0, payFrequency: 'MONTHLY', payDay: 30, lastPayrollPayDate: '2026-10-30',
    lastPayrollCompletedAt: '2026-10-29T08:00:00Z',
    createdOn: '2026-09-28', payrollConfiguredOn: '2026-10-02', firstPayrollRunOn: '2026-10-30',
    ewaLastUsedOn: null, ewaVolume30dKobo: null, statutoryLastUsedOn: null,
  },
  {
    // US-26: created 22 days ago, no payroll configured
    clientId: 'CP-700', parentClientId: null, name: 'Abuja Tech Hub', isActive: true, activeUsers: 14,
    contractorUsers: 2, payFrequency: null, payDay: null, lastPayrollPayDate: null, lastPayrollCompletedAt: null,
    createdOn: '2026-10-12', payrollConfiguredOn: null, firstPayrollRunOn: null,
    ewaLastUsedOn: null, ewaVolume30dKobo: null, statutoryLastUsedOn: null,
  },
];

const T = (
  ticketId: string, company: string | null, subject: string, content: string,
  createdAt: string, closedAt: string | null, priority: string | null = 'MEDIUM',
): Ticket => ({ ticketId, hubspotCompanyId: company, subject, content, priority, createdAt, closedAt, isClosed: closedAt !== null });

/** 14 tickets across five themes, so clustering has something real to group. */
export const FIXTURE_TICKETS: Ticket[] = [
  T('T-1001', '1003', 'PAYE computed incorrectly for housing allowance', 'After we changed the salary structure the PAYE on housing allowance looks too high for 12 staff.', '2026-10-20T09:10:00Z', null, 'HIGH'),
  T('T-1002', '1003', 'Pension remittance schedule does not match payroll', 'The pension schedule total is different from net pay deductions for September.', '2026-10-22T11:00:00Z', '2026-10-25T15:00:00Z'),
  T('T-1003', '1001', 'Overtime formula not applying to drivers', 'We set an overtime formula but payslips show zero overtime for the driver group.', '2026-10-05T08:30:00Z', '2026-10-07T10:00:00Z'),
  T('T-1004', '1001', 'Cannot reset password for HR admin', 'HR admin is locked out and the reset email never arrives.', '2026-10-12T07:45:00Z', '2026-10-12T09:30:00Z'),
  T('T-1005', '1002', 'Statutory remittance report missing NHF column', 'The NHF contribution column is missing from the remittance export.', '2026-10-15T13:20:00Z', '2026-10-18T09:00:00Z'),
  T('T-1006', '1002', 'Basic salary formula wrong after import', 'After importing employees the basic salary percentage formula returns the wrong amount.', '2026-10-28T10:00:00Z', null),
  T('T-1007', '1004', 'EWA activation not showing for staff', 'We switched on earned wage access but staff cannot see the option in the app.', '2026-10-30T14:10:00Z', null),
  T('T-1008', '1004', 'Login keeps failing for new employee', 'A new employee cannot log in even after the invite link was resent.', '2026-10-29T09:00:00Z', '2026-10-30T12:00:00Z'),
  T('T-1009', '1006', 'Unable to configure payroll pay schedule', 'We cannot find where to set the pay schedule, and the setup wizard stops at step three.', '2026-10-14T08:00:00Z', null, 'HIGH'),
  T('T-1010', '1006', 'Employee import template errors', 'The import template rejects our file with a column mapping error.', '2026-10-13T12:00:00Z', '2026-10-15T09:00:00Z'),
  T('T-1011', '1005', 'Please confirm account closure', 'Please confirm our account has been closed and no further charges apply.', '2026-10-01T09:00:00Z', '2026-10-02T09:00:00Z', 'LOW'),
  T('T-1012', '1003', 'Pension fund administrator not listed', 'One of our pension fund administrators is missing from the dropdown for remittance.', '2026-10-24T10:30:00Z', null),
  T('T-1013', '1001', 'Pro-rata formula for new joiners wrong', 'The pro-rata salary for mid-month joiners is calculated on 30 days instead of working days.', '2026-10-19T10:00:00Z', '2026-10-20T16:00:00Z'),
  T('T-1014', '1002', 'NHF deduction mismatch in payslip', 'NHF on the payslip does not match the remittance report.', '2026-10-26T09:30:00Z', '2026-10-30T11:00:00Z'),
];

const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
/** Status, who raised it, and when support first replied, so the SLA clocks have something to measure. */
const TICKET_EXTRAS: Record<string, { status: string; by: string; replyAfterHours: number | null }> = {
  'T-1001': { status: 'Waiting on support', by: 'Chidi O.', replyAfterHours: null },
  'T-1006': { status: 'In progress', by: 'Seun C.', replyAfterHours: 5 },
  'T-1007': { status: 'Waiting on customer', by: 'Ayo K.', replyAfterHours: 2 },
  'T-1009': { status: 'In progress', by: 'Tari O.', replyAfterHours: 9 },
  'T-1012': { status: 'New', by: 'Chidi O.', replyAfterHours: null },
};
for (const t of FIXTURE_TICKETS) {
  const x = TICKET_EXTRAS[t.ticketId];
  t.statusLabel = t.isClosed ? 'Closed' : (x?.status ?? 'In progress');
  t.raisedBy = x?.by ?? null;
  t.firstResponseAt = x ? (x.replyAfterHours === null ? null : plusHours(t.createdAt, x.replyAfterHours)) : plusHours(t.createdAt, 3);
}

export const FIXTURE_REVENUE: RevenueLine[] = [
  { clientId: 'CP-100', revenueDate: '2026-10-10', category: 'CROSS_SELL_OTHER', amountKobo: NGN(60_000) },
  { clientId: 'CP-100', revenueDate: '2026-10-15', category: 'UPSELL', amountKobo: NGN(300_000) },
  { clientId: 'CP-100', revenueDate: '2026-10-28', category: 'CROSS_SELL_EWA', amountKobo: NGN(180_000) },
  { clientId: 'CP-300', revenueDate: '2026-10-20', category: 'UPSELL', amountKobo: NGN(600_000) },
  { clientId: 'CP-300', revenueDate: '2026-10-31', category: 'CROSS_SELL_EWA', amountKobo: NGN(420_000) },
  { clientId: 'CP-300', revenueDate: '2026-10-31', category: 'CROSS_SELL_STATUTORY', amountKobo: NGN(250_000) },
  { clientId: 'CP-200', revenueDate: '2026-10-30', category: 'CROSS_SELL_STATUTORY', amountKobo: NGN(90_000) },
];

export class FixtureHubSpotSource implements HubSpotSource {
  readonly tasks: HubSpotTaskInput[] = [];
  readonly notes: Array<{ companyId: string; body: string; at: Date }> = [];
  constructor(
    private readonly companies: HubSpotCompany[] = FIXTURE_COMPANIES,
    private readonly tickets: Ticket[] = FIXTURE_TICKETS,
  ) {}
  async fetchActiveCustomers(): Promise<HubSpotCompany[]> {
    return this.companies.map((c) => ({ ...c }));
  }
  async createTask(task: HubSpotTaskInput): Promise<string> {
    this.tasks.push(task);
    return `fixture-task-${this.tasks.length}`;
  }
  async fetchTickets(): Promise<Ticket[]> {
    return this.tickets.map((t) => ({ ...t }));
  }
  async createNote(note: { companyId: string; body: string; at: Date }): Promise<string> {
    this.notes.push(note);
    return `fixture-note-${this.notes.length}`;
  }
}

// ---------------------------------------------------------------- adoption fixtures (relative to "now", so the demo always looks current)

const DAY_MS = 86_400_000;
const at = (now: Date, daysAgo: number, hour = 9, minute = 0): string => {
  const d = new Date(now.getTime() - daysAgo * DAY_MS);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

export const FIXTURE_MODULES: ClientModule[] = [
  ...['PAYROLL', 'CORE_HR', 'LEAVE', 'EWA'].map((module) => ({ clientId: 'CP-100', module, purchasedOn: '2025-03-01' })),
  ...['PAYROLL', 'CORE_HR', 'LEAVE', 'STATUTORY'].map((module) => ({ clientId: 'CP-200', module, purchasedOn: '2025-06-15' })),
  ...['PAYROLL', 'CORE_HR', 'LEAVE', 'LOANS', 'EWA', 'STATUTORY'].map((module) => ({ clientId: 'CP-300', module, purchasedOn: '2024-12-01' })),
  ...['PAYROLL', 'CORE_HR'].map((module) => ({ clientId: 'CP-600', module, purchasedOn: '2026-09-28' })),
  ...['PAYROLL', 'CORE_HR'].map((module) => ({ clientId: 'CP-700', module, purchasedOn: '2026-10-12' })),
];

/** Who the admins are. Lekki's primary admin has gone quiet; Kano's secondary has never logged in. */
export function fixtureAdmins(now: Date): ClientAdmin[] {
  return [
    { clientId: 'CP-100', email: 'ifeoma@adebayo-logistics.example', name: 'Ifeoma Adebayo', level: 'PRIMARY', lastLoginAt: at(now, 1, 8, 12) },
    { clientId: 'CP-100', email: 'musa@adebayo-logistics.example', name: 'Musa Danjuma', level: 'SECONDARY', lastLoginAt: at(now, 9, 14, 40) },
    { clientId: 'CP-200', email: 'bola@lekkifoods.example', name: 'Bola Ajayi', level: 'PRIMARY', lastLoginAt: at(now, 41, 10, 5) },
    { clientId: 'CP-200', email: 'seun@lekkifoods.example', name: 'Seun Coker', level: 'SECONDARY', lastLoginAt: at(now, 12, 16, 20) },
    { clientId: 'CP-300', email: 'halima@kanoholdings.example', name: 'Halima Sani', level: 'PRIMARY', lastLoginAt: at(now, 3, 9, 30) },
    { clientId: 'CP-300', email: 'yusuf@kanoholdings.example', name: 'Yusuf Bello', level: 'SECONDARY', lastLoginAt: null },
    { clientId: 'CP-600', email: 'ngozi@phmarine.example', name: 'Ngozi Eke', level: 'PRIMARY', lastLoginAt: at(now, 2, 11, 0) },
    { clientId: 'CP-700', email: 'tari@abujatech.example', name: 'Tari Okon', level: 'PRIMARY', lastLoginAt: at(now, 6, 13, 15) },
  ];
}

export function fixtureAdminActions(now: Date): AdminAction[] {
  const a = (clientId: string, email: string, daysAgo: number, action: string, hour = 10): AdminAction => ({ clientId, email, at: at(now, daysAgo, hour), action });
  return [
    a('CP-100', 'ifeoma@adebayo-logistics.example', 1, 'Approved 6 leave requests', 8),
    a('CP-100', 'ifeoma@adebayo-logistics.example', 3, 'Ran October payroll', 15),
    a('CP-100', 'ifeoma@adebayo-logistics.example', 5, 'Added 2 new employees', 9),
    a('CP-100', 'musa@adebayo-logistics.example', 9, 'Updated pension settings', 14),
    a('CP-200', 'seun@lekkifoods.example', 12, 'Approved 3 loan requests', 16),
    a('CP-200', 'bola@lekkifoods.example', 41, 'Opened the payroll run screen', 10),
    a('CP-300', 'halima@kanoholdings.example', 3, 'Downloaded the September remittance schedule', 9),
    a('CP-300', 'halima@kanoholdings.example', 4, 'Ran October payroll for Kano Cement', 11),
    a('CP-300', 'halima@kanoholdings.example', 11, 'Invited 12 employees', 13),
    a('CP-600', 'ngozi@phmarine.example', 2, 'Edited the pay schedule', 11),
    a('CP-700', 'tari@abujatech.example', 6, 'Imported employees (14 rows)', 13),
  ];
}

/** A small deterministic wobble so charts look real but tests stay stable. */
const wobble = (n: number) => 0.75 + (((n * 9301 + 49297) % 233280) / 233280) * 0.5;

const ACTIVITY_PROFILE: Array<{ clientId: string; users: number; modules: Array<{ module: string; event: string; perUser: number }> }> = [
  { clientId: 'CP-100', users: 48, modules: [{ module: 'PLATFORM', event: 'SIGN_IN', perUser: 0.8 }, { module: 'LEAVE', event: 'LEAVE_REQUEST', perUser: 0.06 }, { module: 'CORE_HR', event: 'PROFILE_UPDATE', perUser: 0.04 }, { module: 'EWA', event: 'EWA_REQUEST', perUser: 0.05 }] },
  { clientId: 'CP-200', users: 40, modules: [{ module: 'PLATFORM', event: 'SIGN_IN', perUser: 0.35 }, { module: 'LEAVE', event: 'LEAVE_REQUEST', perUser: 0.03 }, { module: 'CORE_HR', event: 'PROFILE_UPDATE', perUser: 0.01 }] },
  { clientId: 'CP-301', users: 45, modules: [{ module: 'PLATFORM', event: 'SIGN_IN', perUser: 0.9 }, { module: 'LEAVE', event: 'LEAVE_REQUEST', perUser: 0.07 }, { module: 'CORE_HR', event: 'PROFILE_UPDATE', perUser: 0.05 }, { module: 'EWA', event: 'EWA_REQUEST', perUser: 0.12 }] },
  { clientId: 'CP-302', users: 25, modules: [{ module: 'PLATFORM', event: 'SIGN_IN', perUser: 0.7 }, { module: 'LEAVE', event: 'LEAVE_REQUEST', perUser: 0.05 }, { module: 'EWA', event: 'EWA_REQUEST', perUser: 0.1 }] },
  { clientId: 'CP-600', users: 12, modules: [{ module: 'PLATFORM', event: 'SIGN_IN', perUser: 0.6 }, { module: 'CORE_HR', event: 'PROFILE_UPDATE', perUser: 0.1 }] },
  { clientId: 'CP-700', users: 14, modules: [{ module: 'PLATFORM', event: 'SIGN_IN', perUser: 0.15 }] },
];

/** 90 days of activity. Kano bought Loans and nobody uses it; Lekki's use is falling. */
export function fixtureEmployeeActivity(now: Date, since: IsoDate): EmployeeActivity[] {
  const out: EmployeeActivity[] = [];
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  for (let back = 0; back < 90; back += 1) {
    const d = new Date(now.getTime() - back * DAY_MS);
    if (d.getTime() < sinceMs) break;
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = d.toISOString().slice(0, 10);
    ACTIVITY_PROFILE.forEach((p, pi) => {
      const fade = p.clientId === 'CP-200' ? Math.min(1, 0.35 + back / 60) : 1; // Lekki: busier a few months ago
      p.modules.forEach((m, mi) => {
        const events = Math.round(p.users * m.perUser * wobble(back * 31 + pi * 7 + mi) * fade);
        if (events <= 0) return;
        out.push({ clientId: p.clientId, date, module: m.module, eventType: m.event, events, activeEmployees: Math.max(1, Math.min(p.users, Math.round(events * (m.event === 'SIGN_IN' ? 0.9 : 0.8)))) });
      });
    });
  }
  return out;
}

export class FixtureControlPanelSource implements ControlPanelSource {
  constructor(
    private readonly accounts: ControlPanelAccount[] = FIXTURE_ACCOUNTS,
    private readonly revenue: RevenueLine[] = FIXTURE_REVENUE,
  ) {}
  async fetchAccounts(): Promise<ControlPanelAccount[]> {
    return this.accounts.map((a) => ({ ...a }));
  }
  async fetchRevenueLines(): Promise<RevenueLine[]> {
    return this.revenue.map((r) => ({ ...r }));
  }
  async fetchAdminEmails(): Promise<string[]> {
    return ['admin@example.com', 'director@example.com'];
  }
  async fetchClientAdmins(): Promise<ClientAdmin[]> {
    return fixtureAdmins(new Date());
  }
  async fetchAdminActions(): Promise<AdminAction[]> {
    return fixtureAdminActions(new Date());
  }
  async fetchEmployeeActivity(since: IsoDate): Promise<EmployeeActivity[]> {
    return fixtureEmployeeActivity(new Date(), since);
  }
  async fetchClientModules(): Promise<ClientModule[]> {
    return FIXTURE_MODULES.map((m) => ({ ...m }));
  }
}
