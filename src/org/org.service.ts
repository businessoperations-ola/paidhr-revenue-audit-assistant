import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../db/database.js';

export interface OrgUser {
  email: string;
  name: string | null;
  role: string;
  managerEmail: string | null;
}

/** Who a person can see. Directors, super admins and viewers see everyone; everyone else sees themselves and everyone under them. */
export interface Scope {
  all: boolean;
  /** The person plus everyone who reports to them, at any depth. Empty set when `all`. */
  emails: Set<string>;
}

const SEES_ALL = new Set(['super_admin', 'cs_director', 'viewer']);

/**
 * The organogram. Reporting lines come from two places that are read together:
 * `app_user.manager_email` (set on the Users screen) and `csm_team` (CSM to team lead,
 * set on the Team leads screen, and used for escalation).
 */
@Injectable()
export class OrgService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async users(): Promise<OrgUser[]> {
    const { rows } = await this.db.query<OrgUser>(`SELECT email, display_name AS name, role, manager_email AS "managerEmail" FROM app_user WHERE active ORDER BY email`);
    return rows;
  }

  /** manager -> direct reports, over both sources. */
  private async edges(): Promise<Map<string, Set<string>>> {
    const [users, team] = await Promise.all([
      this.db.query<{ email: string; manager_email: string }>(`SELECT email, manager_email FROM app_user WHERE active AND manager_email IS NOT NULL`),
      this.db.query<{ csm_email: string; team_lead_email: string }>(`SELECT csm_email, team_lead_email FROM csm_team`),
    ]);
    const out = new Map<string, Set<string>>();
    const add = (manager: string, report: string) => {
      const m = manager.toLowerCase();
      if (!out.has(m)) out.set(m, new Set());
      out.get(m)!.add(report.toLowerCase());
    };
    for (const r of users.rows) add(r.manager_email, r.email);
    for (const r of team.rows) add(r.team_lead_email, r.csm_email);
    return out;
  }

  /** Everyone under `email`, at any depth, not including them. Cycles are tolerated. */
  async descendants(email: string): Promise<Set<string>> {
    const edges = await this.edges();
    const seen = new Set<string>();
    const queue = [...(edges.get(email.toLowerCase()) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next) || next === email.toLowerCase()) continue;
      seen.add(next);
      queue.push(...(edges.get(next) ?? []));
    }
    return seen;
  }

  async scopeFor(user: { email: string; role: string }): Promise<Scope> {
    if (SEES_ALL.has(user.role)) return { all: true, emails: new Set() };
    const emails = await this.descendants(user.email);
    emails.add(user.email.toLowerCase());
    return { all: false, emails };
  }

  /** True when `scope` includes the person (a CSM's email, or any user's). */
  static includes(scope: Scope, email: string | null): boolean {
    return scope.all || (email !== null && scope.emails.has(email.toLowerCase()));
  }

  /** The CSMs inside a scope, for pickers: people with the csm role. */
  async csmsIn(scope: Scope): Promise<OrgUser[]> {
    return (await this.users()).filter((u) => u.role === 'csm' && (scope.all || scope.emails.has(u.email)));
  }

  /** Would making `manager` the manager of `email` create a loop? */
  async wouldLoop(email: string, manager: string): Promise<boolean> {
    if (email.toLowerCase() === manager.toLowerCase()) return true;
    return (await this.descendants(email)).has(manager.toLowerCase());
  }
}
