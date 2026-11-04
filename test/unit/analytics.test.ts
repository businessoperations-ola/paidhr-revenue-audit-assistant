import { describe, expect, it } from 'vitest';
import {
  adoptionStats,
  arrBridge,
  arrByCsm,
  contractorSeats,
  csmLedger,
  expansionRevenue,
  healthDistribution,
  renewalStats,
  topTicketClients,
  totalArr,
  type CompanyPoint,
  type ContractPoint,
} from '../../src/analytics/analytics.js';
import type { ControlPanelAccount, RevenueLine } from '../../src/domain/types.js';

const N = (naira: number) => BigInt(naira) * 100n;

const co = (id: string, arr: number | null, over: Partial<CompanyPoint> = {}): CompanyPoint => ({
  hubspotId: id, name: `Co ${id}`, csmEmail: 'a@x.com', csmName: 'Ada', healthStatus: 'Healthy',
  arrKobo: arr === null ? null : N(arr), contractEndDate: null, ...over,
});

const acct = (id: string, over: Partial<ControlPanelAccount> = {}): ControlPanelAccount => ({
  clientId: id, parentClientId: null, name: `Acct ${id}`, isActive: true, activeUsers: 10, contractorUsers: 0,
  payFrequency: 'MONTHLY', payDay: 25, lastPayrollPayDate: null, lastPayrollCompletedAt: null, createdOn: null,
  payrollConfiguredOn: null, firstPayrollRunOn: null, ewaLastUsedOn: null, ewaVolume30dKobo: null,
  statutoryLastUsedOn: null, ...over,
});

describe('US-09 ARR movement: churn, contraction, expansion, new', () => {
  const start = [co('1', 1000), co('2', 500), co('3', 800), co('4', 300), co('5', null)];
  const end = [co('1', 1000), co('2', 350), co('3', 0), co('6', 400), co('4', 450)]; // 3 → ₦0, 5 never had ARR

  it('separates full churn (to ₦0 or gone) from partial churn (contraction)', () => {
    const b = arrBridge(start, end);
    expect(b.fullChurn).toEqual([{ hubspotId: '3', name: 'Co 3', lostKobo: N(800) }]);
    expect(b.partialChurn).toEqual([{ hubspotId: '2', name: 'Co 2', lostKobo: N(150) }]);
    expect(b.expansionKobo).toBe(N(150));
    expect(b.newKobo).toBe(N(400));
  });

  it('is a true bridge: start + new + expansion − partial − full = end', () => {
    const b = arrBridge(start, end);
    expect(b.startKobo).toBe(N(2600));
    expect(b.startKobo + b.newKobo + b.expansionKobo - b.partialChurnKobo - b.fullChurnKobo).toBe(b.endKobo);
    expect(b.endKobo).toBe(totalArr(end));
  });

  it('treats a customer missing from the end snapshot as full churn', () => {
    expect(arrBridge([co('1', 100)], []).fullChurnKobo).toBe(N(100));
  });
});

describe('US-10 health distribution', () => {
  it('counts, shares and ARR per status, in a fixed order, with unknown values grouped', () => {
    const rows = healthDistribution([
      co('1', 100, { healthStatus: 'healthy' }), co('2', 200, { healthStatus: 'At Risk' }),
      co('3', 300, { healthStatus: 'At Risk' }), co('4', 400, { healthStatus: null }),
    ]);
    expect(rows.map((r) => [r.status, r.count, r.pct])).toEqual([
      ['Healthy', 1, 25], ['Neutral', 0, 0], ['At Risk', 2, 50], ['Not set', 1, 25],
    ]);
    expect(rows.find((r) => r.status === 'At Risk')!.arrKobo).toBe(N(500));
  });
});

describe('US-11 renewals', () => {
  const pt = (date: string, end: string | null, arr = 100): ContractPoint => ({ date, contractEnd: end, arrKobo: N(arr) });
  const series = new Map<string, ContractPoint[]>([
    // Expires 10 Nov, renewed 3 days early (7 Nov).
    ['early', [pt('2026-11-01', '2026-11-10'), pt('2026-11-05', '2026-11-10'), pt('2026-11-07', '2027-11-10', 120), pt('2026-11-30', '2027-11-10', 120)]],
    // Expires 20 Nov, renewed 2 days late (22 Nov).
    ['late', [pt('2026-11-01', '2026-11-20'), pt('2026-11-22', '2027-11-20'), pt('2026-11-30', '2027-11-20')]],
    // Expires 25 Nov, never renewed, then leaves.
    ['lapsed', [pt('2026-11-01', '2026-11-25', 200), pt('2026-11-10', '2026-11-25', 200)]],
    // Expires next year: not eligible.
    ['later', [pt('2026-11-01', '2027-03-01'), pt('2026-11-30', '2027-03-01')]],
    // New customer (first seen after day one): not eligible.
    ['new', [pt('2026-11-12', '2026-11-20'), pt('2026-11-30', '2026-11-20')]],
  ]);
  const endArr = new Map<string, bigint>([['early', N(120)], ['late', N(100)]]);

  it('counts eligible and renewed contracts, and the average turnaround in days', () => {
    const r = renewalStats(series, '2026-11-01', '2026-11-30', endArr);
    expect(r.eligible).toBe(3);
    expect(r.renewed).toBe(2);
    expect(r.renewalRatePct).toBe(66.7);
    expect(r.details.find((d) => d.hubspotId === 'early')).toMatchObject({ detectedOn: '2026-11-07', turnaroundDays: -3 });
    expect(r.details.find((d) => d.hubspotId === 'late')).toMatchObject({ turnaroundDays: 2 });
    expect(r.avgTurnaroundDays).toBe(-0.5);
  });

  it('net renewal % is cohort ARR at the end over cohort ARR at the start', () => {
    // Start 100 + 100 + 200 = 400; end 120 + 100 + 0 = 220.
    expect(renewalStats(series, '2026-11-01', '2026-11-30', endArr).netRenewalPct).toBe(55);
  });

  it('leaves out contracts whose renewal is not due yet when the data stops early', () => {
    // Data runs to 10 Nov but the period is the whole month. "lapsed" expires 25 Nov (undecided);
    // "early" renewed on 7 Nov (counts); "late" expires 20 Nov and had not renewed by 10 Nov (undecided).
    const partial = new Map<string, ContractPoint[]>([
      ['early', series.get('early')!.filter((p) => p.date <= '2026-11-10')],
      ['late', [pt('2026-11-01', '2026-11-20'), pt('2026-11-10', '2026-11-20')]],
      ['lapsed', series.get('lapsed')!],
      ['due', [pt('2026-11-01', '2026-11-08', 50), pt('2026-11-10', '2026-11-08', 50)]], // expired 8 Nov, not renewed: counts as missed
    ]);
    const r = renewalStats(partial, '2026-11-01', '2026-11-30', new Map([['early', N(120)], ['due', N(50)]]), '2026-11-10');
    expect(r.details.map((d) => [d.hubspotId, d.renewed])).toEqual([['early', true], ['due', false]]);
    expect(r.renewalRatePct).toBe(50);
    // Without the cut-off the same data would wrongly count two undecided contracts as missed.
    expect(renewalStats(partial, '2026-11-01', '2026-11-30', new Map()).eligible).toBe(4);
  });

  it('returns nulls, not zeros, when nothing was up for renewal', () => {
    const r = renewalStats(new Map(), '2026-11-01', '2026-11-30', new Map());
    expect(r).toMatchObject({ eligible: 0, renewalRatePct: null, netRenewalPct: null, avgTurnaroundDays: null });
  });
});

describe('US-08 adoption windows', () => {
  const accounts = [
    acct('A', { ewaLastUsedOn: '2026-10-30', statutoryLastUsedOn: '2026-10-01' }), // EWA 30/90/365; statutory 90/365
    acct('B', { ewaLastUsedOn: '2026-09-10', statutoryLastUsedOn: '2026-06-01' }), // EWA 90/365; statutory 365
    acct('C', { ewaLastUsedOn: '2025-12-01' }), // EWA 365 only
    acct('D'), // never
    acct('S', { parentClientId: 'D', ewaLastUsedOn: '2026-10-20' }), // sub-account use counts for its parent
    acct('X', { isActive: false, ewaLastUsedOn: '2026-10-31' }), // inactive: not in the base
  ];
  it('uses active top-level accounts as the base and rolls sub-accounts up', () => {
    const a = adoptionStats(accounts, '2026-11-03');
    expect(a.base).toBe(4);
    expect(a.ewa.map((w) => [w.days, w.users, w.ratePct])).toEqual([[30, 2, 50], [90, 3, 75], [365, 4, 100]]);
    expect(a.statutory.map((w) => [w.days, w.users, w.ratePct])).toEqual([[30, 0, 0], [90, 1, 25], [365, 2, 50]]); // A's 1 Oct use is 33 days ago
  });
  it('gives no rate when there are no accounts', () => {
    expect(adoptionStats([], '2026-11-03').ewa[0]).toEqual({ days: 30, users: 0, ratePct: null });
  });
});

describe('US-06 contractor seats', () => {
  it('totals contractors per parent including sub-accounts, largest first, skipping zeros', () => {
    const s = contractorSeats([
      acct('P', { contractorUsers: 5 }), acct('C1', { parentClientId: 'P', contractorUsers: 10 }),
      acct('Q', { contractorUsers: 12 }), acct('Z', { contractorUsers: 0 }), acct('G', { isActive: false, contractorUsers: 99 }),
    ]);
    expect(s.total).toBe(27);
    expect(s.byParent.map((p) => [p.parentName, p.contractors, p.subAccounts])).toEqual([['Acct P', 15, 1], ['Acct Q', 12, 0]]);
  });
});

describe('US-07 expansion revenue', () => {
  const line = (d: string, category: RevenueLine['category'], n: number): RevenueLine => ({ clientId: 'c', revenueDate: d, category, amountKobo: N(n) });
  const lines = [
    line('2026-10-05', 'UPSELL', 600), line('2026-10-10', 'CROSS_SELL_EWA', 200), line('2026-10-31', 'CROSS_SELL_STATUTORY', 100),
    line('2026-10-31', 'CROSS_SELL_OTHER', 100), line('2026-09-30', 'UPSELL', 9999), line('2026-11-01', 'CROSS_SELL_EWA', 9999),
  ];
  it('sums the period and computes the EWA + statutory share', () => {
    const e = expansionRevenue(lines, '2026-10-01', '2026-10-31');
    expect(e.totalKobo).toBe(N(1000));
    expect(e.monetizedKobo).toBe(N(300));
    expect(e.monetizedPct).toBe(30);
    expect(e.byCategory.map((c) => c.amountKobo)).toEqual([N(600), N(200), N(100), N(100)]);
  });
  it('has no percentage when there was no expansion revenue', () => {
    expect(expansionRevenue(lines, '2026-01-01', '2026-01-31').monetizedPct).toBeNull();
  });
});

describe('US-12 top ticket clients', () => {
  it('ranks by tickets created in the period, using WAT dates, ignoring unlinked tickets', () => {
    const top = topTicketClients(
      [
        { hubspotCompanyId: 'b', createdAt: '2026-10-31T23:30:00Z' }, // 1 Nov 00:30 WAT: outside October
        { hubspotCompanyId: 'a', createdAt: '2026-10-10T10:00:00Z' }, { hubspotCompanyId: 'a', createdAt: '2026-10-11T10:00:00Z' },
        { hubspotCompanyId: 'b', createdAt: '2026-10-12T10:00:00Z' }, { hubspotCompanyId: null, createdAt: '2026-10-12T10:00:00Z' },
        { hubspotCompanyId: 'c', createdAt: '2026-10-13T10:00:00Z' },
      ],
      '2026-10-01', '2026-10-31',
    );
    expect(top).toEqual([{ hubspotId: 'a', count: 2 }, { hubspotId: 'b', count: 1 }, { hubspotId: 'c', count: 1 }]);
  });
});

describe('US-18 CSM ledger', () => {
  it('groups ARR by CSM and puts customers with no CSM under (unassigned)', () => {
    const rows = arrByCsm([co('1', 100), co('2', 50, { csmEmail: 'b@x.com', csmName: 'Bayo' }), co('3', 25, { csmEmail: null, csmName: null }), co('4', 0)]);
    expect(Object.fromEntries(rows.map((r) => [r.csmEmail, [r.baselineKobo, r.accounts]]))).toEqual({
      'a@x.com': [N(100), 1], 'b@x.com': [N(50), 1], '(unassigned)': [N(25), 1],
    });
  });
  it('compares the locked baseline with ARR today, including CSMs who gained or lost all accounts', () => {
    const baselines = [
      { csmEmail: 'a@x.com', csmName: 'Ada', baselineKobo: N(100), accounts: 1 },
      { csmEmail: 'gone@x.com', csmName: 'Gone', baselineKobo: N(80), accounts: 1 },
    ];
    const rows = csmLedger(baselines, [co('1', 130), co('2', 40, { csmEmail: 'new@x.com', csmName: 'New' })]);
    expect(rows.map((r) => [r.csmEmail, r.baselineKobo, r.currentKobo, r.deltaKobo, r.deltaPct])).toEqual([
      ['a@x.com', N(100), N(130), N(30), 30],
      ['new@x.com', 0n, N(40), N(40), null],
      ['gone@x.com', N(80), 0n, -N(80), -100],
    ]);
  });
});
