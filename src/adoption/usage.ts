import { z } from 'zod';
import { eventLabel } from './modules.js';

/**
 * What counts as a module being "in use". Each module has a rule: a list of criteria and whether any
 * or all of them must be met. Admins edit these in the app; the defaults below match how adoption was
 * measured before it became configurable.
 */

export const WINDOWS = [7, 14, 30, 45, 60, 90] as const;
export type Window = (typeof WINDOWS)[number];
const Win = z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(45), z.literal(60), z.literal(90)]);
const Events = z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Event codes are capital letters, digits and underscores')).max(10);

export const UsageCriterion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CONFIGURED') }),
  z.object({ type: z.literal('LAST_REQUEST'), eventTypes: Events.min(1), withinDays: Win, minCount: z.number().int().min(1).max(1_000_000) }),
  z.object({ type: z.literal('ACTIVITY'), eventTypes: Events, withinDays: Win, minEvents: z.number().int().min(1).max(100000), minActiveEmployees: z.number().int().min(0).max(100000) }),
  z.object({ type: z.literal('LOGIN'), withinDays: Win, minActiveEmployees: z.number().int().min(1).max(100000) }),
  z.object({ type: z.literal('ADMIN_LOGIN'), withinDays: Win, who: z.enum(['any', 'primary']) }),
  z.object({ type: z.literal('PAYSLIP'), eventTypes: Events.min(1), withinDays: Win, minCount: z.number().int().min(1).max(1_000_000) }),
  z.object({ type: z.literal('PAYROLL_RUN'), withinDays: Win }),
  z.object({ type: z.literal('PAY_SCHEDULE') }),
  z.object({ type: z.literal('LAST_USED'), source: z.enum(['ewa', 'statutory']), withinDays: Win }),
]);
export type UsageCriterion = z.infer<typeof UsageCriterion>;

export const UsageRule = z.object({ mode: z.enum(['ANY', 'ALL']), criteria: z.array(UsageCriterion).min(1, 'Add at least one criterion').max(8) });
export type UsageRule = z.infer<typeof UsageRule>;

/** What each kind of criterion means, for the editor. */
export const CRITERION_KINDS: Array<{ type: UsageCriterion['type']; label: string; help: string }> = [
  { type: 'CONFIGURED', label: 'Module is configured', help: 'The module has been set up, according to the Control Panel.' },
  { type: 'LAST_REQUEST', label: 'Employees made a request', help: 'Last request made (leave, requisition, loan and so on) within the window.' },
  { type: 'ACTIVITY', label: 'Activity on the module', help: 'Employees did something in the module. Leave the event list empty to count any event.' },
  { type: 'LOGIN', label: 'Employees logged in on the web', help: 'Employees signed in on the web within the window.' },
  { type: 'ADMIN_LOGIN', label: 'An admin logged in', help: 'The primary admin, or any admin, signed in within the window.' },
  { type: 'PAYSLIP', label: 'Payslips generated', help: 'Payslips were generated within the window.' },
  { type: 'PAYROLL_RUN', label: 'A payroll run completed', help: 'A payroll run completed within the window, per the account record.' },
  { type: 'PAY_SCHEDULE', label: 'A pay schedule exists', help: 'A pay schedule has been created for the account.' },
  { type: 'LAST_USED', label: 'Account shows it was used', help: 'The account record shows wage access or statutory remittance used within the window.' },
];

const act = (days: Window = 30): UsageCriterion => ({ type: 'ACTIVITY', eventTypes: [], withinDays: days, minEvents: 1, minActiveEmployees: 0 });

/** Rules used until an admin saves their own. */
export const DEFAULT_USAGE_RULES: Record<string, UsageRule> = {
  PAYROLL: { mode: 'ANY', criteria: [{ type: 'PAYROLL_RUN', withinDays: 45 }, { type: 'PAYSLIP', eventTypes: ['PAYSLIP_GENERATED'], withinDays: 45, minCount: 1 }, act(30)] },
  LEAVE: { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LEAVE_REQUEST'], withinDays: 30, minCount: 1 }, act(30)] },
  LOANS: { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['LOAN_REQUEST'], withinDays: 30, minCount: 1 }, act(30)] },
  REQUISITION: { mode: 'ANY', criteria: [{ type: 'LAST_REQUEST', eventTypes: ['REQUISITION_REQUEST'], withinDays: 30, minCount: 1 }, act(30)] },
  EWA: { mode: 'ANY', criteria: [{ type: 'LAST_USED', source: 'ewa', withinDays: 30 }, act(30)] },
  STATUTORY: { mode: 'ANY', criteria: [{ type: 'LAST_USED', source: 'statutory', withinDays: 60 }, act(30)] },
  CORE_HR: { mode: 'ANY', criteria: [act(30)] },
  TIME: { mode: 'ANY', criteria: [act(30)] },
  EXPENSES: { mode: 'ANY', criteria: [act(30)] },
  PERFORMANCE: { mode: 'ANY', criteria: [act(30)] },
};
export const FALLBACK_USAGE_RULE: UsageRule = { mode: 'ANY', criteria: [act(30)] };
export const usageRuleFor = (module: string, saved: Map<string, UsageRule>): UsageRule => saved.get(module) ?? DEFAULT_USAGE_RULES[module] ?? FALLBACK_USAGE_RULE;

// ---------------------------------------------------------------- evaluating

export interface EventWindow {
  events: number;
  /** The most employees active on any one day in the window. */
  maxActive: number;
  last: string | null;
}

export interface UsageEvidence {
  asOf: string;
  configured: 'yes' | 'no' | 'unknown';
  /** Events of the given types for this module (all of the module's events when `eventTypes` is empty). */
  events(eventTypes: string[], days: Window): EventWindow;
  /** Employee web sign-ins, whichever module. */
  signIns(days: Window): EventWindow;
  adminLogins: Array<{ level: 'PRIMARY' | 'SECONDARY'; daysSince: number | null }>;
  lastPayrollRun: string | null;
  payScheduleExists: boolean | null;
  lastUsed: { ewa: string | null; statutory: string | null };
}

export type CriterionState = 'met' | 'not_met' | 'unknown';
export interface CriterionResult {
  type: UsageCriterion['type'];
  label: string;
  state: CriterionState;
  /** In words: what was found. */
  detail: string;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const ago = (last: string | null, asOf: string) => (last === null ? 'never' : daysBetween(last, asOf) <= 0 ? 'today' : `${daysBetween(last, asOf)} days ago`);
const typesText = (t: string[]) => (t.length === 0 ? 'activity' : t.map((x) => eventLabel(x).toLowerCase()).join(', '));
const within = (d: string | null, days: number, asOf: string) => d !== null && daysBetween(d, asOf) >= 0 && daysBetween(d, asOf) <= days;

export function describeCriterion(c: UsageCriterion): string {
  switch (c.type) {
    case 'CONFIGURED': return 'Module is configured';
    case 'LAST_REQUEST': return `${c.minCount > 1 ? `${c.minCount}+ ` : 'Any '}${typesText(c.eventTypes)} in the last ${c.withinDays} days`;
    case 'ACTIVITY': return `${c.minEvents > 1 ? `${c.minEvents}+ ` : 'Any '}${typesText(c.eventTypes)} in the last ${c.withinDays} days${c.minActiveEmployees > 0 ? `, by ${c.minActiveEmployees}+ employees on a day` : ''}`;
    case 'LOGIN': return `${c.minActiveEmployees}+ employees logged in on the web in the last ${c.withinDays} days`;
    case 'ADMIN_LOGIN': return `${c.who === 'primary' ? 'The primary admin' : 'An admin'} logged in within ${c.withinDays} days`;
    case 'PAYSLIP': return `${c.minCount > 1 ? `${c.minCount}+ payslips` : 'Payslips'} generated in the last ${c.withinDays} days`;
    case 'PAYROLL_RUN': return `A payroll run completed in the last ${c.withinDays} days`;
    case 'PAY_SCHEDULE': return 'A pay schedule has been created';
    case 'LAST_USED': return `${c.source === 'ewa' ? 'Wage access' : 'Statutory remittance'} used in the last ${c.withinDays} days`;
  }
}

export function evaluateCriterion(c: UsageCriterion, ev: UsageEvidence): CriterionResult {
  const label = describeCriterion(c);
  const out = (state: CriterionState, detail: string): CriterionResult => ({ type: c.type, label, state, detail });
  switch (c.type) {
    case 'CONFIGURED':
      return ev.configured === 'unknown' ? out('unknown', 'The Control Panel does not say whether it is configured') : ev.configured === 'yes' ? out('met', 'Configured') : out('not_met', 'Bought but not configured yet');
    case 'LAST_REQUEST': {
      const w = ev.events(c.eventTypes, c.withinDays);
      return w.events >= c.minCount ? out('met', `${w.events} in the last ${c.withinDays} days, latest ${ago(w.last, ev.asOf)}`) : out('not_met', w.events > 0 ? `Only ${w.events} in the last ${c.withinDays} days (needs ${c.minCount})` : `None in the last ${c.withinDays} days${w.last ? `, latest ${ago(w.last, ev.asOf)}` : ''}`);
    }
    case 'ACTIVITY': {
      const w = ev.events(c.eventTypes, c.withinDays);
      const ok = w.events >= c.minEvents && w.maxActive >= c.minActiveEmployees;
      return ok ? out('met', `${w.events} actions in the last ${c.withinDays} days, up to ${w.maxActive} employees a day`) : out('not_met', w.events === 0 ? `No activity in the last ${c.withinDays} days` : `${w.events} actions, up to ${w.maxActive} employees a day: below the bar`);
    }
    case 'LOGIN': {
      const w = ev.signIns(c.withinDays);
      return w.maxActive >= c.minActiveEmployees ? out('met', `Up to ${w.maxActive} employees signed in on a day in the last ${c.withinDays} days`) : out('not_met', w.events === 0 ? `No web sign-ins in the last ${c.withinDays} days` : `Only ${w.maxActive} employees on the busiest day (needs ${c.minActiveEmployees})`);
    }
    case 'ADMIN_LOGIN': {
      const list = ev.adminLogins.filter((a) => c.who === 'any' || a.level === 'PRIMARY');
      if (list.length === 0) return out('unknown', 'No administrators on record');
      const best = Math.min(...list.map((a) => a.daysSince ?? Infinity));
      return best <= c.withinDays ? out('met', `Last admin login ${best === 0 ? 'today' : `${best} days ago`}`) : out('not_met', Number.isFinite(best) ? `Last admin login ${best} days ago` : 'No admin has logged in');
    }
    case 'PAYSLIP': {
      const w = ev.events(c.eventTypes, c.withinDays);
      return w.events >= c.minCount ? out('met', `${w.events} payslips generated, latest ${ago(w.last, ev.asOf)}`) : out('not_met', `No payslips generated in the last ${c.withinDays} days${w.last ? `, latest ${ago(w.last, ev.asOf)}` : ''}`);
    }
    case 'PAYROLL_RUN':
      return within(ev.lastPayrollRun, c.withinDays, ev.asOf) ? out('met', `Last payroll run ${ago(ev.lastPayrollRun, ev.asOf)}`) : out('not_met', ev.lastPayrollRun ? `Last payroll run ${ago(ev.lastPayrollRun, ev.asOf)}` : 'No payroll run yet');
    case 'PAY_SCHEDULE':
      return ev.payScheduleExists === null ? out('unknown', 'Not linked to a Control Panel account') : ev.payScheduleExists ? out('met', 'A pay schedule exists') : out('not_met', 'No pay schedule has been created');
    case 'LAST_USED': {
      const d = ev.lastUsed[c.source];
      return within(d, c.withinDays, ev.asOf) ? out('met', `Last used ${ago(d, ev.asOf)}`) : out('not_met', d ? `Last used ${ago(d, ev.asOf)}` : 'Never used');
    }
  }
}

export interface UsageVerdict {
  inUse: boolean;
  results: CriterionResult[];
}

/**
 * ANY: one met criterion is enough. ALL: every criterion we can judge must be met, and at least one must be judged.
 * A criterion we cannot judge (no data) is left out rather than counted against the customer.
 */
export function evaluateUsage(rule: UsageRule, ev: UsageEvidence): UsageVerdict {
  const results = rule.criteria.map((c) => evaluateCriterion(c, ev));
  const judged = results.filter((r) => r.state !== 'unknown');
  const inUse = rule.mode === 'ANY' ? judged.some((r) => r.state === 'met') : judged.length > 0 && judged.every((r) => r.state === 'met');
  return { inUse, results };
}

export function validateUsageRule(input: unknown): { ok: true; rule: UsageRule } | { ok: false; errors: string[] } {
  const p = UsageRule.safeParse(input);
  if (p.success) return { ok: true, rule: p.data };
  return { ok: false, errors: p.error.issues.map((i) => `${i.path.length ? `Criterion ${typeof i.path[1] === 'number' ? i.path[1] + 1 : ''} ${String(i.path.at(-1))}: ` : ''}${i.message}`.replace(/\s+/g, ' ').trim()) };
}
