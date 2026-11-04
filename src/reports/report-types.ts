import { addDays, type IsoDate } from '../common/calendar.js';

export type Audience = 'executive' | 'csm' | 'implementation' | 'support';
export type Cadence = 'daily' | 'weekly' | 'monthly';

export const AUDIENCES: Audience[] = ['executive', 'csm', 'implementation', 'support'];
export const CADENCES: Cadence[] = ['daily', 'weekly', 'monthly'];

export const AUDIENCE_LABEL: Record<Audience, string> = {
  executive: 'Leadership',
  csm: 'Customer Success Managers',
  implementation: 'Implementation & Onboarding',
  support: 'Customer Support',
};

export type Tone = 'good' | 'warn' | 'bad';

/** One block of a report. Every channel (email, chat, the web app) draws these the same way. */
export type Section =
  | { kind: 'kpis'; heading?: string; items: Array<{ label: string; value: string; note?: string; tone?: Tone }> }
  | { kind: 'table'; heading: string; columns: string[]; rows: string[][]; empty?: string }
  | {
      kind: 'bridge';
      heading: string;
      /** `kobo` is a bigint as text, so the web app can draw bars to scale. */
      steps: Array<{ label: string; value: string; kobo: string; type: 'start' | 'up' | 'down' | 'end' }>;
    }
  | { kind: 'list'; heading: string; items: string[]; empty?: string }
  | { kind: 'text'; heading?: string; text: string }
  | { kind: 'notice'; text: string };

export interface ReportData {
  audience: Audience;
  cadence: Cadence;
  title: string;
  subtitle: string;
  asOf: IsoDate;
  period: { from: IsoDate; to: IsoDate };
  sections: Section[];
}

/**
 * The window each cadence reports on.
 * - daily: the last day. weekly: the last 7 days.
 * - monthly: the whole previous calendar month (a report on the 1st covers the month just ended).
 */
export function periodFor(cadence: Cadence, date: IsoDate): { from: IsoDate; to: IsoDate } {
  if (cadence === 'daily') return { from: addDays(date, -1), to: date };
  if (cadence === 'weekly') return { from: addDays(date, -7), to: date };
  const firstOfThisMonth = `${date.slice(0, 8)}01`;
  const to = addDays(firstOfThisMonth, -1);
  return { from: `${to.slice(0, 8)}01`, to };
}

export function fmtDate(iso: IsoDate): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
