import type {
  ControlPanelAccount,
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
}
