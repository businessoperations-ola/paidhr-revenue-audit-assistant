/**
 * Ticket text comes from clients and can contain employee details. It is redacted
 * before it is stored, shown in reports or sent to Claude, so none of that
 * ever leaves HubSpot in readable form.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// +234 803 123 4567, 0803-123-4567, (0803) 1234567: groups of digits joined by a space, dash or dot.
// A separator is required, so a plain run of digits is left to LONG_DIGITS (and "5 staff" is never touched).
const PHONE = /(?<![\w.])\+?\(?\d{2,5}\)?(?:[\s.-]\d{2,8}){1,5}(?!\w)/g;
// Account, BVN, NIN, tax-id style runs of digits.
const LONG_DIGITS = /\b\d{8,}\b/g;
const TAGS = /<[^>]*>/g;

export function redactText(input: string | null | undefined, maxLength = 500): string {
  if (!input) return '';
  let t = input.replace(TAGS, ' ').replace(EMAIL, '[email]');
  t = t.replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m));
  t = t.replace(LONG_DIGITS, '[number]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > maxLength ? `${t.slice(0, maxLength - 1).trimEnd()}…` : t;
}
