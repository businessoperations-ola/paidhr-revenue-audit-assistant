import type { ControlPanelAccount } from '../domain/types.js';

export interface AccountRollup {
  parentClientId: string;
  parentName: string;
  /** All active descendants, at any depth. */
  subAccountCount: number;
  /** Active users across the parent and every active descendant. */
  totalActiveUsers: number;
  totalContractorUsers: number;
  subAccountIds: string[];
}

/**
 * US-04: walk the parent/child tree and roll up users per top-level account.
 * A top-level account is an active account with no parent (or whose parent is
 * missing from the data). Cycles are broken defensively.
 */
export function buildRollups(accounts: ControlPanelAccount[]): Map<string, AccountRollup> {
  const active = accounts.filter((a) => a.isActive);
  const byId = new Map(active.map((a) => [a.clientId, a]));
  const children = new Map<string, ControlPanelAccount[]>();
  for (const a of active) {
    if (a.parentClientId && byId.has(a.parentClientId)) {
      const list = children.get(a.parentClientId) ?? [];
      list.push(a);
      children.set(a.parentClientId, list);
    }
  }

  const rollups = new Map<string, AccountRollup>();
  for (const root of active) {
    if (root.parentClientId && byId.has(root.parentClientId)) continue; // not a root
    const seen = new Set<string>([root.clientId]);
    const queue = [...(children.get(root.clientId) ?? [])];
    const subIds: string[] = [];
    let users = root.activeUsers;
    let contractors = root.contractorUsers;
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next.clientId)) continue;
      seen.add(next.clientId);
      subIds.push(next.clientId);
      users += next.activeUsers;
      contractors += next.contractorUsers;
      queue.push(...(children.get(next.clientId) ?? []));
    }
    rollups.set(root.clientId, {
      parentClientId: root.clientId,
      parentName: root.name,
      subAccountCount: subIds.length,
      totalActiveUsers: users,
      totalContractorUsers: contractors,
      subAccountIds: subIds.sort(),
    });
  }
  return rollups;
}
