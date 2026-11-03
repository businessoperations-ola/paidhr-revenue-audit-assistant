import { formatNgn, koboToJson } from '../common/money.js';
import type { CompanyDayPoint, Finding, HubSpotCompany } from '../domain/types.js';

/**
 * US-02: catch growth or renewals that were never billed.
 *
 * For each company we find when its ARR last changed (the "billing baseline").
 * - If Control Panel seats today exceed seats on the baseline day while ARR is
 *   unchanged, it is SEAT_INCREASE_NO_ARR_CHANGE.
 * - If the contract end date moved later (a renewal) after the baseline while ARR
 *   is unchanged, it is RENEWAL_NO_ARR_CHANGE.
 *
 * `history` holds daily points, oldest first, ending with today.
 */
export function auditSeatChanges(
  company: HubSpotCompany,
  history: CompanyDayPoint[],
): Finding[] {
  if (history.length < 2) return [];
  const today = history.at(-1)!;
  if (today.arrKobo === null) return [];

  // Walk back while ARR equals today's ARR: the earliest such day is the baseline.
  let baselineIndex = history.length - 1;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    if (history[i]!.arrKobo !== today.arrKobo) break;
    baselineIndex = i;
  }
  const baseline = history[baselineIndex]!;
  const findings: Finding[] = [];

  if (baseline.seats !== null && today.seats !== null && today.seats > baseline.seats) {
    const added = today.seats - baseline.seats;
    findings.push({
      type: 'SEAT_INCREASE_NO_ARR_CHANGE',
      severity: 'high',
      entityKey: `hs:${company.hubspotId}`,
      hubspotCompanyId: company.hubspotId,
      controlPanelId: company.controlPanelId,
      companyName: company.name,
      csmEmail: company.csmEmail,
      summary:
        `Active users rose from ${baseline.seats} to ${today.seats} (+${added}) since ${baseline.date}, ` +
        `but ARR is still ${formatNgn(today.arrKobo)}: possible under-billing`,
      details: {
        baselineDate: baseline.date,
        seatsAtBaseline: baseline.seats,
        seatsToday: today.seats,
        seatsAdded: added,
        arrKobo: koboToJson(today.arrKobo),
      },
    });
  }

  if (
    baseline.contractEndDate !== null &&
    today.contractEndDate !== null &&
    today.contractEndDate > baseline.contractEndDate
  ) {
    findings.push({
      type: 'RENEWAL_NO_ARR_CHANGE',
      severity: 'medium',
      entityKey: `hs:${company.hubspotId}`,
      hubspotCompanyId: company.hubspotId,
      controlPanelId: company.controlPanelId,
      companyName: company.name,
      csmEmail: company.csmEmail,
      summary:
        `Contract renewed (end date ${baseline.contractEndDate} → ${today.contractEndDate}) ` +
        `with ARR unchanged at ${formatNgn(today.arrKobo)}: confirm renewal pricing`,
      details: {
        baselineDate: baseline.date,
        previousContractEnd: baseline.contractEndDate,
        newContractEnd: today.contractEndDate,
        arrKobo: koboToJson(today.arrKobo),
      },
    });
  }

  return findings;
}
