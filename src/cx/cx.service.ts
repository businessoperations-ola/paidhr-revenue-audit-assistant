import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_FEATURES, type AiFeatures, type Clusters, type Playbook, type Qbr } from '../ai/features.js';
import type { ClaudeResult } from '../ai/claude.service.js';
import { rootMembers } from '../audits/hierarchy.js';
import { RulesRepository } from '../audits/rules.repository.js';
import { addDays, daysBetween, todayInLagos, type IsoDate } from '../common/calendar.js';
import { formatNgn } from '../common/money.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import {
  expansionRadar,
  onboardingScorecard,
  type RadarEntry,
  type Scorecard,
  type SeatTrend,
} from './cx-rules.js';

export interface StoredOutput<T> {
  id: number;
  content: T;
  model: string;
  createdAt: string;
}

/** Ticket themes as stored: ids are checked against the input, counts come from code, not from Claude. */
export interface ClusterOutput {
  period: { from: IsoDate; to: IsoDate };
  ticketsAnalysed: number;
  themes: Array<{
    name: string;
    rootCause: string;
    ticketIds: string[];
    ticketCount: number;
    suggestedFix: string;
    macro: { subject: string; body: string };
    kbArticle: { title: string; outline: string[] };
  }>;
  unclusteredNote: string;
}

export class AiDisabledError extends Error {
  constructor() {
    super('Claude features are not enabled (AI_FEATURES_ENABLED)');
  }
}

const SENTIMENT_BATCH = 40;
const MAX_CLUSTER_TICKETS = 300;
const MAX_THEMES = 5;

@Injectable()
export class CxService {
  private readonly log = new Logger(CxService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(RulesRepository) private readonly rules: RulesRepository,
    @Inject(AI_FEATURES) private readonly ai: AiFeatures,
  ) {}

  get aiEnabled(): boolean {
    return this.cfg.AI_FEATURES_ENABLED;
  }

  // ------------------------------------------------------------------ deterministic views

  /** US-27: accounts worth an upsell or cross-sell conversation. */
  async radar(date: IsoDate): Promise<{ asOf: IsoDate; entries: RadarEntry[] } | null> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const rules = await this.rules.load();
    const [companies, accounts, now, then] = await Promise.all([
      this.snapshots.loadCompanies(asOf),
      this.snapshots.loadAccounts(asOf),
      this.seatsOn(asOf),
      this.seatsOn(addDays(asOf, -rules.radar_seat_growth_days)),
    ]);
    const trends = new Map<string, SeatTrend>(companies.map((c) => [c.hubspotId, { seatsNow: now.get(c.hubspotId) ?? null, seatsThen: then.get(c.hubspotId) ?? null }]));
    return {
      asOf,
      entries: expansionRadar(companies, accounts, trends, {
        growthPct: rules.radar_seat_growth_pct,
        growthDays: rules.radar_seat_growth_days,
        ewaVolumeKobo: BigInt(rules.radar_ewa_volume_kobo),
        contractorMin: rules.radar_contractor_min,
      }),
    };
  }

  /** US-26: first-90-day scorecard. */
  async scorecard(date: IsoDate): Promise<(Scorecard & { asOf: IsoDate }) | null> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const rules = await this.rules.load();
    return { asOf, ...onboardingScorecard(await this.snapshots.loadAccounts(asOf), asOf, rules.onboarding_sla_days) };
  }

  // ------------------------------------------------------------------ Claude: sentiment (before the audit)

  /** Scores open tickets that have no sentiment yet, so the support early warning can use tone. */
  async scoreSentiment(): Promise<{ attempted: number; scored: number }> {
    if (!this.cfg.AI_FEATURES_ENABLED) return { attempted: 0, scored: 0 };
    const { rows } = await this.db.query<{ ticket_id: string; subject: string; content: string }>(
      `SELECT ticket_id, subject, content FROM ticket
        WHERE NOT is_closed AND sentiment IS NULL AND created_at > now() - interval '90 days'
        ORDER BY created_at DESC LIMIT $1`,
      [this.cfg.AI_MAX_ITEMS_PER_RUN],
    );
    let scored = 0;
    for (let i = 0; i < rows.length; i += SENTIMENT_BATCH) {
      const batch = rows.slice(i, i + SENTIMENT_BATCH);
      const result = await this.ai.sentiment(batch.map((t) => ({ id: t.ticket_id, subject: t.subject, content: t.content, status: 'open' as const })));
      if (!result) continue;
      const known = new Set(batch.map((t) => t.ticket_id));
      for (const s of result.value.scores) {
        if (!known.has(s.ticket_id)) continue; // ignore anything not asked about
        const sentiment = Math.max(-2, Math.min(2, Math.round(s.sentiment)));
        await this.db.query(
          'UPDATE ticket SET sentiment = $2, sentiment_signal = $3, sentiment_at = now() WHERE ticket_id = $1',
          [s.ticket_id, sentiment, s.signal.slice(0, 120)],
        );
        known.delete(s.ticket_id);
        scored += 1;
      }
    }
    return { attempted: rows.length, scored };
  }

  // ------------------------------------------------------------------ Claude: onboarding playbooks (after the audit)

  /** US-26: a step-by-step unblocking playbook for each open onboarding alert that has none yet. */
  async writePlaybooks(): Promise<{ written: number }> {
    if (!this.cfg.AI_FEATURES_ENABLED) return { written: 0 };
    const { rows } = await this.db.query<{ id: string; hubspot_company_id: string | null; company_name: string; csm_email: string | null; details: Record<string, any> }>(
      `SELECT f.id, f.hubspot_company_id, f.company_name, f.csm_email, f.details FROM audit_flag f
        WHERE f.type = 'ONBOARDING_STAGNATION' AND f.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM ai_output o WHERE o.kind = 'onboarding_playbook' AND o.subject_key = f.id::text)
        ORDER BY f.id LIMIT $1`,
      [this.cfg.AI_MAX_ITEMS_PER_RUN],
    );
    let written = 0;
    const today = todayInLagos();
    for (const f of rows) {
      const tickets = f.hubspot_company_id
        ? (await this.db.query<{ subject: string; created_at: Date }>(
            'SELECT subject, created_at FROM ticket WHERE hubspot_company_id = $1 AND NOT is_closed ORDER BY created_at LIMIT 5',
            [f.hubspot_company_id],
          )).rows
        : [];
      const result = await this.ai.playbook({
        company: f.company_name,
        daysInOnboarding: Number(f.details.daysInOnboarding ?? 0),
        slaDays: Number(f.details.slaDays ?? 14),
        usersAdded: Number(f.details.activeUsers ?? 0),
        contractorUsers: Number(f.details.contractorUsers ?? 0),
        openTickets: tickets.map((t) => ({ subject: t.subject, openDays: daysBetween(todayInLagos(t.created_at), today) })),
      });
      if (!result) continue;
      await this.storeOutput('onboarding_playbook', String(f.id), { ...result, value: tidyPlaybook(result.value) }, 'scheduler');
      written += 1;
    }
    return { written };
  }

  // ------------------------------------------------------------------ Claude: ticket clustering (US-28)

  /** Groups the last 30 days of tickets into at most five themes, each with a draft macro and KB article. */
  async clusterTickets(date: IsoDate, actor = 'scheduler'): Promise<StoredOutput<ClusterOutput> | null> {
    if (!this.cfg.AI_FEATURES_ENABLED) throw new AiDisabledError();
    const from = addDays(date, -30);
    const { rows } = await this.db.query<{ ticket_id: string; subject: string; content: string; is_closed: boolean }>(
      `SELECT ticket_id, subject, content, is_closed FROM ticket
        WHERE created_at >= $1::date ORDER BY created_at DESC LIMIT ${MAX_CLUSTER_TICKETS}`,
      [from],
    );
    if (rows.length < 3) return null;
    const result = await this.ai.clusters(rows.map((t) => ({ id: t.ticket_id, subject: t.subject, content: t.content, status: t.is_closed ? ('closed' as const) : ('open' as const) })));
    if (!result) return null;
    const content = tidyClusters(result.value, new Set(rows.map((r) => r.ticket_id)), { from, to: date }, rows.length);
    return this.storeOutput('ticket_clusters', `${from}..${date}`, { ...result, value: content }, actor);
  }

  latestClusters(): Promise<StoredOutput<ClusterOutput> | null> {
    return this.latestOutput<ClusterOutput>('ticket_clusters');
  }

  // ------------------------------------------------------------------ Claude: QBR (US-27)

  /** An on-demand QBR outline for one account, written from verified facts. */
  async qbr(hubspotId: string, date: IsoDate, actor: string): Promise<StoredOutput<Qbr> | null> {
    if (!this.cfg.AI_FEATURES_ENABLED) throw new AiDisabledError();
    const facts = await this.accountFacts(hubspotId, date);
    if (!facts) return null;
    const result = await this.ai.qbr(facts);
    if (!result) return null;
    return this.storeOutput('qbr', hubspotId, { ...result, value: tidyQbr(result.value) }, actor);
  }

  latestQbr(hubspotId: string): Promise<StoredOutput<Qbr> | null> {
    return this.latestOutput<Qbr>('qbr', hubspotId);
  }

  latestPlaybook(flagId: number): Promise<StoredOutput<Playbook> | null> {
    return this.latestOutput<Playbook>('onboarding_playbook', String(flagId));
  }

  /** The facts Claude is allowed to use for a QBR. Money is pre-formatted, and there are no email addresses. */
  async accountFacts(hubspotId: string, date: IsoDate): Promise<Record<string, unknown> | null> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const companies = await this.snapshots.loadCompanies(asOf);
    const c = companies.find((x) => x.hubspotId === hubspotId);
    if (!c) return null;
    const accounts = await this.snapshots.loadAccounts(asOf);
    const group = c.controlPanelId ? (rootMembers(accounts).get(c.controlPanelId) ?? []) : [];
    const rules = await this.rules.load();

    const [metrics, tickets, flags, revenue] = await Promise.all([
      this.db.query<{ snapshot_date: string; rollup_seats: number | null }>(
        'SELECT snapshot_date, rollup_seats FROM company_daily_metrics WHERE hubspot_id = $1 AND snapshot_date >= $2 ORDER BY snapshot_date',
        [hubspotId, addDays(asOf, -365)],
      ),
      this.db.query<{ subject: string; is_closed: boolean; reopen_count: number; created_at: Date }>(
        'SELECT subject, is_closed, reopen_count, created_at FROM ticket WHERE hubspot_company_id = $1 AND created_at >= $2::date ORDER BY created_at DESC',
        [hubspotId, addDays(asOf, -90)],
      ),
      this.db.query<{ type: string; severity: string; summary: string }>(
        "SELECT type, severity, summary FROM audit_flag WHERE hubspot_company_id = $1 AND status = 'open' ORDER BY id",
        [hubspotId],
      ),
      group.length === 0
        ? Promise.resolve({ rows: [] as Array<{ category: string; total: string }> })
        : this.db.query<{ category: string; total: string }>(
            'SELECT category, sum(amount_kobo)::text AS total FROM cp_revenue_line WHERE client_id = ANY($1) AND revenue_date >= $2::date GROUP BY category',
            [group.map((a) => a.clientId), addDays(asOf, -365)],
          ),
    ]);

    const series = metrics.rows.filter((r) => r.rollup_seats !== null);
    const sampled = sample(series, 8).map((r) => ({ date: r.snapshot_date, users: r.rollup_seats }));
    const seatsNow = series.at(-1)?.rollup_seats ?? null;
    const thenRow = [...series].reverse().find((r) => r.snapshot_date <= addDays(asOf, -rules.radar_seat_growth_days));
    const radar = expansionRadar([c], accounts, new Map([[hubspotId, { seatsNow, seatsThen: thenRow?.rollup_seats ?? null }]]), {
      growthPct: rules.radar_seat_growth_pct, growthDays: rules.radar_seat_growth_days,
      ewaVolumeKobo: BigInt(rules.radar_ewa_volume_kobo), contractorMin: rules.radar_contractor_min,
    })[0];

    const lastEwa = group.map((a) => a.ewaLastUsedOn).filter(Boolean).sort().at(-1) ?? null;
    const lastStat = group.map((a) => a.statutoryLastUsedOn).filter(Boolean).sort().at(-1) ?? null;
    return {
      asOf,
      company: {
        name: c.name, industry: c.industry, csm: c.csmName, healthStatus: c.healthStatus, seatTier: c.seatTier,
        contractEndDate: c.contractEndDate, arr: c.arrKobo === null ? null : formatNgn(c.arrKobo), paidSeats: c.paidSeats,
      },
      usage: {
        activeUsers: seatsNow,
        subAccounts: Math.max(0, group.length - 1),
        contractorUsers: group.reduce((n, a) => n + a.contractorUsers, 0),
        userTrend: sampled,
        lastPayrollPayDate: group.map((a) => a.lastPayrollPayDate).filter(Boolean).sort().at(-1) ?? null,
        earnedWageAccess: { lastUsedOn: lastEwa, volumeLast30Days: formatNgn(group.reduce((n, a) => n + (a.ewaVolume30dKobo ?? 0n), 0n)) },
        statutoryRemittanceLastUsedOn: lastStat,
      },
      engagement: {
        lastLoggedContact: c.lastActivityDate,
        daysSinceContact: c.lastActivityDate ? daysBetween(c.lastActivityDate, asOf) : null,
      },
      support: {
        ticketsLast90Days: tickets.rows.length,
        openTickets: tickets.rows.filter((t) => !t.is_closed).length,
        reopenedTickets: tickets.rows.filter((t) => t.reopen_count > 0).length,
        recentSubjects: tickets.rows.slice(0, 5).map((t) => t.subject),
      },
      openAlerts: flags.rows.map((f) => ({ type: f.type, severity: f.severity, summary: f.summary })),
      expansionRevenueLast12Months: Object.fromEntries(revenue.rows.map((r) => [r.category, formatNgn(BigInt(r.total))])),
      expansionSignals: radar?.signals.map((s) => s.text) ?? [],
    };
  }

  // ------------------------------------------------------------------ storage

  private async storeOutput<T>(kind: string, subjectKey: string, result: ClaudeResult<T>, actor: string): Promise<StoredOutput<T>> {
    const { rows } = await this.db.query<{ id: string; created_at: Date }>(
      `INSERT INTO ai_output (kind, subject_key, content, model, input_tokens, output_tokens, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [kind, subjectKey, JSON.stringify(result.value), result.model, result.inputTokens, result.outputTokens, actor],
    );
    return { id: Number(rows[0]!.id), content: result.value, model: result.model, createdAt: rows[0]!.created_at.toISOString() };
  }

  private async latestOutput<T>(kind: string, subjectKey?: string): Promise<StoredOutput<T> | null> {
    const { rows } = await this.db.query<{ id: string; content: T; model: string; created_at: Date }>(
      `SELECT id, content, model, created_at FROM ai_output WHERE kind = $1 ${subjectKey ? 'AND subject_key = $2' : ''} ORDER BY id DESC LIMIT 1`,
      subjectKey ? [kind, subjectKey] : [kind],
    );
    const r = rows[0];
    return r ? { id: Number(r.id), content: r.content, model: r.model, createdAt: r.created_at.toISOString() } : null;
  }

  /** Users per customer on the latest snapshot at or before `date`. Empty when there is no history that old. */
  private async seatsOn(date: IsoDate): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ hubspot_id: string; rollup_seats: number | null }>(
      `SELECT DISTINCT ON (hubspot_id) hubspot_id, rollup_seats FROM company_daily_metrics
        WHERE snapshot_date <= $1 ORDER BY hubspot_id, snapshot_date DESC`,
      [date],
    );
    return new Map(rows.filter((r) => r.rollup_seats !== null).map((r) => [r.hubspot_id, r.rollup_seats!]));
  }
}

// ---------------------------------------------------------------------- tidying Claude's answers

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function tidyPlaybook(p: Playbook): Playbook {
  return {
    summary: clip(p.summary, 600),
    likely_blockers: p.likely_blockers.slice(0, 4).map((b) => clip(b, 300)),
    steps: p.steps.slice(0, 6).map((s) => ({ ...s, action: clip(s.action, 300), within: clip(s.within, 60) })),
    escalate_if: clip(p.escalate_if, 300),
  };
}

export function tidyQbr(q: Qbr): Qbr {
  return {
    ...q,
    wins: q.wins.slice(0, 8),
    risks: q.risks.slice(0, 8),
    growth_opportunities: q.growth_opportunities.slice(0, 6),
    questions_for_client: q.questions_for_client.slice(0, 8),
    slides: q.slides.slice(0, 8).map((s) => ({ title: s.title, bullets: s.bullets.slice(0, 5) })),
  };
}

/**
 * Keep only ticket ids that were really in the input, each in one theme only, drop empty themes,
 * and count tickets in code so a made-up count can never be shown.
 */
export function tidyClusters(raw: Clusters, knownIds: Set<string>, period: { from: IsoDate; to: IsoDate }, analysed: number): ClusterOutput {
  const used = new Set<string>();
  const themes: ClusterOutput['themes'] = [];
  const candidates = raw.themes
    .map((t) => ({ t, ids: [...new Set(t.ticket_ids)].filter((id) => knownIds.has(id)) }))
    .sort((a, b) => b.ids.length - a.ids.length); // stable: ties keep Claude's order
  for (const { t, ids } of candidates) {
    const own = ids.filter((id) => !used.has(id)); // a ticket belongs to the first (largest) theme that claims it
    if (own.length === 0) continue;
    if (themes.length >= MAX_THEMES) break;
    own.forEach((id) => used.add(id));
    themes.push({
      name: clip(t.name, 120),
      rootCause: clip(t.root_cause, 500),
      ticketIds: own,
      ticketCount: own.length,
      suggestedFix: clip(t.suggested_fix, 500),
      macro: { subject: clip(t.macro.subject, 200), body: clip(t.macro.body, 2000) },
      kbArticle: { title: clip(t.kb_article.title, 200), outline: t.kb_article.outline.slice(0, 8).map((o) => clip(o, 150)) },
    });
  }
  themes.sort((a, b) => b.ticketCount - a.ticketCount);
  return { period, ticketsAnalysed: analysed, themes, unclusteredNote: clip(raw.unclustered_note, 300) };
}

/** Evenly spaced items, always including the last. */
function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]!);
}
