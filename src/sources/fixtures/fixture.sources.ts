import type { ControlPanelAccount, HubSpotCompany } from '../../domain/types.js';
import type { ControlPanelSource, HubSpotSource, HubSpotTaskInput } from '../source.types.js';

const NGN = (naira: number) => BigInt(naira) * 100n;

/**
 * Demo data with one example of every phase-1 problem, so the pipeline can be
 * run end to end before real credentials exist. All names are fictional.
 */
export const FIXTURE_COMPANIES: HubSpotCompany[] = [
  {
    // Clean: 50 × ₦2,500 × 12 = ₦1,500,000
    hubspotId: '1001', name: 'Adebayo Logistics', domain: 'adebayo-logistics.example', controlPanelId: 'CP-100',
    csmName: 'Ngozi Okafor', csmEmail: 'ngozi.okafor@example.com', csmOwnerId: '501', industry: 'Logistics',
    contractEndDate: '2027-03-31', seatTier: '50-99', paidSeats: 50, arrKobo: NGN(1_500_000),
    pricePerSeatMonthlyKobo: NGN(2_500), healthStatus: 'Healthy', lastActivityDate: '2026-10-20',
  },
  {
    // US-01: 40 × ₦3,000 × 12 = ₦1,440,000 but ARR says ₦1,200,000
    hubspotId: '1002', name: 'Lekki Foods', domain: 'lekkifoods.example', controlPanelId: 'CP-200',
    csmName: 'Ngozi Okafor', csmEmail: 'ngozi.okafor@example.com', csmOwnerId: '501', industry: 'FMCG',
    contractEndDate: '2026-12-31', seatTier: '25-49', paidSeats: 40, arrKobo: NGN(1_200_000),
    pricePerSeatMonthlyKobo: NGN(3_000), healthStatus: 'Neutral', lastActivityDate: '2026-10-30',
  },
  {
    // US-05: parent + 2 sub-accounts have 130 users vs 100 paid seats
    hubspotId: '1003', name: 'Kano Holdings Group', domain: 'kanoholdings.example', controlPanelId: 'CP-300',
    csmName: 'Tunde Bello', csmEmail: 'tunde.bello@example.com', csmOwnerId: '502', industry: 'Conglomerate',
    contractEndDate: '2027-06-30', seatTier: '100+', paidSeats: 100, arrKobo: NGN(2_400_000),
    pricePerSeatMonthlyKobo: NGN(2_000), healthStatus: 'Healthy',
    lastActivityDate: '2026-09-20', // US-14: 44 days, Healthy limit is 30
  },
  {
    // US-17: missing Industry and Seat Tier. US-03: no Control Panel ID.
    hubspotId: '1004', name: 'Ibadan Clinics', domain: null, controlPanelId: null,
    csmName: 'Tunde Bello', csmEmail: 'tunde.bello@example.com', csmOwnerId: '502', industry: null,
    contractEndDate: '2027-01-31', seatTier: null, paidSeats: 20, arrKobo: NGN(480_000),
    pricePerSeatMonthlyKobo: NGN(2_000), healthStatus: 'At Risk',
    lastActivityDate: '2026-10-24', // US-14: 10 days, At Risk limit is 7
  },
  {
    // US-03: linked to an account that was deactivated
    hubspotId: '1005', name: 'Enugu Steel', domain: 'enugusteel.example', controlPanelId: 'CP-500',
    csmName: null, csmEmail: null, csmOwnerId: null, industry: 'Manufacturing',
    contractEndDate: '2026-11-30', seatTier: '25-49', paidSeats: 30, arrKobo: NGN(900_000),
    pricePerSeatMonthlyKobo: NGN(2_500), healthStatus: 'At Risk',
    lastActivityDate: null, // US-14: never contacted
  },
];

export const FIXTURE_ACCOUNTS: ControlPanelAccount[] = [
  {
    clientId: 'CP-100', parentClientId: null, name: 'Adebayo Logistics', isActive: true, activeUsers: 48,
    contractorUsers: 3, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25',
    lastPayrollCompletedAt: '2026-10-24T14:02:00Z',
  },
  {
    // US-24: monthly on the 28th; October's run never happened
    clientId: 'CP-200', parentClientId: null, name: 'Lekki Foods', isActive: true, activeUsers: 40,
    contractorUsers: 0, payFrequency: 'MONTHLY', payDay: 28, lastPayrollPayDate: '2026-09-28',
    lastPayrollCompletedAt: '2026-09-26T10:15:00Z',
  },
  {
    clientId: 'CP-300', parentClientId: null, name: 'Kano Holdings Group', isActive: true, activeUsers: 60,
    contractorUsers: 5, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25',
    lastPayrollCompletedAt: '2026-10-23T09:00:00Z',
  },
  {
    clientId: 'CP-301', parentClientId: 'CP-300', name: 'Kano Holdings – Cement', isActive: true, activeUsers: 45,
    contractorUsers: 10, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25',
    lastPayrollCompletedAt: '2026-10-23T09:30:00Z',
  },
  {
    clientId: 'CP-302', parentClientId: 'CP-300', name: 'Kano Holdings – Agro', isActive: true, activeUsers: 25,
    contractorUsers: 8, payFrequency: 'SEMI_MONTHLY', payDay: null, lastPayrollPayDate: '2026-10-31',
    lastPayrollCompletedAt: '2026-10-30T16:00:00Z',
  },
  {
    clientId: 'CP-500', parentClientId: null, name: 'Enugu Steel', isActive: false, activeUsers: 0,
    contractorUsers: 0, payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-08-25',
    lastPayrollCompletedAt: '2026-08-24T12:00:00Z',
  },
  {
    // US-03: active in Control Panel, missing from HubSpot
    clientId: 'CP-600', parentClientId: null, name: 'Port Harcourt Marine', isActive: true, activeUsers: 12,
    contractorUsers: 0, payFrequency: 'MONTHLY', payDay: 30, lastPayrollPayDate: '2026-10-30',
    lastPayrollCompletedAt: '2026-10-29T08:00:00Z',
  },
];

export class FixtureHubSpotSource implements HubSpotSource {
  readonly tasks: HubSpotTaskInput[] = [];
  constructor(private readonly companies: HubSpotCompany[] = FIXTURE_COMPANIES) {}
  async fetchActiveCustomers(): Promise<HubSpotCompany[]> {
    return this.companies.map((c) => ({ ...c }));
  }
  async createTask(task: HubSpotTaskInput): Promise<string> {
    this.tasks.push(task);
    return `fixture-task-${this.tasks.length}`;
  }
}

export class FixtureControlPanelSource implements ControlPanelSource {
  constructor(private readonly accounts: ControlPanelAccount[] = FIXTURE_ACCOUNTS) {}
  async fetchAccounts(): Promise<ControlPanelAccount[]> {
    return this.accounts.map((a) => ({ ...a }));
  }
}
