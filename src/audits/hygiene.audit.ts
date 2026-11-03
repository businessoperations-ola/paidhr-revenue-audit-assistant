import type { Finding, HubSpotCompany } from '../domain/types.js';

/** Mandatory HubSpot fields (US-17), keyed by the name shown to CSMs. */
export const MANDATORY_FIELDS: Record<string, (c: HubSpotCompany) => unknown> = {
  'CSM Name': (c) => c.csmName,
  Industry: (c) => c.industry,
  'Contract End Date': (c) => c.contractEndDate,
  'Seat Tier': (c) => c.seatTier,
  'Seat Count': (c) => c.paidSeats,
  'Deal ARR (₦)': (c) => c.arrKobo,
  'Price per Seat (₦/month)': (c) => c.pricePerSeatMonthlyKobo,
  'Control Panel ID': (c) => c.controlPanelId,
};

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * US-17: one flag per company listing every empty mandatory field.
 * `requiredFields` lets admins switch fields on or off without a code change.
 */
export function auditHygiene(companies: HubSpotCompany[], requiredFields: string[]): Finding[] {
  const checks = requiredFields
    .map((name) => [name, MANDATORY_FIELDS[name]] as const)
    .filter((pair): pair is readonly [string, (c: HubSpotCompany) => unknown] => pair[1] !== undefined);

  const findings: Finding[] = [];
  for (const c of companies) {
    const missing = checks.filter(([, get]) => isEmpty(get(c))).map(([name]) => name);
    if (missing.length === 0) continue;
    findings.push({
      type: 'MISSING_FIELDS',
      severity: 'low',
      entityKey: `hs:${c.hubspotId}`,
      hubspotCompanyId: c.hubspotId,
      controlPanelId: c.controlPanelId,
      companyName: c.name,
      csmEmail: c.csmEmail,
      summary: `Missing in HubSpot: ${missing.join(', ')}`,
      details: { missingFields: missing },
    });
  }
  return findings;
}
