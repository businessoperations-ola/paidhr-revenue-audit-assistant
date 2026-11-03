/**
 * Naira amounts are held as integer kobo (₦1 = 100 kobo) in a bigint, so
 * ARR checks are exact and the ₦0.01 tolerance in US-01 means "1 kobo".
 */
export type Kobo = bigint;

const NGN_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** Parse a Naira value such as "1200000", "1,200,000.50" or "₦1.2m"-free plain numbers. */
export function parseNgnToKobo(value: unknown): Kobo | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.round(value * 100));
  }
  const cleaned = String(value).replace(/[₦,\s]/g, '').replace(/^NGN/i, '');
  if (cleaned === '') return null;
  if (!NGN_PATTERN.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const kobo = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return negative ? -kobo : kobo;
}

export function formatNgn(kobo: Kobo): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₦${whole}.${frac}`;
}

export function absKobo(k: Kobo): Kobo {
  return k < 0n ? -k : k;
}

/** JSON-safe form for storing in jsonb columns. */
export function koboToJson(k: Kobo | null): string | null {
  return k === null ? null : k.toString();
}
