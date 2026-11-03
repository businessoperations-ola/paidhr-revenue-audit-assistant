import type { ControlPanelAccount, Finding, HubSpotCompany } from '../domain/types.js';

export interface ReconciliationSummary {
  hubspotActiveCompanies: number;
  controlPanelActiveAccounts: number;
  matched: number;
  hubspotOnly: number;
  controlPanelOnly: number;
  brokenLinks: number;
}

export interface ReconciliationResult {
  summary: ReconciliationSummary;
  findings: Finding[];
}

/**
 * US-03: compare active HubSpot customers with active top-level Control Panel accounts.
 *
 * Linking uses the HubSpot company's Control Panel ID property. Sub-accounts are
 * not expected to have their own HubSpot company, so only top-level accounts
 * count as "unlinked" on the Control Panel side.
 */
export function reconcileEntities(
  companies: HubSpotCompany[],
  accounts: ControlPanelAccount[],
): ReconciliationResult {
  const accountsById = new Map(accounts.map((a) => [a.clientId, a]));
  const activeIds = new Set(accounts.filter((a) => a.isActive).map((a) => a.clientId));
  const topLevelActive = accounts.filter(
    (a) => a.isActive && (!a.parentClientId || !activeIds.has(a.parentClientId)),
  );

  const findings: Finding[] = [];
  const linkedIds = new Set<string>();
  let matched = 0;
  let hubspotOnly = 0;
  let brokenLinks = 0;

  for (const c of companies) {
    if (!c.controlPanelId) {
      hubspotOnly += 1;
      findings.push({
        type: 'UNLINKED_HUBSPOT_COMPANY',
        severity: 'medium',
        entityKey: `hs:${c.hubspotId}`,
        hubspotCompanyId: c.hubspotId,
        controlPanelId: null,
        companyName: c.name,
        csmEmail: c.csmEmail,
        summary: 'Active HubSpot customer has no Control Panel ID, so usage and billing cannot be checked',
        details: { domain: c.domain },
      });
      continue;
    }
    const account = accountsById.get(c.controlPanelId);
    if (!account || !account.isActive) {
      brokenLinks += 1;
      findings.push({
        type: 'BROKEN_LINK',
        severity: 'high',
        entityKey: `hs:${c.hubspotId}`,
        hubspotCompanyId: c.hubspotId,
        controlPanelId: c.controlPanelId,
        companyName: c.name,
        csmEmail: c.csmEmail,
        summary: account
          ? `Linked Control Panel account ${c.controlPanelId} is inactive, but HubSpot still shows an active customer`
          : `Linked Control Panel ID ${c.controlPanelId} does not exist`,
        details: { controlPanelId: c.controlPanelId, controlPanelStatus: account ? 'inactive' : 'not_found' },
      });
      continue;
    }
    matched += 1;
    linkedIds.add(c.controlPanelId);
  }

  // A sub-account linked from HubSpot also "covers" its own row.
  const unlinkedAccounts = topLevelActive.filter((a) => !linkedIds.has(a.clientId));
  for (const a of unlinkedAccounts) {
    findings.push({
      type: 'UNLINKED_CONTROL_PANEL_ACCOUNT',
      severity: 'medium',
      entityKey: `cp:${a.clientId}`,
      hubspotCompanyId: null,
      controlPanelId: a.clientId,
      companyName: a.name,
      csmEmail: null,
      summary: `Active Control Panel account with ${a.activeUsers} users has no active HubSpot customer record`,
      details: { activeUsers: a.activeUsers },
    });
  }

  return {
    summary: {
      hubspotActiveCompanies: companies.length,
      controlPanelActiveAccounts: topLevelActive.length,
      matched,
      hubspotOnly,
      controlPanelOnly: unlinkedAccounts.length,
      brokenLinks,
    },
    findings,
  };
}
