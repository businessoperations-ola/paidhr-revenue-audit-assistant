import { absKobo, formatNgn, koboToJson, type Kobo } from '../common/money.js';
import type { Finding, HubSpotCompany } from '../domain/types.js';

export interface ArrMathOptions {
  /** Allowed difference in kobo. US-01: anything above ₦0.01 (1 kobo) is flagged. */
  toleranceKobo: Kobo;
  /** Seat count used in the formula, per HubSpot company id. */
  seatsFor: (company: HubSpotCompany) => number | null;
  seatSourceLabel: string;
}

/**
 * US-01: Expected ARR = seats × price per seat per month × 12.
 * Flags a company when |expected − recorded ARR| > tolerance.
 * Companies missing an input are skipped here; the hygiene scan reports them.
 */
export function auditArrMath(companies: HubSpotCompany[], opts: ArrMathOptions): Finding[] {
  const findings: Finding[] = [];
  for (const c of companies) {
    const seats = opts.seatsFor(c);
    if (seats === null || c.pricePerSeatMonthlyKobo === null || c.arrKobo === null) continue;

    const expected = BigInt(seats) * c.pricePerSeatMonthlyKobo * 12n;
    const diff = c.arrKobo - expected;
    if (absKobo(diff) <= opts.toleranceKobo) continue;

    const direction = diff < 0n ? 'under-billed' : 'over-billed';
    findings.push({
      type: 'ARR_MISMATCH',
      severity: 'high',
      entityKey: `hs:${c.hubspotId}`,
      hubspotCompanyId: c.hubspotId,
      controlPanelId: c.controlPanelId,
      companyName: c.name,
      csmEmail: c.csmEmail,
      summary:
        `Recorded ARR ${formatNgn(c.arrKobo)} ≠ expected ${formatNgn(expected)} ` +
        `(${seats} seats × ${formatNgn(c.pricePerSeatMonthlyKobo)} × 12): ${direction} by ${formatNgn(absKobo(diff))}`,
      details: {
        seats,
        seatSource: opts.seatSourceLabel,
        pricePerSeatMonthlyKobo: koboToJson(c.pricePerSeatMonthlyKobo),
        expectedArrKobo: koboToJson(expected),
        recordedArrKobo: koboToJson(c.arrKobo),
        differenceKobo: koboToJson(diff),
        direction,
      },
    });
  }
  return findings;
}
