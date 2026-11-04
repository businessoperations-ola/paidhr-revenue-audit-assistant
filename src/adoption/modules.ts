/** The products a customer can buy. PLATFORM is general sign-in activity and is not sold on its own. */
export const MODULES = [
  { key: 'PAYROLL', label: 'Payroll' },
  { key: 'CORE_HR', label: 'Core HR and profiles' },
  { key: 'LEAVE', label: 'Leave management' },
  { key: 'LOANS', label: 'Loans' },
  { key: 'EWA', label: 'Earned Wage Access' },
  { key: 'STATUTORY', label: 'Statutory remittance' },
  { key: 'TIME', label: 'Time and attendance' },
  { key: 'EXPENSES', label: 'Expenses' },
] as const;

export type ModuleKey = (typeof MODULES)[number]['key'];
export const MODULE_KEYS: string[] = MODULES.map((m) => m.key);
export const MODULE_LABEL: Record<string, string> = { ...Object.fromEntries(MODULES.map((m) => [m.key, m.label])), PLATFORM: 'Sign-ins' };

/** What employees do, in words a CSM uses. Unknown events fall back to a readable form of their code. */
export const EVENT_LABEL: Record<string, string> = {
  SIGN_IN: 'Sign-ins',
  LEAVE_REQUEST: 'Leave requests',
  LOAN_REQUEST: 'Loan requests',
  PROFILE_UPDATE: 'Profile updates',
  EWA_REQUEST: 'Wage access requests',
  PAYSLIP_VIEW: 'Payslip views',
  CLOCK_IN: 'Clock-ins',
  EXPENSE_CLAIM: 'Expense claims',
  REQUISITION_REQUEST: 'Requisition requests',
  PAYSLIP_GENERATED: 'Payslips generated',
  PAYROLL_RUN: 'Payroll runs',
  PAY_SCHEDULE_CREATED: 'Pay schedules created',
};
export const eventLabel = (code: string): string => EVENT_LABEL[code] ?? code.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The four things CSMs asked to see first, in this order. */
export const HEADLINE_EVENTS = ['SIGN_IN', 'LEAVE_REQUEST', 'LOAN_REQUEST', 'PROFILE_UPDATE'];

/** A customer that uses the left module is a good candidate for the right one. */
export const ADJACENT: Record<string, Array<{ uses: string; because: string }>> = {
  STATUTORY: [{ uses: 'PAYROLL', because: 'runs payroll but does remittance by hand' }],
  EWA: [{ uses: 'PAYROLL', because: 'runs payroll and employees could draw early' }, { uses: 'LOANS', because: 'employees already ask for loans' }],
  LOANS: [{ uses: 'PAYROLL', because: 'runs payroll, so repayments can come off pay' }],
  TIME: [{ uses: 'LEAVE', because: 'already manages leave in the platform' }],
  EXPENSES: [{ uses: 'PAYROLL', because: 'can reimburse through payroll' }],
  LEAVE: [{ uses: 'CORE_HR', because: 'keeps employee records here' }],
  CORE_HR: [{ uses: 'PAYROLL', because: 'runs payroll on employee records' }],
  PERFORMANCE: [{ uses: 'CORE_HR', because: 'keeps employee records here for reviews to build on' }, { uses: 'PAYROLL', because: 'can link reviews to pay' }],
};
