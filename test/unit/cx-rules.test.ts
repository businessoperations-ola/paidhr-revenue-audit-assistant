import { describe, expect, it } from 'vitest';
import { auditOnboarding, auditSupportRisk, expansionRadar, onboardingScorecard, type SupportTicket } from '../../src/cx/cx-rules.js';
import type { ControlPanelAccount, HubSpotCompany } from '../../src/domain/types.js';

const N = (naira: number) => BigInt(naira) * 100n;

const acct = (id: string, over: Partial<ControlPanelAccount> = {}): ControlPanelAccount => ({
  clientId: id, parentClientId: null, name: `Acct ${id}`, isActive: true, activeUsers: 10, contractorUsers: 0,
  payFrequency: null, payDay: null, lastPayrollPayDate: null, lastPayrollCompletedAt: null, createdOn: '2026-01-01',
  payrollConfiguredOn: '2026-01-10', firstPayrollRunOn: '2026-01-31', ewaLastUsedOn: null, ewaVolume30dKobo: null,
  statutoryLastUsedOn: null, ...over,
});

const co = (id: string, cp: string | null, over: Partial<HubSpotCompany> = {}): HubSpotCompany => ({
  hubspotId: id, name: `Co ${id}`, domain: null, controlPanelId: cp, csmName: 'Ada', csmEmail: 'ada@x.com', csmOwnerId: '1',
  industry: 'Tech', contractEndDate: null, seatTier: 'S', paidSeats: 10, arrKobo: N(1_000_000), pricePerSeatMonthlyKobo: N(1000),
  healthStatus: 'Healthy', lastActivityDate: null, primaryContactEmail: null, ...over,
});

describe('US-26 onboarding stagnation', () => {
  const today = '2026-11-03';
  const companies = [co('h1', 'new1')];

  it('flags accounts past the SLA with no payroll configured, and only then', () => {
    const accounts = [
      acct('new1', { createdOn: '2026-10-20', payrollConfiguredOn: null, firstPayrollRunOn: null, activeUsers: 1 }), // 14 days: at the SLA, not past it
      acct('late', { createdOn: '2026-10-19', payrollConfiguredOn: null, firstPayrollRunOn: null }), // 15 days: flagged
      acct('ok', { createdOn: '2026-09-01', payrollConfiguredOn: '2026-09-05', firstPayrollRunOn: null }), // configured: fine
      acct('inactive', { createdOn: '2026-08-01', payrollConfiguredOn: null, isActive: false }),
      acct('sub', { parentClientId: 'late', createdOn: '2026-08-01', payrollConfiguredOn: null }), // sub-accounts don't onboard
    ];
    const found = auditOnboarding(accounts, companies, today, 14);
    expect(found.map((f) => f.controlPanelId)).toEqual(['late']);
    expect(found[0]).toMatchObject({ type: 'ONBOARDING_STAGNATION', severity: 'medium', entityKey: 'cp:late', csmEmail: null });
  });

  it('routes to the HubSpot CSM when linked, and escalates severity at twice the SLA', () => {
    const [f] = auditOnboarding([acct('new1', { createdOn: '2026-10-05', payrollConfiguredOn: null, firstPayrollRunOn: null, activeUsers: 1 })], companies, today, 14);
    expect(f).toMatchObject({ entityKey: 'hs:h1', csmEmail: 'ada@x.com', companyName: 'Co h1', severity: 'high' });
    expect(f!.summary).toBe('29 days since sign-up (SLA 14) and payroll is still not set up. 1 user has been added.');
  });

  it('builds the first-90-day scorecard: TTFV, first-payroll rate and a status per account', () => {
    const accounts = [
      acct('live1', { createdOn: '2026-09-28', payrollConfiguredOn: '2026-10-02', firstPayrollRunOn: '2026-10-30' }), // TTFV 32
      acct('live2', { createdOn: '2026-08-20', payrollConfiguredOn: '2026-08-25', firstPayrollRunOn: '2026-09-09' }), // TTFV 20
      acct('stuck', { createdOn: '2026-10-12', payrollConfiguredOn: null, firstPayrollRunOn: null }),
      acct('fresh', { createdOn: '2026-10-30', payrollConfiguredOn: null, firstPayrollRunOn: null }), // too new to judge
      acct('old', { createdOn: '2025-01-01' }), // outside the 90-day window
    ];
    const s = onboardingScorecard(accounts, today, 14);
    expect(s.cohort).toBe(4);
    expect(s.avgTtfvDays).toBe(26);
    expect(s.medianTtfvDays).toBe(26);
    expect(s.firstPayrollRatePct).toBe(66.7); // 2 of the 3 accounts at least 14 days old
    expect(s.configuredRatePct).toBe(50);
    expect(Object.fromEntries(s.rows.map((r) => [r.clientId, r.status]))).toEqual({ live2: 'live', live1: 'live', stuck: 'stuck', fresh: 'in_progress' });
  });
});

describe('US-27 expansion radar', () => {
  const rules = { growthPct: 20, growthDays: 90, ewaVolumeKobo: N(5_000_000), contractorMin: 5 };
  const companies = [co('h1', 'a'), co('h2', 'b'), co('h3', 'c'), co('h4', 'd'), co('h5', null)];
  const accounts = [
    acct('a', { ewaVolume30dKobo: N(2_000_000) }), acct('a-sub', { parentClientId: 'a', ewaVolume30dKobo: N(3_500_000), contractorUsers: 6 }),
    acct('b', { contractorUsers: 4 }), acct('c', { ewaVolume30dKobo: N(100) }), acct('d'),
  ];
  const trends = new Map([
    ['h1', { seatsNow: 130, seatsThen: 100 }], // +30%
    ['h2', { seatsNow: 110, seatsThen: 100 }], // +10%: below the bar
    ['h3', { seatsNow: 50, seatsThen: null }], // no history: no growth signal
    ['h4', { seatsNow: 40, seatsThen: 50 }], // shrinking
  ]);

  it('scores one point per signal, rolls sub-accounts up, and ranks by score then ARR', () => {
    const radar = expansionRadar(companies, accounts, trends, rules);
    expect(radar.map((r) => [r.hubspotId, r.score, r.signals.map((s) => s.kind)])).toEqual([
      ['h1', 3, ['SEAT_GROWTH', 'HIGH_EWA', 'CONTRACTORS']],
    ]);
    expect(radar[0]!.signals[0]!.text).toBe('Users grew 30% in 90 days (100 to 130)');
    expect(radar[0]!.signals[1]!.text).toBe('₦5,500,000.00 of Earned Wage Access in the last 30 days');
  });

  it('ignores unlinked customers and accounts below every threshold', () => {
    expect(expansionRadar(companies, accounts.filter((a) => a.clientId !== 'a' && a.clientId !== 'a-sub'), trends, rules)).toEqual([]);
  });
});

describe('support early warning', () => {
  const rules = { reopenThreshold: 1, openDays: 7 };
  const today = '2026-11-03';
  const t = (id: string, over: Partial<SupportTicket> = {}): SupportTicket => ({
    ticketId: id, hubspotCompanyId: 'h1', subject: `Issue ${id}`, createdAt: '2026-11-02T10:00:00Z', isClosed: false,
    reopenCount: 0, sentiment: null, ...over,
  });
  const companies = [co('h1', null)];

  it('does nothing for fresh, calm tickets, closed tickets, or tickets with no customer', () => {
    expect(auditSupportRisk([t('1'), t('2', { isClosed: true, reopenCount: 3 }), t('3', { hubspotCompanyId: null, reopenCount: 3 }), t('4', { hubspotCompanyId: 'zzz', reopenCount: 3 })], companies, today, rules)).toEqual([]);
  });

  it('flags a ticket open longer than the limit as medium, using WAT dates for age', () => {
    expect(auditSupportRisk([t('1', { createdAt: '2026-10-27T10:00:00Z' })], companies, today, rules)).toEqual([]); // 7 days: at the limit
    const [f] = auditSupportRisk([t('1', { createdAt: '2026-10-26T10:00:00Z' })], companies, today, rules);
    expect(f).toMatchObject({ type: 'SUPPORT_ESCALATION_RISK', severity: 'medium', entityKey: 'hs:h1', csmEmail: 'ada@x.com' });
    expect(f!.summary).toBe('1 open support ticket at risk: open 8 days');
  });

  it('goes high for combined signals, strong frustration, or repeated re-opens', () => {
    const sev = (over: Partial<SupportTicket>) => auditSupportRisk([t('1', over)], companies, today, rules)[0]?.severity;
    expect(sev({ reopenCount: 1 })).toBe('medium');
    expect(sev({ sentiment: -1 })).toBe('medium');
    expect(sev({ sentiment: -2 })).toBe('high');
    expect(sev({ reopenCount: 2 })).toBe('high');
    expect(sev({ reopenCount: 1, createdAt: '2026-10-01T10:00:00Z' })).toBe('high'); // reopened and aged
  });

  it('groups a customer\'s risky tickets into one flag, worst first', () => {
    const [f] = auditSupportRisk([t('1', { createdAt: '2026-10-20T10:00:00Z' }), t('2', { reopenCount: 2, sentiment: -2 })], companies, today, rules);
    expect((f!.details.tickets as Array<{ ticketId: string }>).map((x) => x.ticketId)).toEqual(['2', '1']);
    expect(f!.summary).toContain('2 open support tickets at risk: open 1 days, reopened 2x, frustrated tone; open 14 days');
  });
});
