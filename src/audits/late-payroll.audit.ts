import { addDays, addMonthsClamped, daysInMonth, type BusinessCalendar, type IsoDate } from '../common/calendar.js';
import type { ControlPanelAccount, Finding, HubSpotCompany, PayFrequency } from '../domain/types.js';

const FREQUENCY_LABEL: Record<PayFrequency, string> = {
  MONTHLY: 'Monthly',
  SEMI_MONTHLY: 'Semi-monthly',
  BIWEEKLY: 'Biweekly',
  WEEKLY: 'Weekly',
};

/** The pay date that should follow `lastPayDate` for this schedule. */
export function nextExpectedPayDate(
  lastPayDate: IsoDate,
  frequency: PayFrequency,
  payDay: number | null,
): IsoDate {
  switch (frequency) {
    case 'WEEKLY':
      return addDays(lastPayDate, 7);
    case 'BIWEEKLY':
      return addDays(lastPayDate, 14);
    case 'MONTHLY':
      return addMonthsClamped(lastPayDate, 1, payDay ?? Number(lastPayDate.slice(8, 10)));
    case 'SEMI_MONTHLY': {
      // Paid on the 15th and on the last day of each month.
      const year = Number(lastPayDate.slice(0, 4));
      const month = Number(lastPayDate.slice(5, 7));
      const day = Number(lastPayDate.slice(8, 10));
      const ym = lastPayDate.slice(0, 8);
      const monthEnd = daysInMonth(year, month);
      if (day < 15) return `${ym}15`;
      if (day < monthEnd) return `${ym}${String(monthEnd).padStart(2, '0')}`;
      return addMonthsClamped(`${ym}01`, 1, 15);
    }
  }
}

export interface LatePayrollOptions {
  today: IsoDate;
  calendar: BusinessCalendar;
  /** Business days allowed after the expected pay date before alerting. */
  graceBusinessDays: number;
  /** HubSpot company that owns a Control Panel account (sub-accounts map to their parent's company). */
  companyFor: (clientId: string) => HubSpotCompany | undefined;
}

/**
 * US-24: flag active accounts whose next payroll is past due beyond the grace buffer.
 * Each missed pay date gets its own flag, so a new cycle raises a new alert.
 */
export function auditLatePayroll(accounts: ControlPanelAccount[], opts: LatePayrollOptions): Finding[] {
  const findings: Finding[] = [];
  for (const a of accounts) {
    if (!a.isActive || !a.payFrequency || !a.lastPayrollPayDate) continue;

    const expected = nextExpectedPayDate(a.lastPayrollPayDate, a.payFrequency, a.payDay);
    const deadline = opts.calendar.addBusinessDays(expected, opts.graceBusinessDays);
    if (opts.today <= deadline) continue;

    const overdue = opts.calendar.businessDaysBetween(expected, opts.today);
    const company = opts.companyFor(a.clientId);
    findings.push({
      type: 'LATE_PAYROLL',
      severity: 'urgent',
      entityKey: `cp:${a.clientId}:${expected}`,
      hubspotCompanyId: company?.hubspotId ?? null,
      controlPanelId: a.clientId,
      companyName: company && company.controlPanelId !== a.clientId ? `${company.name} / ${a.name}` : a.name,
      csmEmail: company?.csmEmail ?? null,
      summary:
        `${FREQUENCY_LABEL[a.payFrequency]} payroll expected ${expected} has not run: ` +
        `${overdue} business day(s) overdue (last run paid ${a.lastPayrollPayDate})`,
      details: {
        payFrequency: a.payFrequency,
        payDay: a.payDay,
        lastPayrollPayDate: a.lastPayrollPayDate,
        lastPayrollCompletedAt: a.lastPayrollCompletedAt,
        expectedPayDate: expected,
        alertAfter: deadline,
        businessDaysOverdue: overdue,
        graceBusinessDays: opts.graceBusinessDays,
      },
    });
  }
  return findings;
}
