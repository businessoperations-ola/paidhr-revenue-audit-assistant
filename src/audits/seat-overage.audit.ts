import type { Finding, HubSpotCompany } from '../domain/types.js';
import type { AccountRollup } from './hierarchy.js';

/**
 * US-05: flag a parent account when active users across the parent and all of
 * its sub-accounts exceed the paid seats recorded in HubSpot.
 */
export function auditSeatOverage(
  companies: HubSpotCompany[],
  rollups: Map<string, AccountRollup>,
): Finding[] {
  const findings: Finding[] = [];
  for (const c of companies) {
    if (!c.controlPanelId || c.paidSeats === null) continue;
    const rollup = rollups.get(c.controlPanelId);
    if (!rollup) continue;
    const overage = rollup.totalActiveUsers - c.paidSeats;
    if (overage <= 0) continue;
    findings.push({
      type: 'SEAT_OVERAGE',
      severity: 'high',
      entityKey: `hs:${c.hubspotId}`,
      hubspotCompanyId: c.hubspotId,
      controlPanelId: c.controlPanelId,
      companyName: c.name,
      csmEmail: c.csmEmail,
      summary:
        `${rollup.totalActiveUsers} active users across the account and ${rollup.subAccountCount} sub-account(s) ` +
        `vs ${c.paidSeats} paid seats: ${overage} unbilled seat(s)`,
      details: {
        paidSeats: c.paidSeats,
        totalActiveUsers: rollup.totalActiveUsers,
        overageSeats: overage,
        subAccountCount: rollup.subAccountCount,
        subAccountIds: rollup.subAccountIds,
      },
    });
  }
  return findings;
}
