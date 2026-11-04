import { Inject, Injectable } from '@nestjs/common';
import { FlagRepository } from '../audits/flag.repository.js';
import { rootMembers } from '../audits/hierarchy.js';
import { RulesRepository } from '../audits/rules.repository.js';
import { addDays, daysBetween, type IsoDate } from '../common/calendar.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import type { ControlPanelAccount, HubSpotCompany } from '../domain/types.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { OrgService, type Scope } from '../org/org.service.js';
import { AdoptionCatalogService } from './catalog.service.js';
import { adoptionRate, churnRisk, csatPct, npsBand, partialChurn, upsellOpportunities, type ClientFacts, type ModuleFact, type Scales } from './intelligence.js';
import { DEFAULT_SCORING, type ScoringConfig } from './scoring-config.js';
import { AdoptionSettingsService } from './settings.service.js';
import { evaluateUsage, usageRuleFor, validateUsageRule, WINDOWS, type CriterionResult, type EventWindow, type UsageEvidence, type UsageRule, type Window } from './usage.js';
import { HEADLINE_EVENTS, eventLabel } from './modules.js';
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
  eventsPrior30: number;
  lastActive: IsoDate | null;
  purchasedOn: IsoDate | null;
  /** How the usage rule combines its criteria, and what each one found. */
  mode: 'ANY' | 'ALL';
  criteria: CriterionResult[];
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
  /** Modules bought as a share of all customers in scope, and in use as a share of all of them. */
  inUseOfAllPct: number;
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
  arrKobo: bigint | null;
  daysToRenewal: number | null;
  adoption: { purchased: number; inUse: number; unused: number; ratePct: number | null; band: 'strong' | 'partial' | 'weak' | null };
  churn: { score: number; level: 'high' | 'medium' | 'low'; reasons: Array<{ points: number; text: string }> };
  partial: { level: 'high' | 'medium' | 'none'; modules: Array<{ module: string; label: string; risk: 'high' | 'medium'; reasons: string[] }> };
  experience: { nps: number | null; npsBand: string | null; csat: number | null; csatPct: number | null; openTickets: number; closedTickets90: number };
  /** The best three modules to raise, with the points behind each. */
  topOpportunities: Array<{ module: string; label: string; score: number; band: string; held: boolean }>;
}

const HEADLINE = new Set(HEADLINE_EVENTS);
const adminStatus = (days: number | null): AdminStatus => (days === null ? 'never' : days <= 14 ? 'active' : days <= 30 ? 'quiet' : 'dormant');
const pctChange = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) * 100) / before) : null);
const num = (v: unknown) => Number(v ?? 0);
const isoOf = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : String(d));

interface ActivityWindowRow { client_id: string; module: string; event_type: string; last_date: IsoDate | null; [k: string]: string | number | null }
interface ActivityAgg { client_id: string; module: string; event_type: string; last30: string; prior30: string; last_date: IsoDate | null }

/** Product adoption for every client in a person's scope: admins, employees, support and modules. */
@Injectable()
export class AdoptionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(RulesRepository) private readonly rules: RulesRepository,
    @Inject(AdoptionCatalogService) private readonly catalog: AdoptionCatalogService,
    @Inject(AdoptionSettingsService) private readonly settings: AdoptionSettingsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------------ overview

  async overview(scope: Scope, date: IsoDate, csm?: string) {
    const ctx = await this.context(date);
    if (!ctx) return null;
    const want = csm?.toLowerCase();
    const inScope = ctx.companies.filter((c) => (want ? c.csmEmail?.toLowerCase() === want : scope.all || OrgService.includes(scope, c.csmEmail)));
    const uctx = this.upsellContext(ctx);
    const assessed = new Map(inScope.map((c) => [c.hubspotId, this.assess(ctx, c, uctx)]));
    const clients = inScope.map((c) => assessed.get(c.hubspotId)!.summary);
    const opportunities = inScope.flatMap((c) => assessed.get(c.hubspotId)!.opps.filter((o) => o.score >= ctx.scoring.upsell.cool).map((o) => ({
      hubspotId: c.hubspotId, client: c.name, csmName: c.csmName, arrKobo: c.arrKobo, module: o.module, label: o.label, score: o.score, band: o.band,
      held: o.holds.length > 0, holds: o.holds, isNewLaunch: o.isNewLaunch, when: o.when, reasons: o.reasons.slice(0, 5),
    }))).sort((a, b) => b.score - a.score);
    return { asOf: ctx.asOf, modulesKnown: ctx.moduleRows.size > 0, matrix: this.matrix(ctx, inScope, assessed), portfolio: this.portfolio(clients, inScope), clients, opportunities, newLaunches: ctx.catalog.filter((m) => m.active && m.launchedOn && daysBetween(m.launchedOn, ctx.asOf) >= 0 && daysBetween(m.launchedOn, ctx.asOf) <= ctx.rules.upsell_launch_days).map((m) => ({ key: m.key, label: m.label, launchedOn: m.launchedOn, note: m.launchNote })) };
  }

  /** Adoption rate for the whole portfolio, and how it splits into churn, partial churn and upsell. */
  private portfolio(clients: ClientAdoptionSummary[], companies: HubSpotCompany[]) {
    const arr = new Map(companies.map((c) => [c.hubspotId, c.arrKobo ?? 0n]));
    const withModules = clients.filter((c) => c.adoption.purchased > 0);
    const bought = withModules.reduce((n, c) => n + c.adoption.purchased, 0);
    const used = withModules.reduce((n, c) => n + c.adoption.inUse, 0);
    const totalArr = withModules.reduce((n, c) => n + (arr.get(c.hubspotId) ?? 0n), 0n);
    const weighted = totalArr === 0n ? null : Number(withModules.reduce((n, c) => n + BigInt(Math.round((c.adoption.ratePct ?? 0) * 100)) * (arr.get(c.hubspotId) ?? 0n), 0n) / (totalArr * 100n));
    const sumArr = (xs: ClientAdoptionSummary[]) => xs.reduce((n, c) => n + (arr.get(c.hubspotId) ?? 0n), 0n);
    const high = clients.filter((c) => c.churn.level === 'high');
    const medium = clients.filter((c) => c.churn.level === 'medium');
    const partialClients = clients.filter((c) => c.partial.level !== 'none');
    return {
      clients: clients.length,
      withModuleData: withModules.length,
      modulesBought: bought,
      modulesInUse: used,
      adoptionRatePct: bought ? Math.round((used * 100) / bought) : null,
      adoptionRateArrWeightedPct: weighted,
      bands: { strong: withModules.filter((c) => c.adoption.band === 'strong').length, partial: withModules.filter((c) => c.adoption.band === 'partial').length, weak: withModules.filter((c) => c.adoption.band === 'weak').length, unknown: clients.length - withModules.length },
      churn: { high: high.length, medium: medium.length, low: clients.length - high.length - medium.length, highArrKobo: sumArr(high), mediumArrKobo: sumArr(medium) },
      partialChurn: { clients: partialClients.length, modules: partialClients.reduce((n, c) => n + c.partial.modules.length, 0), arrKobo: sumArr(partialClients) },
      upsell: { hot: clients.filter((c) => c.topOpportunities[0]?.band === 'hot' && !c.topOpportunities[0].held).length, warm: clients.filter((c) => c.topOpportunities[0]?.band === 'warm' && !c.topOpportunities[0].held).length, held: clients.filter((c) => c.topOpportunities.length > 0 && c.topOpportunities.every((o) => o.held)).length },
    };
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
    const a = this.assess(ctx, company, this.upsellContext(ctx));
    return {
      asOf: ctx.asOf,
      client: { hubspotId: company.hubspotId, name: company.name, csmName: company.csmName, csmEmail: company.csmEmail },
      summary: a.summary,
      admins,
      employees: { lines, weekly, dailyActive: this.dailyActive(ctx, ids), activeSeats: this.activeSeats(ctx, company) },
      support: tickets,
      modules: this.moduleRows(ctx, company),
      churn: { score: a.risk.score, level: a.risk.level, reasons: a.risk.reasons },
      partialChurn: a.partial,
      opportunities: a.opps,
      signals: ctx.signals.filter((x) => x.hubspotId === hubspotId),
    };
  }

  // ------------------------------------------------------------------ trying a usage rule before saving it

  /** How many clients would be counted as using a module under a draft rule, against the saved one. */
  async previewUsage(module: string, input: unknown, date: IsoDate) {
    const v = validateUsageRule(input);
    if (!v.ok) return { errors: v.errors };
    const ctx = await this.context(date);
    if (!ctx) return null;
    const changes: Array<{ hubspotId: string; name: string; now: boolean; draft: boolean; why: string }> = [];
    let bought = 0, now = 0, draft = 0;
    for (const c of ctx.companies) {
      const current = this.moduleRows(ctx, c).find((m) => m.key === module);
      if (!current || current.status === 'not_purchased') continue;
      const proposed = this.moduleRows(ctx, c, { module, rule: v.rule }).find((m) => m.key === module)!;
      bought += 1;
      const a = current.status === 'in_use', b = proposed.status === 'in_use';
      if (a) now += 1;
      if (b) draft += 1;
      if (a !== b) changes.push({ hubspotId: c.hubspotId, name: c.name, now: a, draft: b, why: (proposed.criteria.find((r) => r.state === (b ? 'met' : 'not_met')) ?? proposed.criteria[0])?.detail ?? '' });
    }
    return { errors: [] as string[], bought, inUseNow: now, inUseDraft: draft, changes: changes.slice(0, 20), totalChanges: changes.length };
  }

  // ------------------------------------------------------------------ loading

  private async context(date: IsoDate) {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const d30 = addDays(asOf, -30);
    const d60 = addDays(asOf, -60);
    const winSums = WINDOWS.map((w) => `COALESCE(sum(events) FILTER (WHERE activity_date > $1::date - ${w}), 0)::bigint AS e${w}, COALESCE(max(active_employees) FILTER (WHERE activity_date > $1::date - ${w}), 0)::int AS a${w}`).join(', ');
    const [scoring, usageRules, activityWin, catalog, windows, signals, companies, accounts, rules, flags, admins, activity, daily, modules, tickets] = await Promise.all([
      this.settings.scoring(),
      this.settings.usageRules(),
      this.db.query<ActivityWindowRow>(`SELECT client_id, module, event_type, max(activity_date) AS last_date, ${winSums} FROM cp_employee_activity WHERE activity_date > $1::date - 90 AND activity_date <= $1 GROUP BY client_id, module, event_type`, [asOf]),
      this.catalog.modules(),
      this.catalog.windows(),
      this.catalog.signals(),
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
      this.db.query<{ client_id: string; module: string; purchased_on: IsoDate | null; configured_on: IsoDate | null; configured_known: boolean }>('SELECT client_id, module, purchased_on, configured_on, configured_known FROM cp_client_module'),
      this.db.query<{ ticket_id: string; hubspot_company_id: string; priority: string | null; created_at: Date; first_response_at: Date | null; closed_at: Date | null; is_closed: boolean; reopen_count: number }>(
        `SELECT ticket_id, hubspot_company_id, priority, created_at, first_response_at, closed_at, is_closed, reopen_count FROM ticket WHERE hubspot_company_id IS NOT NULL AND (NOT is_closed OR created_at > now() - interval '90 days')`,
      ),
    ]);
    const members = rootMembers(accounts);
    const accountsById = new Map(accounts.map((a) => [a.clientId, a]));
    const moduleRows = new Map<string, Map<string, IsoDate | null>>();
    const configured = new Map<string, Map<string, 'yes' | 'no' | 'unknown'>>();
    for (const m of modules.rows) {
      moduleRows.set(m.client_id, (moduleRows.get(m.client_id) ?? new Map()).set(m.module, m.purchased_on));
      configured.set(m.client_id, (configured.get(m.client_id) ?? new Map()).set(m.module, !m.configured_known ? 'unknown' : m.configured_on ? 'yes' : 'no'));
    }
    const slaRules = slaRulesFrom(rules);
    const now = new Date();
    const scales: Scales = { npsScale: this.cfg.NPS_SCALE, csatMax: this.cfg.CSAT_SCALE_MAX };
    return { asOf, today: new Date(`${asOf}T00:00:00Z`), scoring, usageRules, activityWin: activityWin.rows, configured, catalog, windows, signals, scales, companies, accounts, accountsById, members, rules, slaRules, now, flags, admins: admins.rows, activity: activity.rows, daily: daily.rows, moduleRows, tickets: tickets.rows };
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

  /** Everything the usage criteria may look at, for one client. */
  private evidence(ctx: Ctx, c: HubSpotCompany, module: string): UsageEvidence {
    const ids = this.clientIds(ctx, c);
    const acc = (c.controlPanelId ? ctx.members.get(c.controlPanelId) : undefined) ?? [];
    const rows = ctx.activityWin.filter((r) => ids.includes(r.client_id));
    const window = (match: (r: ActivityWindowRow) => boolean, days: Window): EventWindow => {
      const hit = rows.filter(match);
      const perClient = new Map<string, number>();
      for (const r of hit) perClient.set(r.client_id, Math.max(perClient.get(r.client_id) ?? 0, num(r[`a${days}`])));
      const used = hit.filter((r) => num(r[`e${days}`]) > 0);
      return { events: hit.reduce((n, r) => n + num(r[`e${days}`]), 0), maxActive: [...perClient.values()].reduce((n, v) => n + v, 0), last: used.map((r) => r.last_date).filter((d): d is IsoDate => d !== null).sort().at(-1) ?? null };
    };
    const latest = (xs: Array<IsoDate | null>) => xs.reduce<IsoDate | null>((m, x) => (x && (!m || x > m) ? x : m), null);
    let configured: 'yes' | 'no' | 'unknown' = 'unknown';
    for (const id of ids) { const v = ctx.configured.get(id)?.get(module); if (v === 'yes') configured = 'yes'; else if (v === 'no' && configured === 'unknown') configured = 'no'; }
    if (configured === 'unknown' && module === 'PAYROLL' && acc.length > 0) configured = acc.some((a) => a.payFrequency !== null) ? 'yes' : 'no';
    return {
      asOf: ctx.asOf,
      configured,
      events: (types, days) => window((r) => (types.length > 0 ? types.includes(r.event_type) : r.module === module), days),
      signIns: (days) => window((r) => r.event_type === 'SIGN_IN', days),
      adminLogins: ctx.admins.filter((a) => ids.includes(a.client_id)).map((a) => {
        const last = isoOf(a.last_login_at);
        return { level: a.level, daysSince: last ? Math.max(0, daysBetween(last.slice(0, 10), ctx.asOf)) : null };
      }),
      lastPayrollRun: latest(acc.map((a) => a.lastPayrollPayDate)),
      payScheduleExists: acc.length === 0 ? null : acc.some((a) => a.payFrequency !== null),
      lastUsed: { ewa: latest(acc.map((a) => a.ewaLastUsedOn)), statutory: latest(acc.map((a) => a.statutoryLastUsedOn)) },
    };
  }

  private moduleRows(ctx: Ctx, c: HubSpotCompany, ruleOverride?: { module: string; rule: UsageRule }): ModuleRow[] {
    const ids = this.clientIds(ctx, c);
    const bought = new Map<string, IsoDate | null>();
    for (const id of ids) for (const [m, on] of ctx.moduleRows.get(id) ?? []) bought.set(m, on);
    const acc = (c.controlPanelId ? ctx.members.get(c.controlPanelId) : undefined) ?? [];
    const latest = (xs: Array<IsoDate | null>) => xs.reduce<IsoDate | null>((m, x) => (x && (!m || x > m) ? x : m), null);
    return ctx.catalog.filter((m) => m.active).map(({ key, label }) => {
      const rows = ctx.activity.filter((r) => ids.includes(r.client_id) && r.module === key);
      const events30 = rows.reduce((n, r) => n + num(r.last30), 0);
      let last = latest(rows.map((r) => r.last_date));
      if (key === 'PAYROLL') last = latest([last, ...acc.map((a) => a.lastPayrollPayDate)]);
      if (key === 'EWA') last = latest([last, ...acc.map((a) => a.ewaLastUsedOn)]);
      if (key === 'STATUTORY') last = latest([last, ...acc.map((a) => a.statutoryLastUsedOn)]);
      const has = bought.has(key);
      const rule = ruleOverride && ruleOverride.module === key ? ruleOverride.rule : usageRuleFor(key, ctx.usageRules);
      const verdict = has ? evaluateUsage(rule, this.evidence(ctx, c, key)) : null;
      const prior30 = rows.reduce((n, r) => n + num(r.prior30), 0);
      return { key, label, status: !has ? 'not_purchased' : verdict!.inUse ? 'in_use' : 'unused', events30, eventsPrior30: prior30, lastActive: last, purchasedOn: bought.get(key) ?? null, mode: rule.mode, criteria: verdict?.results ?? [] } satisfies ModuleRow;
    });
  }

  /** Share of all customers that have bought each module. */
  private peerShares(ctx: Ctx): Map<string, number> {
    const known = ctx.companies.filter((c) => this.clientIds(ctx, c).some((id) => ctx.moduleRows.has(id)));
    const out = new Map<string, number>();
    for (const { key } of ctx.catalog) {
      const n = known.filter((c) => this.clientIds(ctx, c).some((id) => ctx.moduleRows.get(id)?.has(key))).length;
      out.set(key, known.length ? Math.round((n * 100) / known.length) : 0);
    }
    return out;
  }

  // ------------------------------------------------------------------ the scoring

  private facts(ctx: Ctx, c: HubSpotCompany, summary: Omit<ClientAdoptionSummary, 'adoption' | 'churn' | 'partial' | 'experience' | 'topOpportunities' | 'upsellReady'>): ClientFacts {
    const tk = ctx.tickets.filter((t) => t.hubspot_company_id === c.hubspotId);
    const mods: ModuleFact[] = this.moduleRows(ctx, c).map((m) => ({ key: m.key, label: m.label, status: m.status, events30: m.events30, eventsPrior30: m.eventsPrior30 }));
    const myFlags = ctx.flags.filter((f) => f.hubspotCompanyId === c.hubspotId);
    const acc = c.controlPanelId ? ctx.members.get(c.controlPanelId) : undefined;
    const seats = this.activeSeats(ctx, c);
    return {
      health: c.healthStatus,
      daysToRenewal: c.contractEndDate ? daysBetween(ctx.asOf, c.contractEndDate) : null,
      nps: c.nps ?? null,
      csat: c.csat ?? null,
      openTickets: summary.openTickets,
      closedTickets90: tk.filter((t) => t.is_closed).length,
      slaBreaches: summary.slaBreaches,
      reopenedTickets: tk.filter((t) => !t.is_closed && t.reopen_count > 0).length,
      activityChangePct: summary.activityChangePct,
      engagementPct: summary.engagementPct,
      primaryAdmin: ctx.admins.some((a) => this.clientIds(ctx, c).includes(a.client_id) && a.level === 'PRIMARY') ? summary.primaryStatus : 'none',
      payroll: !acc ? 'unknown' : myFlags.some((f) => f.type === 'LATE_PAYROLL') ? 'late' : acc[0]?.payFrequency === null ? 'not_set_up' : 'ok',
      seatUtilisationPct: seats !== null && c.paidSeats ? Math.round((seats * 100) / c.paidSeats) : null,
      urgentAlerts: myFlags.filter((f) => f.severity === 'urgent' || f.severity === 'high').length,
      modules: mods,
      signals: ctx.signals.filter((x) => x.hubspotId === c.hubspotId).map((x) => ({ kind: x.kind, detail: x.detail, happenedOn: x.happenedOn })),
    };
  }

  private upsellContext(ctx: Ctx): UpsellContextLite {
    return {
      catalog: ctx.catalog, windows: ctx.windows, peerPct: this.peerShares(ctx), today: ctx.today,
      launchDays: ctx.rules.upsell_launch_days, lookaheadDays: ctx.rules.upsell_season_lookahead_days,
    };
  }

  // ------------------------------------------------------------------ summaries

  private baseSummary(ctx: Ctx, c: HubSpotCompany) {
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
      arrKobo: c.arrKobo, daysToRenewal: c.contractEndDate ? daysBetween(ctx.asOf, c.contractEndDate) : null,
      primaryLastLoginAt: p.last, primaryDaysSinceLogin: p.days, primaryStatus: p.status,
      secondaryLastLoginAt: s.last, secondaryStatus: s.status,
      dailyActiveEmployees: daily, engagementPct: daily !== null && seats ? Math.min(100, Math.round((daily * 100) / seats)) : null,
      activityLast30: last30, activityChangePct: pctChange(last30, prior30),
      openTickets: sla.length, slaBreaches: sla.filter((r) => r.openBreach).length, slaAtRisk: sla.filter((r) => r.openAtRisk).length,
      modules: { known, purchased: mods.filter((m) => m.status !== 'not_purchased').length, inUse: mods.filter((m) => m.status === 'in_use').length, unused: mods.filter((m) => m.status === 'unused').length },
    };
  }

  /** Everything we work out about one client: adoption rate, churn, partial churn, and every upsell option. */
  private assess(ctx: Ctx, c: HubSpotCompany, uctx: UpsellContextLite) {
    const base = this.baseSummary(ctx, c);
    const f = this.facts(ctx, c, base);
    const known = base.modules.known;
    const risk = churnRisk(f, ctx.scales, ctx.scoring);
    const partial = partialChurn(f, ctx.scales, ctx.scoring);
    const opps = known ? upsellOpportunities(f, ctx.scales, uctx, risk, ctx.scoring) : [];
    const rate = adoptionRate(f.modules, ctx.scoring);
    const summary: ClientAdoptionSummary = {
      ...base,
      adoption: { purchased: rate.purchased, inUse: rate.inUse, unused: rate.unused, ratePct: rate.ratePct, band: rate.band },
      churn: { score: risk.score, level: risk.level, reasons: risk.reasons.slice(0, 5) },
      partial: { level: partial.level, modules: partial.modules.map((m) => ({ module: m.module, label: m.label, risk: m.risk, reasons: m.reasons.map((r) => r.text) })) },
      experience: { nps: c.nps ?? null, npsBand: npsBand(c.nps, ctx.scales.npsScale), csat: c.csat ?? null, csatPct: csatPct(c.csat, ctx.scales.csatMax), openTickets: f.openTickets, closedTickets90: f.closedTickets90 },
      topOpportunities: opps.slice(0, 3).map((o) => ({ module: o.module, label: o.label, score: o.score, band: o.band, held: o.holds.length > 0 })),
      upsellReady: opps.filter((o) => o.band !== 'cool' && o.holds.length === 0).length,
    };
    return { summary, opps, risk, partial, facts: f };
  }

  /** Most purchased against in use against possible upsell, across the clients in scope. */
  private matrix(ctx: Ctx, scoped: HubSpotCompany[], assessed: Map<string, ReturnType<AdoptionService['assess']>>): MatrixRow[] {
    const known = scoped.filter((c) => this.clientIds(ctx, c).some((id) => ctx.moduleRows.has(id)));
    const rows = known.map((c) => ({ c, mods: this.moduleRows(ctx, c), opps: assessed.get(c.hubspotId)!.opps }));
    return ctx.catalog.filter((m) => m.active).map(({ key, label }) => {
      const purchased = rows.filter((r) => r.mods.find((m) => m.key === key)?.status !== 'not_purchased');
      const inUse = purchased.filter((r) => r.mods.find((m) => m.key === key)?.status === 'in_use');
      const pickers = rows
        .map((r) => ({ r, o: r.opps.find((x) => x.module === key) }))
        .filter((x) => x.o && x.o.band !== 'cool' && x.o.holds.length === 0)
        .sort((a, b) => b.o!.score - a.o!.score);
      return {
        key, label,
        purchased: purchased.length,
        purchasedPct: known.length ? Math.round((purchased.length * 100) / known.length) : 0,
        inUse: inUse.length,
        inUsePct: purchased.length ? Math.round((inUse.length * 100) / purchased.length) : null,
        inUseOfAllPct: known.length ? Math.round((inUse.length * 100) / known.length) : 0,
        unusedClients: purchased.filter((r) => r.mods.find((m) => m.key === key)?.status === 'unused').map((r) => r.c.name),
        upsellClients: pickers.slice(0, 6).map((x) => ({ hubspotId: x.r.c.hubspotId, name: x.r.c.name })),
      } satisfies MatrixRow;
    }).sort((a, b) => b.purchased - a.purchased);
  }
}

type Ctx = NonNullable<Awaited<ReturnType<AdoptionService['context']>>>;
type UpsellContextLite = import('./intelligence.js').UpsellContext;
