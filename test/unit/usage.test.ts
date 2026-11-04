import { describe, expect, it } from 'vitest';
import { DEFAULT_USAGE_RULES, describeCriterion, evaluateUsage, usageRuleFor, validateUsageRule, type EventWindow, type UsageEvidence, type UsageRule } from '../../src/adoption/usage.js';

const NONE: EventWindow = { events: 0, maxActive: 0, last: null };
/** Evidence with nothing happening, overridden per test. */
const evidence = (over: Partial<UsageEvidence> & { eventMap?: Record<string, Partial<EventWindow>>; signIn?: Partial<EventWindow> } = {}): UsageEvidence => ({
  asOf: '2026-11-03', configured: 'unknown',
  events: (types) => ({ ...NONE, ...(over.eventMap?.[types.join(',') || '*'] ?? {}) }),
  signIns: () => ({ ...NONE, ...(over.signIn ?? {}) }),
  adminLogins: [], lastPayrollRun: null, payScheduleExists: null, lastUsed: { ewa: null, statutory: null },
  ...over,
});
const rule = (mode: 'ANY' | 'ALL', ...criteria: UsageRule['criteria']): UsageRule => ({ mode, criteria });

describe('is it configured', () => {
  it('is met, not met, or unknown, and unknown is left out rather than held against the customer', () => {
    const r = rule('ALL', { type: 'CONFIGURED' }, { type: 'PAY_SCHEDULE' });
    expect(evaluateUsage(r, evidence({ configured: 'yes', payScheduleExists: true })).inUse).toBe(true);
    expect(evaluateUsage(r, evidence({ configured: 'no', payScheduleExists: true }))).toMatchObject({ inUse: false, results: [{ state: 'not_met', detail: 'Bought but not configured yet' }, { state: 'met' }] });
    const unknown = evaluateUsage(r, evidence({ configured: 'unknown', payScheduleExists: true }));
    expect(unknown.inUse).toBe(true); // configured is unknown, so only the pay schedule is judged
    expect(unknown.results[0]).toMatchObject({ state: 'unknown' });
    expect(evaluateUsage(rule('ALL', { type: 'CONFIGURED' }), evidence()).inUse).toBe(false); // nothing could be judged
  });
});

describe('last request made (leave, requisition, loans)', () => {
  const leave = rule('ANY', { type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 30, minCount: 2 });
  it('needs the minimum number of requests inside the window, and says what it found', () => {
    expect(evaluateUsage(leave, evidence({ eventMap: { LEAVE_REQUEST: { events: 3, last: '2026-11-01' } } })).results[0]).toMatchObject({ state: 'met', detail: '3 in the last 30 days, latest 2 days ago' });
    expect(evaluateUsage(leave, evidence({ eventMap: { LEAVE_REQUEST: { events: 1, last: '2026-10-30' } } })).results[0]).toMatchObject({ state: 'not_met', detail: 'Only 1 in the last 30 days (needs 2)' });
    expect(evaluateUsage(leave, evidence({ eventMap: { LEAVE_REQUEST: { events: 0, last: '2026-08-01' } } })).results[0]).toMatchObject({ state: 'not_met', detail: 'None in the last 30 days, latest 94 days ago' });
  });
  it('works for any request type an admin names, such as requisitions', () => {
    const r = rule('ANY', { type: 'LAST_REQUEST', eventTypes: ['REQUISITION_REQUEST'], withinDays: 14, minCount: 1 });
    expect(evaluateUsage(r, evidence({ eventMap: { REQUISITION_REQUEST: { events: 1, last: '2026-11-02' } } })).inUse).toBe(true);
    expect(describeCriterion(r.criteria[0]!)).toBe('Any requisition requests in the last 14 days');
  });
});

describe('web logins and activity on the module', () => {
  it('counts activity only above the bar set for events and for people', () => {
    const r = rule('ANY', { type: 'ACTIVITY', eventTypes: [], withinDays: 30, minEvents: 10, minActiveEmployees: 3 });
    expect(evaluateUsage(r, evidence({ eventMap: { '*': { events: 40, maxActive: 6 } } })).inUse).toBe(true);
    expect(evaluateUsage(r, evidence({ eventMap: { '*': { events: 40, maxActive: 2 } } })).inUse).toBe(false); // too few people
    expect(evaluateUsage(r, evidence({ eventMap: { '*': { events: 4, maxActive: 4 } } })).inUse).toBe(false); // too few events
    expect(evaluateUsage(r, evidence()).results[0]!.detail).toBe('No activity in the last 30 days');
  });
  it('judges employee web logins and admin logins', () => {
    const login = rule('ANY', { type: 'LOGIN', withinDays: 14, minActiveEmployees: 5 });
    expect(evaluateUsage(login, evidence({ signIn: { events: 50, maxActive: 8 } })).inUse).toBe(true);
    expect(evaluateUsage(login, evidence({ signIn: { events: 9, maxActive: 3 } })).results[0]!.detail).toBe('Only 3 employees on the busiest day (needs 5)');
    const admin = rule('ANY', { type: 'ADMIN_LOGIN', withinDays: 14, who: 'primary' });
    const logins = [{ level: 'PRIMARY' as const, daysSince: 20 }, { level: 'SECONDARY' as const, daysSince: 2 }];
    expect(evaluateUsage(admin, evidence({ adminLogins: logins })).inUse).toBe(false); // the primary is quiet
    expect(evaluateUsage(rule('ANY', { type: 'ADMIN_LOGIN', withinDays: 14, who: 'any' }), evidence({ adminLogins: logins })).inUse).toBe(true);
    expect(evaluateUsage(admin, evidence()).results[0]!.state).toBe('unknown'); // no admins on record
  });
});

describe('payslips, payroll runs and pay schedules', () => {
  it('measures each on its own, from the right place', () => {
    const slips = rule('ANY', { type: 'PAYSLIP', eventTypes: ['PAYSLIP_GENERATED'], withinDays: 45, minCount: 1 });
    expect(evaluateUsage(slips, evidence({ eventMap: { PAYSLIP_GENERATED: { events: 48, last: '2026-10-28' } } })).results[0]!.detail).toBe('48 payslips generated, latest 6 days ago');
    expect(evaluateUsage(slips, evidence()).inUse).toBe(false);
    const run = rule('ANY', { type: 'PAYROLL_RUN', withinDays: 45 });
    expect(evaluateUsage(run, evidence({ lastPayrollRun: '2026-10-28' })).inUse).toBe(true);
    expect(evaluateUsage(run, evidence({ lastPayrollRun: '2026-08-28' })).results[0]!.detail).toBe('Last payroll run 67 days ago');
    expect(evaluateUsage(run, evidence({ lastPayrollRun: '2026-12-01' })).inUse).toBe(false); // a date in the future is not a run that happened
    expect(evaluateUsage(run, evidence()).results[0]!.detail).toBe('No payroll run yet');
    const sched = rule('ANY', { type: 'PAY_SCHEDULE' });
    expect(evaluateUsage(sched, evidence({ payScheduleExists: true })).inUse).toBe(true);
    expect(evaluateUsage(sched, evidence({ payScheduleExists: false })).results[0]!.detail).toBe('No pay schedule has been created');
    expect(evaluateUsage(sched, evidence()).results[0]!.state).toBe('unknown');
  });
  it('reads wage access and statutory use from the account record', () => {
    const ewa = rule('ANY', { type: 'LAST_USED', source: 'ewa', withinDays: 30 });
    expect(evaluateUsage(ewa, evidence({ lastUsed: { ewa: '2026-10-20', statutory: null } })).inUse).toBe(true);
    expect(evaluateUsage(ewa, evidence({ lastUsed: { ewa: null, statutory: '2026-10-30' } })).results[0]!.detail).toBe('Never used');
  });
});

describe('combining criteria', () => {
  const both = (mode: 'ANY' | 'ALL') => rule(mode, { type: 'CONFIGURED' }, { type: 'LAST_REQUEST', eventTypes: ['LOAN_REQUEST'], withinDays: 30, minCount: 1 });
  it('ANY needs one criterion, ALL needs every one that can be judged', () => {
    const configuredOnly = evidence({ configured: 'yes' });
    const both_ = evidence({ configured: 'yes', eventMap: { LOAN_REQUEST: { events: 1, last: '2026-11-01' } } });
    expect(evaluateUsage(both('ANY'), configuredOnly).inUse).toBe(true);
    expect(evaluateUsage(both('ALL'), configuredOnly).inUse).toBe(false);
    expect(evaluateUsage(both('ALL'), both_).inUse).toBe(true);
    expect(evaluateUsage(both('ANY'), evidence({ configured: 'no' })).inUse).toBe(false);
  });
});

describe('defaults and validation', () => {
  it('ships a rule for every standard module, and a fallback for a new one', () => {
    for (const m of ['PAYROLL', 'LEAVE', 'LOANS', 'REQUISITION', 'EWA', 'STATUTORY', 'CORE_HR', 'TIME', 'EXPENSES', 'PERFORMANCE']) expect(DEFAULT_USAGE_RULES[m]).toBeTruthy();
    expect(usageRuleFor('BENEFITS', new Map())).toMatchObject({ mode: 'ANY', criteria: [{ type: 'ACTIVITY', withinDays: 30 }] });
    const saved = new Map([['LEAVE', rule('ALL', { type: 'CONFIGURED' })]]);
    expect(usageRuleFor('LEAVE', saved).mode).toBe('ALL'); // a saved rule wins over the default
  });

  it('rejects windows, counts and codes that make no sense, in plain words', () => {
    const bad = (r: unknown) => validateUsageRule(r) as { ok: false; errors: string[] };
    expect(bad({ mode: 'SOME', criteria: [{ type: 'CONFIGURED' }] }).ok).toBe(false);
    expect(bad({ mode: 'ANY', criteria: [] }).errors.join(' ')).toMatch(/at least one/);
    expect(bad({ mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 31, minCount: 1 }] }).ok).toBe(false); // only 7, 14, 30, 45, 60, 90
    expect(bad({ mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: [], withinDays: 30, minCount: 1 }] }).ok).toBe(false);
    expect(bad({ mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['leave request'], withinDays: 30, minCount: 1 }] }).errors.join(' ')).toMatch(/capital letters/);
    expect(bad({ mode: 'ANY', criteria: [{ type: 'PAYROLL_RUN', withinDays: 30, extra: 1 }, { type: 'MADE_UP' }] }).ok).toBe(false);
    expect(validateUsageRule(DEFAULT_USAGE_RULES.PAYROLL!).ok).toBe(true);
    for (const r of Object.values(DEFAULT_USAGE_RULES)) expect(validateUsageRule(r).ok).toBe(true);
  });
});
