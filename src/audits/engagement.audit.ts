import { daysBetween, type IsoDate } from '../common/calendar.js';
import type { Finding, HubSpotCompany, Severity } from '../domain/types.js';

/** US-13: maximum days without contact, per HubSpot health status, plus a "default". */
export type InactivityRules = Record<string, number>;

/** Riskier accounts going quiet matters more: At Risk escalates, Healthy stays a nudge. */
function severityFor(health: string | null): Severity {
  const h = health?.trim().toLowerCase();
  if (h === 'at risk') return 'high';
  if (h === 'healthy') return 'low';
  return 'medium';
}

export function thresholdFor(health: string | null, rules: InactivityRules): number {
  const h = health?.trim().toLowerCase();
  const match = Object.entries(rules).find(([k]) => k.toLowerCase() === h);
  return match ? match[1] : (rules.default ?? 14);
}

/**
 * US-14: flag customers whose last logged call, meeting or email is older than
 * the limit for their health status. A company with no logged contact at all is
 * flagged too. The flag resolves itself once new activity is logged.
 */
export function auditEngagement(companies: HubSpotCompany[], today: IsoDate, rules: InactivityRules): Finding[] {
  const findings: Finding[] = [];
  for (const c of companies) {
    const limit = thresholdFor(c.healthStatus, rules);
    const daysInactive = c.lastActivityDate ? daysBetween(c.lastActivityDate, today) : null;
    if (daysInactive !== null && daysInactive <= limit) continue;

    const health = c.healthStatus ?? 'no health status';
    findings.push({
      type: 'ENGAGEMENT_DROUGHT',
      severity: severityFor(c.healthStatus),
      entityKey: `hs:${c.hubspotId}`,
      hubspotCompanyId: c.hubspotId,
      controlPanelId: c.controlPanelId,
      companyName: c.name,
      csmEmail: c.csmEmail,
      summary:
        daysInactive === null
          ? `No call, meeting or email ever logged in HubSpot (${health}, limit ${limit} days)`
          : `${daysInactive} days since the last call, meeting or email (${health}, limit ${limit} days)`,
      details: {
        healthStatus: c.healthStatus,
        lastActivityDate: c.lastActivityDate,
        daysInactive,
        limitDays: limit,
      },
    });
  }
  return findings;
}
