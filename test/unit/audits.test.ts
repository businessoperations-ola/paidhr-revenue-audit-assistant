import { describe, expect, it } from 'vitest';
import { auditArrMath } from '../../src/audits/arr-math.audit.js';
import { companyLookup, runAllAudits } from '../../src/audits/audit.service.js';
import { buildRollups } from '../../src/audits/hierarchy.js';
import { auditHygiene } from '../../src/audits/hygiene.audit.js';
import { auditLatePayroll, nextExpectedPayDate } from '../../src/audits/late-payroll.audit.js';
import { reconcileEntities } from '../../src/audits/reconciliation.audit.js';
import { auditSeatChanges } from '../../src/audits/seat-change.audit.js';
import { auditSeatOverage } from '../../src/audits/seat-overage.audit.js';
import { BusinessCalendar } from '../../src/common/calendar.js';
import type { ControlPanelAccount, HubSpotCompany } from '../../src/domain/types.js';
import { FIXTURE_ACCOUNTS, FIXTURE_COMPANIES, FIXTURE_TICKETS } from '../../src/sources/fixtures/fixture.sources.js';

const NGN = (n: number) => BigInt(Math.round(n * 100));

function company(over: Partial<HubSpotCompany> = {}): HubSpotCompany {
  return {
    hubspotId: 'h1', name: 'Acme', domain: 'acme.example', controlPanelId: 'c1', csmName: 'Ada', csmEmail: 'ada@x.com',
    csmOwnerId: '9', industry: 'Tech', contractEndDate: '2027-01-31', seatTier: 'S', paidSeats: 10,
    arrKobo: NGN(120_000), pricePerSeatMonthlyKobo: NGN(1_000), healthStatus: 'Healthy', lastActivityDate: '2026-11-01', primaryContactEmail: null, ...over,
  };
}

function account(over: Partial<ControlPanelAccount> = {}): ControlPanelAccount {
  return {
    clientId: 'c1', parentClientId: null, name: 'Acme', isActive: true, activeUsers: 10, contractorUsers: 0,
    payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: '2026-10-25', lastPayrollCompletedAt: null,
    createdOn: null, payrollConfiguredOn: null, firstPayrollRunOn: null, ewaLastUsedOn: null, ewaVolume30dKobo: null, statutoryLastUsedOn: null, ...over,
  };
}

const arrOpts = { toleranceKobo: 1n, seatsFor: (c: HubSpotCompany) => c.paidSeats, seatSourceLabel: 'hubspot_paid_seats' };

describe('US-01 ARR contract math', () => {
  it('accepts exact ARR', () => {
    expect(auditArrMath([company()], arrOpts)).toEqual([]);
  });

  it('allows a difference of exactly ₦0.01 and flags anything larger', () => {
    expect(auditArrMath([company({ arrKobo: NGN(120_000) + 1n })], arrOpts)).toEqual([]);
    const [f] = auditArrMath([company({ arrKobo: NGN(120_000) - 2n })], arrOpts);
    expect(f?.type).toBe('ARR_MISMATCH');
    expect(f?.details).toMatchObject({ expectedArrKobo: '12000000', recordedArrKobo: '11999998', differenceKobo: '-2', direction: 'under-billed' });
  });

  it('reports calculated vs recorded ARR in Naira', () => {
    const [f] = auditArrMath([company({ paidSeats: 40, pricePerSeatMonthlyKobo: NGN(3_000), arrKobo: NGN(1_200_000) })], arrOpts);
    expect(f?.summary).toContain('₦1,200,000.00');
    expect(f?.summary).toContain('₦1,440,000.00');
    expect(f?.summary).toContain('under-billed by ₦240,000.00');
  });

  it('skips companies missing an input (hygiene reports those)', () => {
    expect(auditArrMath([company({ pricePerSeatMonthlyKobo: null })], arrOpts)).toEqual([]);
  });
});

describe('US-02 seat increase / renewal without ARR change', () => {
  const c = company();
  it('flags seats growing while ARR stays put', () => {
    const findings = auditSeatChanges(c, [
      { date: '2026-10-01', arrKobo: NGN(100_000), seats: 8, contractEndDate: '2027-01-31' },
      { date: '2026-10-02', arrKobo: NGN(120_000), seats: 10, contractEndDate: '2027-01-31' },
      { date: '2026-10-03', arrKobo: NGN(120_000), seats: 10, contractEndDate: '2027-01-31' },
      { date: '2026-10-04', arrKobo: NGN(120_000), seats: 13, contractEndDate: '2027-01-31' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: 'SEAT_INCREASE_NO_ARR_CHANGE', details: { baselineDate: '2026-10-02', seatsAtBaseline: 10, seatsToday: 13, seatsAdded: 3 } });
  });

  it('does not flag when ARR was updated after the seat increase', () => {
    expect(
      auditSeatChanges(c, [
        { date: '2026-10-01', arrKobo: NGN(120_000), seats: 10, contractEndDate: null },
        { date: '2026-10-02', arrKobo: NGN(120_000), seats: 13, contractEndDate: null },
        { date: '2026-10-03', arrKobo: NGN(156_000), seats: 13, contractEndDate: null },
      ]),
    ).toEqual([]);
  });

  it('flags a renewal that kept the old ARR', () => {
    const findings = auditSeatChanges(c, [
      { date: '2026-10-01', arrKobo: NGN(120_000), seats: 10, contractEndDate: '2026-10-31' },
      { date: '2026-10-02', arrKobo: NGN(120_000), seats: 10, contractEndDate: '2027-10-31' },
    ]);
    expect(findings.map((f) => f.type)).toEqual(['RENEWAL_NO_ARR_CHANGE']);
  });

  it('needs at least two days of history', () => {
    expect(auditSeatChanges(c, [{ date: '2026-10-01', arrKobo: 1n, seats: 1, contractEndDate: null }])).toEqual([]);
  });
});

describe('US-04 / US-05 hierarchy and seat overage', () => {
  const accounts = [
    account({ clientId: 'P', activeUsers: 10 }),
    account({ clientId: 'A', parentClientId: 'P', activeUsers: 5 }),
    account({ clientId: 'B', parentClientId: 'A', activeUsers: 4 }), // grandchild
    account({ clientId: 'X', parentClientId: 'P', activeUsers: 50, isActive: false }), // inactive: ignored
  ];

  it('rolls users up through every level and ignores inactive accounts', () => {
    const r = buildRollups(accounts).get('P');
    expect(r).toMatchObject({ subAccountCount: 2, totalActiveUsers: 19, subAccountIds: ['A', 'B'] });
  });

  it('survives a parent/child cycle', () => {
    const cyclic = [account({ clientId: 'R', activeUsers: 1 }), account({ clientId: 'S', parentClientId: 'T', activeUsers: 1 }), account({ clientId: 'T', parentClientId: 'S', activeUsers: 1 })];
    expect(() => buildRollups(cyclic)).not.toThrow();
  });

  it('flags users across parent + sub-accounts above paid seats', () => {
    const findings = auditSeatOverage([company({ controlPanelId: 'P', paidSeats: 15 })], buildRollups(accounts));
    expect(findings[0]).toMatchObject({ type: 'SEAT_OVERAGE', details: { totalActiveUsers: 19, paidSeats: 15, overageSeats: 4 } });
    expect(auditSeatOverage([company({ controlPanelId: 'P', paidSeats: 19 })], buildRollups(accounts))).toEqual([]);
  });
});

describe('US-03 reconciliation', () => {
  it('counts matches and lists each kind of mismatch', () => {
    const { summary, findings } = reconcileEntities(
      [
        company({ hubspotId: '1', controlPanelId: 'c1' }),
        company({ hubspotId: '2', controlPanelId: null }),
        company({ hubspotId: '3', controlPanelId: 'gone' }),
        company({ hubspotId: '4', controlPanelId: 'off' }),
      ],
      [
        account({ clientId: 'c1' }),
        account({ clientId: 'c1-sub', parentClientId: 'c1' }), // sub-accounts are not "unlinked"
        account({ clientId: 'off', isActive: false }),
        account({ clientId: 'orphan' }),
      ],
    );
    expect(summary).toEqual({ hubspotActiveCompanies: 4, controlPanelActiveAccounts: 2, matched: 1, hubspotOnly: 1, controlPanelOnly: 1, brokenLinks: 2 });
    expect(findings.map((f) => f.type).sort()).toEqual(['BROKEN_LINK', 'BROKEN_LINK', 'UNLINKED_CONTROL_PANEL_ACCOUNT', 'UNLINKED_HUBSPOT_COMPANY']);
  });
});

describe('US-17 hygiene', () => {
  it('lists every empty mandatory field in one flag per company', () => {
    const [f] = auditHygiene([company({ industry: '  ', seatTier: null })], ['Industry', 'Seat Tier', 'CSM Name']);
    expect(f?.details).toEqual({ missingFields: ['Industry', 'Seat Tier'] });
  });
  it('ignores unknown field names in config', () => {
    expect(auditHygiene([company()], ['Not A Field'])).toEqual([]);
  });
});

describe('US-24 late payroll', () => {
  const calendar = new BusinessCalendar(['2026-12-25', '2026-12-26']);

  it('computes the next pay date per frequency', () => {
    expect(nextExpectedPayDate('2026-01-31', 'MONTHLY', 31)).toBe('2026-02-28');
    expect(nextExpectedPayDate('2026-02-28', 'MONTHLY', 31)).toBe('2026-03-31');
    expect(nextExpectedPayDate('2026-10-15', 'SEMI_MONTHLY', null)).toBe('2026-10-31');
    expect(nextExpectedPayDate('2026-10-31', 'SEMI_MONTHLY', null)).toBe('2026-11-15');
    expect(nextExpectedPayDate('2026-12-31', 'SEMI_MONTHLY', null)).toBe('2027-01-15');
    expect(nextExpectedPayDate('2026-10-02', 'BIWEEKLY', null)).toBe('2026-10-16');
    expect(nextExpectedPayDate('2026-10-02', 'WEEKLY', null)).toBe('2026-10-09');
  });

  const run = (today: string, a: ControlPanelAccount) =>
    auditLatePayroll([a], { today, calendar, graceBusinessDays: 2, companyFor: () => company() });

  it('waits for the grace buffer in business days', () => {
    // Expected Wed 2026-11-25; +2 business days = Fri 11-27. Alert from Sat 11-28.
    const a = account({ lastPayrollPayDate: '2026-10-25', payDay: 25 });
    expect(run('2026-11-27', a)).toEqual([]);
    const [f] = run('2026-11-30', a);
    expect(f).toMatchObject({ type: 'LATE_PAYROLL', severity: 'urgent', entityKey: 'cp:c1:2026-11-25', details: { businessDaysOverdue: 3 } });
  });

  it('skips public holidays when counting the grace buffer', () => {
    // Expected Thu 2026-12-24; 25th and 26th are holidays, 27th Sunday → grace ends Tue 12-29.
    const a = account({ lastPayrollPayDate: '2026-11-24', payDay: 24 });
    expect(run('2026-12-29', a)).toEqual([]);
    expect(run('2026-12-30', a)).toHaveLength(1);
  });

  it('ignores inactive accounts and accounts with no payroll history yet', () => {
    expect(run('2027-06-01', account({ isActive: false }))).toEqual([]);
    expect(run('2027-06-01', account({ lastPayrollPayDate: null }))).toEqual([]);
  });

  it('routes a late sub-account to its parent company CSM', () => {
    const lookup = companyLookup([company({ controlPanelId: 'P', csmEmail: 'parent.csm@x.com', name: 'Parent Co' })], [account({ clientId: 'P' }), account({ clientId: 'S', parentClientId: 'P' })]);
    expect(lookup('S')?.csmEmail).toBe('parent.csm@x.com');
    expect(lookup('nope')).toBeUndefined();
  });
});

describe('fixture scenario', () => {
  it('produces one example of every flag type on 2026-11-03', () => {
    const { findings, reconciliation } = runAllAudits({
      companies: FIXTURE_COMPANIES,
      accounts: FIXTURE_ACCOUNTS,
      history: new Map(),
      today: '2026-11-03',
      rules: {
        arr_tolerance_kobo: 1, payroll_grace_business_days: 2, mandatory_fields: ['CSM Name', 'Industry', 'Seat Tier', 'Control Panel ID'], seat_history_days: 400,
        inactivity_days_by_health: { 'At Risk': 7, Neutral: 14, Healthy: 30, default: 14 }, escalation_business_days: 3, director_escalation_business_days: 2, escalate_severities: ['urgent', 'high'],
        onboarding_sla_days: 14, radar_seat_growth_pct: 20, radar_seat_growth_days: 90, radar_ewa_volume_kobo: 500_000_000, radar_contractor_min: 5,
        support_reopen_threshold: 1, support_open_days: 7,
        sla_first_response_high_hours: 4, sla_first_response_normal_hours: 8, sla_resolution_high_hours: 24, sla_resolution_normal_hours: 72, sla_at_risk_pct: 75,
      },
      calendar: new BusinessCalendar(),
      seatSource: 'hubspot_paid_seats',
      tickets: FIXTURE_TICKETS.filter((t) => !t.isClosed).map((t) => ({ ticketId: t.ticketId, hubspotCompanyId: t.hubspotCompanyId, subject: t.subject, createdAt: t.createdAt, isClosed: false, reopenCount: 0, sentiment: null, priority: t.priority, firstResponseAt: t.firstResponseAt ?? null })),
    });
    const byType = Object.fromEntries(findings.map((f) => [`${f.type}:${f.companyName}`, f.severity]));
    expect(byType).toMatchObject({
      'ARR_MISMATCH:Lekki Foods': 'high',
      'SEAT_OVERAGE:Kano Holdings Group': 'high',
      'UNLINKED_HUBSPOT_COMPANY:Ibadan Clinics': 'medium',
      'BROKEN_LINK:Enugu Steel': 'high',
      'UNLINKED_CONTROL_PANEL_ACCOUNT:Port Harcourt Marine': 'medium',
      'MISSING_FIELDS:Ibadan Clinics': 'low',
      'MISSING_FIELDS:Enugu Steel': 'low',
      'LATE_PAYROLL:Lekki Foods': 'urgent',
      'ENGAGEMENT_DROUGHT:Kano Holdings Group': 'low',
      'ENGAGEMENT_DROUGHT:Ibadan Clinics': 'high',
      'ENGAGEMENT_DROUGHT:Enugu Steel': 'high',
      'ONBOARDING_STAGNATION:Abuja Tech Hub': 'medium',
      'SUPPORT_ESCALATION_RISK:Abuja Tech Hub': 'medium',
      'SUPPORT_ESCALATION_RISK:Kano Holdings Group': 'medium',
      'SUPPORT_SLA_BREACH:Kano Holdings Group': 'high',
      'SUPPORT_SLA_BREACH:Abuja Tech Hub': 'high',
      'SUPPORT_SLA_BREACH:Lekki Foods': 'medium',
      'SUPPORT_SLA_BREACH:Ibadan Clinics': 'medium',
    });
    expect(findings).toHaveLength(18);
    expect(reconciliation).toMatchObject({ matched: 4, hubspotOnly: 1, brokenLinks: 1, controlPanelOnly: 1 });
  });
});
