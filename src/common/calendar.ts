/**
 * Calendar maths in West Africa Time. Dates are plain 'YYYY-MM-DD' strings
 * so nothing shifts by a day when a server runs in UTC.
 */
export type IsoDate = string;

const LAGOS_TZ = 'Africa/Lagos';

export function todayInLagos(now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS_TZ }).format(now);
}

export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

function parse(date: IsoDate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not an ISO date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Same day-of-month in a later month, clamped to that month's last day. */
export function addMonthsClamped(date: IsoDate, months: number, dayOfMonth?: number): IsoDate {
  const d = parse(date);
  const targetDay = dayOfMonth ?? d.getUTCDate();
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(targetDay, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function dayOfWeek(date: IsoDate): number {
  return parse(date).getUTCDay(); // 0 = Sunday
}

/** Working days: Monday–Friday, minus public holidays loaded from the database. */
export class BusinessCalendar {
  private readonly holidays: Set<IsoDate>;

  constructor(holidays: Iterable<IsoDate> = []) {
    this.holidays = new Set(holidays);
  }

  isBusinessDay(date: IsoDate): boolean {
    const dow = dayOfWeek(date);
    return dow !== 0 && dow !== 6 && !this.holidays.has(date);
  }

  /** The date `n` business days after `date` (n >= 0). */
  addBusinessDays(date: IsoDate, n: number): IsoDate {
    let current = date;
    let remaining = n;
    while (remaining > 0) {
      current = addDays(current, 1);
      if (this.isBusinessDay(current)) remaining -= 1;
    }
    return current;
  }

  /** Business days strictly after `from`, up to and including `to`. */
  businessDaysBetween(from: IsoDate, to: IsoDate): number {
    if (to <= from) return 0;
    let count = 0;
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
      if (this.isBusinessDay(d)) count += 1;
    }
    return count;
  }
}
