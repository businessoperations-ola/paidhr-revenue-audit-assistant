import { Inject, Injectable } from '@nestjs/common';
import { FlagRepository } from '../audits/flag.repository.js';
import { rootMembers } from '../audits/hierarchy.js';
import { RulesRepository } from '../audits/rules.repository.js';
import { addDays, daysBetween, type IsoDate } from '../common/calendar.js';
import { Database } from '../db/database.js';
import type { ControlPanelAccount, HubSpotCompany } from '../domain/types.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { OrgService, type Scope } from '../org/org.service.js';
import { ADJACENT, HEADLINE_EVENTS, MODULES, MODULE_LABEL, eventLabel } from './modules.js';
import { slaFor, slaRulesFrom, type SlaResult } from './sla.js';

export type AdminStatus = 'active' | 'quiet' | 'dormant' | 'never';
export type ModuleStatus = 'in_use' | 'unused' | 'not_purchased';

export interface AdminView {
  email: string;
  name: string | null;
  level: 'PRIMARY' | 'SECONDARY';
  lastLoginAt: string | null;
  daysSinceLogin: number | null;
  status: AdminStatus;
  recentActions: Array<{ at: string; action: string }>;
}

export interface ActivityLine {
  eventType: string;
  label: string;
  module: string;
  last30: number;
  prior30: number;
  /** Change against the 30 days before, rounded. Null when there was no activity before. */
  changePct: number | null;
}

export interface ModuleRow {
  key: string;
  label: string;
  status: ModuleStatus;
  events30: number;
  lastActive: IsoDate | null;
  purchasedOn: IsoDate | null;
}

export interface UpsellPick {
  key: string;
  label: string;
  /** Share of all customers who have bought it. */
  peerPct: number;
  reasons: string[];
  /** False when the account has problems to fix first. */
  ready: boolean;
  holdReason: string | null;
  score: number;
}

export interface MatrixRow {
  key: string;
  label: string;
  purchased: number;
  purchasedPct: number;
  inUse: number;
  inUsePct: number | null;
  unusedClients: string[];
  upsellClients: Array<{ hubspotId: string; name: string }>;
}

export interface ClientAdoptionSummary {
  hubspotId: string;
  name: string;
  csmEmail: string | null;
  csmName: string | null;
  primaryLastLoginAt: string | null;
  primaryDaysSinceLogin: number | null;
  primaryStatus: AdminStatus;
  secondaryLastLoginAt: string | null;
  secondaryStatus: AdminStatus;
  /** Employees who signed in on a typical day, as a share of active seats. */
  dailyActiveEmployees: number | null;
  engagementPct: number | null;
  /** Headline employee activity, last 30 days against the 30 before. */
  activityLast30: number;
  activityChangePct: number | null;
  openTickets: number;
  slaBreaches: number;
  slaAtRisk: number;
  modules: { known: boolean; purchased: number; inUse: number; unused: number };
  upsellReady: number;
}

const HEADLINE = new Set(HEADLINE_EVENTS);
const adminStatus = (days: number | null): AdminStatus => (days === null ? 'never' : days <= 14 ? 'active' : days <= 30 ? 'quiet' : 'dormant');
const pctChange = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) * 100) / before) : null);
const num = (v: unknown) => Number(v ?? 0);
const isoOf = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : String(d));

interface ActivityAgg { client_id: string; module: string; event_type: string; last30: string; prior30: string; last_date: IsoDate | null }

/** Product adoption for every client in a person's scope: admins, employees, support and modules. */
@Injectable()
export class AdoptionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(RulesRepository) private readonly rules: RulesRepository,
  ) {}

  // ------------------------------------------------------------------ overview

  async overview(scope: Scope, date: IsoDate, csm?: string) {
    const ctx = await this.context(date);
    if (!ctx) return null;
    const want = csm?.toLowerCase();
    const inScope = ctx.companies.filter((c) => (want ? c.csmEmail?.toLowerCase() === want : scope.all || OrgService.includes(scope, c.csmEmail)));
    const clients = inScope.map((c) => this.summary(ctx, c));
    return { asOf: ctx.asOf, modulesKnown: ctx.moduleRows.size > 0, matrix: this.matrix(ctx, inScope), clients };
  }

  // ------------------------------------------------------------------ one client

  async client(scope: Scope, date: IsoDate, hubspotId: string) {
    const ctx = await this.context(date);
    if (!ctx) return null;
    const company = ctx.companies.find((c) => c.hubspotId === hubspotId);
    if (!company || !(scope.all || OrgService.includes(scope, company.csmEmail))) return null;
    const ids = this.clientIds(ctx, company);
    const admins = await this.admins(ids, ctx.asOf);
    const [weekly, tickets] = await Promise.all([this.weekly(ids, ctx.asOf), this.tickets(company.hubspotId, ctx)]);
    const lines = this.activityLines(ctx, ids);
    return {
      asOf: ctx.asOf,
      client: { hubspotId: company.hubspotId, name: company.name, csmName: company.csmName, csmEmail: company.csmEmail },
      summary: this.summary(ctx, company),
      admins,
      employees: { lines, weekly, dailyActive: this.dailyActive(ctx, ids), activeSeats: this.activeSeats(ctx, company) },
      support: tickets,
      modules: this.moduleRows(ctx, company),
      upsell: this.upsell(ctx, company),
    };
  }

  // ------------------------------------------------------------------ loading

  private async context(date: IsoDate) {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const d30 = addDays(asOf, -30);
    const d60 = addDays(asOf, -60);
    const [companies, accounts, rules, flags, admins, activity, daily, modules, tickets] = await Promise.all([
      this.snapshots.loadCompanies(asOf),
      this.snapshots.loadAccounts(asOf),
      this.rules.load(),
      this.flags.list({ status: 'open', limit: 2000 }),
      this.db.query<{ client_id: string; email: string; name: string | null; level: 'PRIMARY' | 'SECONDARY'; last_login_at: Date | null }>('SELECT * FROM cp_client_admin'),
      this.db.query<ActivityAgg>(
        `SELECT client_id, module, event_type,
                COALESCE(sum(events) FILTER (WHERE activity_date > $2 AND activity_date <= $1), 0)::bigint AS last30,
                COALESCE(sum(events) FILTER (WHERE activity_date > $3 AND activity_date <= $2), 0)::bigint AS prior30,
                max(activity_date) AS last_date
           FROM cp_employee_activity WHERE activity_date > $3 AND activity_date <= $1 GROUP BY client_id, module, event_type`,
        [asOf, d30, d60],
      ),
      this.db.query<{ client_id: string; activity_date: IsoDate; active: string }>(
        `SELECT client_id, activity_date, sum(active_employees)::bigint AS active FROM cp_employee_activity
          WHERE event_type = 'SIGN_IN' AND activity_date > $2 AND activity_date <= $1 GROUP BY client_id, activity_date`,
        [asOf, d30],
      ),
      this.db.query<{ client_id: string; module: string; purchased_on: IsoDate | null }>('SELECT client_id, module, purchased_on FROM cp_client_module'),
      this.db.query<{ ticket_id: string; hubspot_company_id: string; priority: string | null; created_at: Date; first_response_at: Date | null; closed_at: Date | null; is_closed: boolean }>(
        `SELECT ticket_id, hubspot_company_id, priority, created_at, first_response_at, closed_at, is_closed FROM ticket WHERE hubspot_company_id IS NOT NULL AND (NOT is_closed OR created_at > now() - interval '90 days')`,
      ),
    ]);
    const members = rootMembers(accounts);
    const accountsById = new Map(accounts.map((a) => [a.clientId, a]));
    const moduleRows = new Map<string, Map<string, IsoDate | null>>();
    for (const m of modules.rows) moduleRows.set(m.client_id, (moduleRows.get(m.client_id) ?? new Map()).set(m.module, m.purchased_on));
    const slaRules = slaRulesFrom(rules);
    const now = new Date();
    return { asOf, companies, accounts, accountsById, members, rules, slaRules, now, flags, admins: admins.rows, activity: activity.rows, daily: daily.rows, moduleRows, tickets: tickets.rows };
  }

  private clientIds(ctx: NonNullable<Awaited<ReturnType<AdoptionService['context']>>>, c: HubSpotCompany): string[] {
    return c.controlPanelId ? (ctx.members.get(c.controlPanelId) ?? []).map((a) => a.clientId) : [];
  }

  private activeSeats(ctx: Ctx, c: HubSpotCompany): number | null {
    const m = c.controlPanelId ? ctx.members.get(c.controlPanelId) : undefined;
    return m ? m.reduce((n, a) => n + a.activeUsers, 0) : null;
  }

  // ------------------------------------------------------------------ pieces

  private async admins(ids: string[], asOf: IsoDate): Promise<AdminView[]> {
    if (ids.length === 0) return [];
    const [admins, actions] = await Promise.all([
      this.db.query('SELECT email, name, level, last_login_at FROM cp_client_admin WHERE client_id = ANY($1) ORDER BY level ASC, email', [ids]),
      this.db.query('SELECT email, action_at, action FROM cp_admin_action WHERE client_id = ANY($1) AND action_at > $2::date - interval \'30 days\' ORDER BY action_at DESC', [ids, asOf]),
    ]);
    return admins.rows.map((a) => {
      const last = isoOf(a.last_login_at);
      const days = last ? Math.max(0, daysBetween(last.slice(0, 10), asOf)) : null;
      return {
        email: a.email, name: a.name, level: a.level, lastLoginAt: last, daysSinceLogin: days, status: adminStatus(days),
        recentActions: actions.rows.filter((x) => x.email === a.email).slice(0, 6).map((x) => ({ at: isoOf(x.action_at)!, action: x.action })),
      };
    });
  }

  private activityLines(ctx: Ctx, ids: string[]): ActivityLine[] {
    const by = new Map<string, ActivityLine>();
    for (const r of ctx.activity) {
      if (!ids.includes(r.client_id)) continue;
      const cur = by.get(r.event_type) ?? { eventType: r.event_type, label: eventLabel(r.event_type), module: r.module, last30: 0, prior30: 0, changePct: null };
      cur.last30 += num(r.last30);
      cur.prior30 += num(r.prior30);
      by.set(r.event_type, cur);
    }
    const lines = [...by.values()].map((l) => ({ ...l, changePct: pctChange(l.last30, l.prior30) }));
    const rank = (l: ActivityLine) => (HEADLINE_EVENTS.includes(l.eventType) ? HEADLINE_EVENTS.indexOf(l.eventType) : 100);
    return lines.sort((a, b) => rank(a) - rank(b) || b.last30 - a.last30);
  }

  private async weekly(ids: string[], asOf: IsoDate) {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<{ activity_date: IsoDate; event_type: string; events: string }>(
      `SELECT activity_date, event_type, sum(events)::bigint AS events FROM cp_employee_activity
        WHERE client_id = ANY($1) AND activity_date > $2 AND activity_date <= $3 GROUP BY activity_date, event_type`,
      [ids, addDays(asOf, -56), asOf],
    );
    const weeks = Array.from({ length: 8 }, (_, i) => ({ from: addDays(asOf, -(8 - i) * 7 + 1), to: addDays(asOf, -(7 - i) * 7), counts: {} as Record<string, number> }));
    for (const r of rows) {
      const w = weeks.find((x) => r.activity_date >= x.from && r.activity_date <= x.to);
      if (w && HEADLINE.has(r.event_type)) w.counts[r.event_type] = (w.counts[r.event_type] ?? 0) + num(r.events);
    }
    return weeks;
  }

  private dailyActive(ctx: Ctx, ids: string[]): number | null {
    const perDay = new Map<string, number>();
    for (const r of ctx.daily) if (ids.includes(r.client_id)) perDay.set(r.activity_date, (perDay.get(r.activity_date) ?? 0) + num(r.active));
    return perDay.size === 0 ? null : Math.round([...perDay.values()].reduce((a, b) => a + b, 0) / perDay.size);
  }

  private async tickets(hubspotId: string, ctx: Ctx) {
    const { rows } = await this.db.query(
      `SELECT ticket_id, subject, priority, status_label, raised_by, created_at, first_response_at, closed_at, is_closed, reopen_count
         FROM ticket WHERE hubspot_company_id = $1 AND (NOT is_closed OR created_at > now() - interval '90 days') ORDER BY is_closed, created_at DESC LIMIT 40`,
      [hubspotId],
    );
    const list = rows.map((t) => {
      const sla = slaFor({ priority: t.priority, createdAt: isoOf(t.created_at)!, firstResponseAt: isoOf(t.first_response_at), closedAt: isoOf(t.closed_at), isClosed: t.is_closed }, ctx.slaRules, ctx.now);
      return { id: t.ticket_id, subject: t.subject, status: t.status_label ?? (t.is_closed ? 'Closed' : 'Open'), priority: t.priority, raisedBy: t.raised_by, createdAt: isoOf(t.created_at)!, open: !t.is_closed, ageHours: Math.round((ctx.now.getTime() - Date.parse(isoOf(t.created_at)!)) / 3_600_000), reopenCount: t.reopen_count, sla };
    });
    const replyHours = rows.filter((r) => r.first_response_at).map((r) => Math.max(0, (Date.parse(isoOf(r.first_response_at)!) - Date.parse(isoOf(r.created_at)!)) / 3_600_000));
    const closed = list.filter((t) => !t.open);
    return {
      targets: ctx.slaRules,
      summary: {
        open: list.filter((t) => t.open).length,
        breached: list.filter((t) => t.sla.openBreach).length,
        atRisk: list.filter((t) => t.sla.openAtRisk).length,
        avgFirstResponseHours: replyHours.length ? Math.round((replyHours.reduce((n, h) => n + h, 0) / replyHours.length) * 10) / 10 : null,
        resolvedWithinSlaPct: closed.length ? Math.round((closed.filter((t) => t.sla.resolution.state === 'met').length * 100) / closed.length) : null,
      },
      tickets: list,
    };
  }

  private moduleRows(ctx: Ctx, c: HubSpotCompany): ModuleRow[] {
    const ids = this.clientIds(ctx, c);
    const bought = new Map<string, IsoDate | null>();
    for (const id of ids) for (const [m, on] of ctx.moduleRows.get(id) ?? []) bought.set(m, on);
    const acc = (c.controlPanelId ? ctx.members.get(c.controlPanelId) : undefined) ?? [];
    const within = (d: IsoDate | null, days: number) => d !== null && daysBetween(d, ctx.asOf) <= days;
    const latest = (xs: Array<IsoDate | null>) => xs.reduce<IsoDate | null>((m, x) => (x && (!m || x > m) ? x : m), null);
    return MODULES.map(({ key, label }) => {
      const rows = ctx.activity.filter((r) => ids.includes(r.client_id) && r.module === key);
      const events30 = rows.reduce((n, r) => n + num(r.last30), 0);
      let last = latest(rows.map((r) => r.last_date));
      let used = events30 > 0;
      if (key === 'PAYROLL') { const d = latest(acc.map((a) => a.lastPayrollPayDate)); last = latest([last, d]); used = used || within(d, 45); }
      if (key === 'EWA') { const d = latest(acc.map((a) => a.ewaLastUsedOn)); last = latest([last, d]); used = used || within(d, 30); }
      if (key === 'STATUTORY') { const d = latest(acc.map((a) => a.statutoryLastUsedOn)); last = latest([last, d]); used = used || within(d, 60); }
      const has = bought.has(key);
      return { key, label, status: !has ? 'not_purchased' : used ? 'in_use' : 'unused', events30, lastActive: last, purchasedOn: bought.get(key) ?? null } satisfies ModuleRow;
    });
  }

  /** Share of all customers that have bought each module. */
  private peerShares(ctx: Ctx): Map<string, number> {
    const known = ctx.companies.filter((c) => this.clientIds(ctx, c).some((id) => ctx.moduleRows.has(id)));
    const out = new Map<string, number>();
    for (const { key } of MODULES) {
      const n = known.filter((c) => this.clientIds(ctx, c).some((id) => ctx.moduleRows.get(id)?.has(key))).length;
      out.set(key, known.length ? Math.round((n * 100) / known.length) : 0);
    }
    return out;
  }

  private ready(ctx: Ctx, c: HubSpotCompany): { ready: boolean; reason: string | null } {
    if (c.healthStatus?.toLowerCase() === 'at risk') return { ready: false, reason: 'Account is At Risk: fix that first' };
    const mine = ctx.flags.filter((f) => f.hubspotCompanyId === c.hubspotId);
    if (mine.some((f) => f.severity === 'urgent' || f.severity === 'high')) return { ready: false, reason: 'Has urgent or high alerts open' };
    return { ready: true, reason: null };
  }

  private upsell(ctx: Ctx, c: HubSpotCompany): UpsellPick[] {
    const rows = this.moduleRows(ctx, c);
    if (!rows.some((r) => r.status !== 'not_purchased')) return [];
    const peers = this.peerShares(ctx);
    const state = this.ready(ctx, c);
    const inUse = new Set(rows.filter((r) => r.status === 'in_use').map((r) => r.key));
    return rows
      .filter((r) => r.status === 'not_purchased')
      .map((r) => {
        const reasons: string[] = [];
        const peer = peers.get(r.key) ?? 0;
        if (peer > 0) reasons.push(`${peer}% of customers have it`);
        const adj = (ADJACENT[r.key] ?? []).filter((a) => inUse.has(a.uses));
        for (const a of adj) reasons.push(`Uses ${MODULE_LABEL[a.uses]} and ${a.because}`);
        return { key: r.key, label: r.label, peerPct: peer, reasons, ready: state.ready, holdReason: state.reason, score: peer + adj.length * 30 } satisfies UpsellPick;
      })
      .sort((a, b) => b.score - a.score);
  }

  // ------------------------------------------------------------------ summaries

  private summary(ctx: Ctx, c: HubSpotCompany): ClientAdoptionSummary {
    const ids = this.clientIds(ctx, c);
    const mine = ctx.admins.filter((a) => ids.includes(a.client_id));
    const pick = (level: 'PRIMARY' | 'SECONDARY') => {
      const last = mine.filter((a) => a.level === level).map((a) => isoOf(a.last_login_at)).filter((x): x is string => x !== null).sort().at(-1) ?? null;
      const days = last ? Math.max(0, daysBetween(last.slice(0, 10), ctx.asOf)) : null;
      return { last, days, status: mine.some((a) => a.level === level) ? adminStatus(days) : ('never' as AdminStatus) };
    };
    const p = pick('PRIMARY');
    const s = pick('SECONDARY');
    const head = ctx.activity.filter((r) => ids.includes(r.client_id) && HEADLINE.has(r.event_type));
    const last30 = head.reduce((n, r) => n + num(r.last30), 0);
    const prior30 = head.reduce((n, r) => n + num(r.prior30), 0);
    const seats = this.activeSeats(ctx, c);
    const daily = this.dailyActive(ctx, ids);
    const tk = ctx.tickets.filter((t) => t.hubspot_company_id === c.hubspotId);
    const sla = tk.filter((t) => !t.is_closed).map((t) => slaFor({ priority: t.priority, createdAt: isoOf(t.created_at)!, firstResponseAt: isoOf(t.first_response_at), closedAt: null, isClosed: false }, ctx.slaRules, ctx.now));
    const mods = this.moduleRows(ctx, c);
    const known = ids.some((id) => ctx.moduleRows.has(id));
    return {
      hubspotId: c.hubspotId, name: c.name, csmEmail: c.csmEmail, csmName: c.csmName,
      primaryLastLoginAt: p.last, primaryDaysSinceLogin: p.days, primaryStatus: p.status,
      secondaryLastLoginAt: s.last, secondaryStatus: s.status,
      dailyActiveEmployees: daily, engagementPct: daily !== null && seats ? Math.min(100, Math.round((daily * 100) / seats)) : null,
      activityLast30: last30, activityChangePct: pctChange(last30, prior30),
      openTickets: sla.length, slaBreaches: sla.filter((r) => r.openBreach).length, slaAtRisk: sla.filter((r) => r.openAtRisk).length,
      modules: { known, purchased: mods.filter((m) => m.status !== 'not_purchased').length, inUse: mods.filter((m) => m.status === 'in_use').length, unused: mods.filter((m) => m.status === 'unused').length },
      upsellReady: known ? this.upsell(ctx, c).filter((u) => u.ready && (u.reasons.length > 1 || u.peerPct >= 50)).length : 0,
    };
  }

  /** Most purchased against in use against possible upsell, across the clients in scope. */
  private matrix(ctx: Ctx, scoped: HubSpotCompany[]): MatrixRow[] {
    const known = scoped.filter((c) => this.clientIds(ctx, c).some((id) => ctx.moduleRows.has(id)));
    const rows = known.map((c) => ({ c, mods: this.moduleRows(ctx, c), picks: this.upsell(ctx, c) }));
    return MODULES.map(({ key, label }) => {
      const purchased = rows.filter((r) => r.mods.find((m) => m.key === key)!.status !== 'not_purchased');
      const inUse = purchased.filter((r) => r.mods.find((m) => m.key === key)!.status === 'in_use');
      const pickers = rows
        .map((r) => ({ r, pick: r.picks.find((p) => p.key === key) }))
        .filter((x) => x.pick && x.pick.ready && (x.pick.reasons.length > 1 || x.pick.peerPct >= 50))
        .sort((a, b) => b.pick!.score - a.pick!.score);
      return {
        key, label,
        purchased: purchased.length,
        purchasedPct: known.length ? Math.round((purchased.length * 100) / known.length) : 0,
        inUse: inUse.length,
        inUsePct: purchased.length ? Math.round((inUse.length * 100) / purchased.length) : null,
        unusedClients: purchased.filter((r) => r.mods.find((m) => m.key === key)!.status === 'unused').map((r) => r.c.name),
        upsellClients: pickers.slice(0, 6).map((x) => ({ hubspotId: x.r.c.hubspotId, name: x.r.c.name })),
      } satisfies MatrixRow;
    }).sort((a, b) => b.purchased - a.purchased);
  }
}

type Ctx = NonNullable<Awaited<ReturnType<AdoptionService['context']>>>;
