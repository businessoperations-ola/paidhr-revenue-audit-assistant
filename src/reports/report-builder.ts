import { Inject, Injectable } from '@nestjs/common';
import { AnalyticsService, type PeriodAnalytics, type Portfolio } from '../analytics/analytics.service.js';
import { FLAG_TITLES } from '../alerts/message-format.js';
import { FlagRepository, type StoredFlag } from '../audits/flag.repository.js';
import { RulesRepository } from '../audits/rules.repository.js';
import { addDays, daysBetween, type IsoDate } from '../common/calendar.js';
import { formatNgn } from '../common/money.js';
import { CxService } from '../cx/cx.service.js';
import { Database } from '../db/database.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { fmtDate, periodFor, type Audience, type Cadence, type ReportData, type Section } from './report-types.js';

const pct = (n: number | null, digits = 1) => (n === null ? 'n/a' : `${n.toFixed(digits).replace(/\.0+$/, '')}%`);
const HEALTH_RANK: Record<string, number> = { 'At Risk': 0, Neutral: 1, Healthy: 2 };
const SEV_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function flagState(f: StoredFlag): string {
  if (f.escalationLevel === 2) return 'With directors';
  if (f.escalationLevel === 1) return 'With team lead';
  if (f.acknowledgedAt) return 'Acknowledged';
  return f.notifiedAt ? 'Awaiting CSM' : 'Not sent yet';
}

/** Builds the content of every report from the stored snapshots. No sending happens here. */
@Injectable()
export class ReportBuilder {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(CxService) private readonly cx: CxService,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(RulesRepository) private readonly rules: RulesRepository,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(Database) private readonly db: Database,
  ) {}

  /**
   * The CSM audience needs `csm`: one person's email (their own portfolio), or a team
   * (`{ emails, label }`: a team lead's team, or everyone for a director) with a row per person.
   */
  async build(audience: Audience, cadence: Cadence, date: IsoDate, csm?: string | { emails: string[]; label: string }): Promise<ReportData | null> {
    const asOf = await this.snapshots.latestSnapshotDate(date);
    if (!asOf) return null;
    const period = periodFor(cadence, date);
    switch (audience) {
      case 'executive':
        return this.executive(cadence, asOf, period);
      case 'csm':
        if (!csm) throw new Error('A CSM report needs a CSM email');
        return typeof csm === 'string'
          ? this.csm(cadence, asOf, period, [csm.toLowerCase()], null)
          : this.csm(cadence, asOf, period, csm.emails.map((e) => e.toLowerCase()), csm.label);
      case 'implementation':
        return this.implementation(cadence, asOf, period);
      case 'support':
        return this.support(cadence, asOf, period);
    }
  }

  // ------------------------------------------------------------------ leadership

  private async executive(cadence: Cadence, asOf: IsoDate, period: { from: IsoDate; to: IsoDate }): Promise<ReportData> {
    const [portfolio, movement, openFlags, ledger] = await Promise.all([
      this.analytics.portfolio(asOf),
      this.analytics.period(period.from, period.to),
      this.flags.list({ status: 'open', limit: 1000 }),
      this.analytics.ledger(Number(asOf.slice(0, 4)), asOf),
    ]);
    const p = portfolio!;
    const urgentHigh = openFlags.filter((f) => f.severity === 'urgent' || f.severity === 'high');
    const escalated = openFlags.filter((f) => f.escalationLevel > 0);
    const sections: Section[] = [];

    sections.push({
      kind: 'kpis',
      items: [
        { label: 'Total ARR', value: formatNgn(p.totalArrKobo), note: `${p.customers} customers` },
        { label: 'ARR at risk', value: formatNgn(p.arrAtRiskKobo), note: `${pct(p.arrAtRiskPct)} of ARR is with At Risk customers`, tone: p.arrAtRiskKobo > 0n ? 'warn' : 'good' },
        { label: 'Urgent and high alerts open', value: String(urgentHigh.length), note: `${escalated.length} escalated`, tone: urgentHigh.length > 0 ? 'warn' : 'good' },
      ],
    });
    if (movement?.coverage.partial) {
      sections.push({ kind: 'notice', text: `Only part of ${fmtDate(period.from)} to ${fmtDate(period.to)} has data (compared ${fmtDate(movement.coverage.from)} with ${fmtDate(movement.coverage.to)}). Movement figures cover that span.` });
    }

    if (cadence === 'daily') {
      sections.push(this.alertTable('Alerts needing attention', urgentHigh.slice(0, 15)));
      sections.push(this.healthTable(p));
      return this.wrap('executive', cadence, 'Daily leadership report', asOf, period, sections);
    }

    if (movement) {
      const b = movement.bridge;
      sections.push({
        kind: 'bridge',
        heading: `ARR movement, ${fmtDate(movement.coverage.from)} to ${fmtDate(movement.coverage.to)}`,
        steps: [
          { label: 'ARR at start', value: formatNgn(b.startKobo), kobo: b.startKobo.toString(), type: 'start' },
          { label: `New customers (${b.newCount})`, value: `+${formatNgn(b.newKobo)}`, kobo: b.newKobo.toString(), type: 'up' },
          { label: `Expansion (${b.expansionCount})`, value: `+${formatNgn(b.expansionKobo)}`, kobo: b.expansionKobo.toString(), type: 'up' },
          { label: `Contractions, partial churn (${b.partialChurn.length})`, value: `-${formatNgn(b.partialChurnKobo)}`, kobo: b.partialChurnKobo.toString(), type: 'down' },
          { label: `Lost customers, full churn (${b.fullChurn.length})`, value: `-${formatNgn(b.fullChurnKobo)}`, kobo: b.fullChurnKobo.toString(), type: 'down' },
          { label: 'ARR at end', value: formatNgn(b.endKobo), kobo: b.endKobo.toString(), type: 'end' },
        ],
      });
      const lost = [...b.fullChurn.map((c) => ['Lost', c.name, formatNgn(c.lostKobo)]), ...b.partialChurn.map((c) => ['Contraction', c.name, formatNgn(c.lostKobo)])];
      if (lost.length > 0) sections.push({ kind: 'table', heading: 'Where ARR was lost', columns: ['Type', 'Customer', 'ARR lost'], rows: lost });
      sections.push(this.renewalKpis(movement));
      sections.push(this.expansionSection(movement));
    }
    sections.push(this.healthTable(p));
    sections.push(this.adoptionTable(p));
    sections.push({
      kind: 'kpis',
      heading: 'Contractor seats',
      items: [{ label: 'Contractor users', value: String(p.contractors.total), note: `across ${p.contractors.byParent.length} parent accounts` }],
    });
    if (p.contractors.byParent.length > 0) {
      sections.push({
        kind: 'table', heading: 'Contractor seats by parent account', columns: ['Parent account', 'Contractors', 'Sub-accounts'],
        rows: p.contractors.byParent.slice(0, 8).map((c) => [c.parentName, String(c.contractors), String(c.subAccounts)]),
      });
    }
    if (movement) sections.push(this.ticketTable(movement, 'Clients with the most support tickets'));
    sections.push(this.alertSummary(openFlags));
    if (ledger) {
      sections.push({
        kind: 'table',
        heading: `ARR by CSM since ${fmtDate(ledger.baselineDate)}`,
        columns: ['CSM', 'Baseline ARR', 'ARR now', 'Change', 'Change %'],
        rows: [
          ...ledger.rows.map((r) => [r.csmName ?? r.csmEmail, formatNgn(r.baselineKobo), formatNgn(r.currentKobo), signed(r.deltaKobo), pct(r.deltaPct)]),
          ['Total', formatNgn(ledger.totals.baselineKobo), formatNgn(ledger.totals.currentKobo), signed(ledger.totals.deltaKobo), pct(ledger.totals.deltaPct)],
        ],
      });
    }
    return this.wrap('executive', cadence, cadence === 'weekly' ? 'Weekly leadership report' : 'Monthly leadership report', asOf, period, sections);
  }

  // ------------------------------------------------------------------ CSM portfolio

  private async csm(cadence: Cadence, asOf: IsoDate, period: { from: IsoDate; to: IsoDate }, emails: string[], team: string | null): Promise<ReportData> {
    const set = new Set(emails);
    const [companies, allFlags, radar, ledger] = await Promise.all([
      this.snapshots.loadCompanies(asOf),
      this.flags.list({ status: 'open', limit: 1000 }),
      this.cx.radar(asOf),
      this.analytics.ledger(Number(asOf.slice(0, 4)), asOf),
    ]);
    const mine = companies.filter((c) => c.csmEmail !== null && set.has(c.csmEmail.toLowerCase()));
    const myFlags = allFlags.filter((f) => f.csmEmail !== null && set.has(f.csmEmail.toLowerCase()));
    const mineRows = (ledger?.rows ?? []).filter((r) => set.has(r.csmEmail));
    const row = mineRows.length === 0 ? undefined : { deltaKobo: mineRows.reduce((n, r) => n + r.deltaKobo, 0n), baselineKobo: mineRows.reduce((n, r) => n + r.baselineKobo, 0n) };
    const rowPct = row && row.baselineKobo > 0n ? Math.round(Number((row.deltaKobo * 10000n) / row.baselineKobo)) / 100 : null;
    const arr = mine.reduce((n, c) => n + (c.arrKobo ?? 0n), 0n);
    const atRisk = mine.filter((c) => c.healthStatus?.toLowerCase() === 'at risk');
    const sections: Section[] = [
      {
        kind: 'kpis',
        items: [
          { label: team ? 'Team ARR' : 'My ARR', value: formatNgn(arr), note: `${mine.length} accounts` },
          { label: 'At Risk accounts', value: String(atRisk.length), note: formatNgn(atRisk.reduce((n, c) => n + (c.arrKobo ?? 0n), 0n)), tone: atRisk.length > 0 ? 'warn' : 'good' },
          { label: 'Open alerts', value: String(myFlags.length), note: `${myFlags.filter((f) => f.severity === 'urgent' || f.severity === 'high').length} urgent or high`, tone: myFlags.length > 0 ? 'warn' : 'good' },
          ...(row ? [{ label: `Since ${fmtDate(ledger!.baselineDate)}`, value: signed(row.deltaKobo), note: `${pct(rowPct)} vs ${team ? 'start-of-year ARR' : 'your start-of-year ARR'}`, tone: row.deltaKobo >= 0n ? ('good' as const) : ('bad' as const) }] : []),
        ],
      },
      ...(team ? [this.teamTable(mine, myFlags, emails, asOf)] : []),
      this.alertTable(team ? 'Open alerts' : 'My open alerts', myFlags.slice(0, 20)),
    ];
    const upcoming = mine
      .filter((c) => c.contractEndDate && c.contractEndDate >= asOf && c.contractEndDate <= addDays(asOf, 60))
      .sort((a, b) => a.contractEndDate!.localeCompare(b.contractEndDate!));
    sections.push({
      kind: 'table', heading: 'Renewals in the next 60 days', columns: ['Customer', 'Contract ends', 'In', 'ARR'], empty: 'No contracts end in the next 60 days.',
      rows: upcoming.map((c) => [c.name, fmtDate(c.contractEndDate!), `${daysBetween(asOf, c.contractEndDate!)} days`, c.arrKobo === null ? 'n/a' : formatNgn(c.arrKobo)]),
    });
    const picks = (radar?.entries ?? []).filter((e) => e.csmEmail !== null && set.has(e.csmEmail.toLowerCase()));
    sections.push({
      kind: 'table', heading: 'Expansion opportunities', columns: ['Customer', 'Signals', 'Suggested conversation'], empty: 'No expansion signals on your accounts right now.',
      rows: picks.map((e) => [e.name, e.signals.map((s) => s.text).join('; '), e.signals[0]!.play]),
    });
    sections.push({
      kind: 'table', heading: 'My accounts', columns: team ? ['Customer', 'CSM', 'Health', 'ARR', 'Contract ends', 'Last contact'] : ['Customer', 'Health', 'ARR', 'Contract ends', 'Last contact'], empty: team ? 'No accounts are assigned to this team in HubSpot.' : 'No accounts are assigned to you in HubSpot.',
      rows: [...mine]
        .sort((a, b) => (HEALTH_RANK[a.healthStatus ?? ''] ?? 3) - (HEALTH_RANK[b.healthStatus ?? ''] ?? 3) || Number((b.arrKobo ?? 0n) - (a.arrKobo ?? 0n)))
        .map((c) => [c.name, ...(team ? [c.csmName ?? c.csmEmail ?? 'Unassigned'] : []), c.healthStatus ?? 'Not set', c.arrKobo === null ? 'n/a' : formatNgn(c.arrKobo), c.contractEndDate ? fmtDate(c.contractEndDate) : 'n/a', c.lastActivityDate ? fmtDate(c.lastActivityDate) : 'Never']),
    });
    const word = cadence === 'daily' ? 'Daily' : cadence === 'weekly' ? 'Weekly' : 'Monthly';
    if (team) return this.wrap('csm', cadence, `${word} team report`, asOf, period, sections, `For ${team}`);
    return this.wrap('csm', cadence, `${word} portfolio report`, asOf, period, sections, `For ${mine[0]?.csmName ?? emails[0]}`);
  }

  /** One row per CSM, so a team lead or director sees who is carrying what. */
  private teamTable(mine: Awaited<ReturnType<SnapshotRepository['loadCompanies']>>, flags: StoredFlag[], emails: string[], asOf: IsoDate): Section {
    const rows = emails
      .map((e) => {
        const cs = mine.filter((c) => c.csmEmail?.toLowerCase() === e);
        const fl = flags.filter((f) => f.csmEmail?.toLowerCase() === e);
        return { e, cs, fl };
      })
      .filter((r) => r.cs.length > 0 || r.fl.length > 0)
      .sort((a, b) => Number(b.cs.reduce((n, c) => n + (c.arrKobo ?? 0n), 0n) - a.cs.reduce((n, c) => n + (c.arrKobo ?? 0n), 0n)))
      .map(({ e, cs, fl }) => [
        cs[0]?.csmName ?? e,
        String(cs.length),
        formatNgn(cs.reduce((n, c) => n + (c.arrKobo ?? 0n), 0n)),
        String(cs.filter((c) => c.healthStatus?.toLowerCase() === 'at risk').length),
        String(cs.filter((c) => c.contractEndDate && c.contractEndDate >= asOf && c.contractEndDate <= addDays(asOf, 60)).length),
        String(fl.length),
      ]);
    return { kind: 'table', heading: 'By CSM', columns: ['CSM', 'Accounts', 'ARR', 'At Risk', 'Renewals in 60 days', 'Open alerts'], rows, empty: 'Nobody in this team has accounts yet.' };
  }

  // ------------------------------------------------------------------ implementation & onboarding

  private async implementation(cadence: Cadence, asOf: IsoDate, period: { from: IsoDate; to: IsoDate }): Promise<ReportData> {
    const [card, stalled] = await Promise.all([this.cx.scorecard(asOf), this.flags.list({ status: 'open', type: 'ONBOARDING_STAGNATION', limit: 100 })]);
    const sections: Section[] = [];
    if (card) {
      sections.push({
        kind: 'kpis',
        heading: `First ${card.windowDays} days`,
        items: [
          { label: 'Accounts onboarding', value: String(card.cohort), note: `signed up in the last ${card.windowDays} days` },
          { label: 'Time to first payroll', value: card.avgTtfvDays === null ? 'n/a' : `${card.avgTtfvDays} days`, note: card.medianTtfvDays === null ? undefined : `median ${card.medianTtfvDays} days` },
          { label: 'First payroll completed', value: pct(card.firstPayrollRatePct), note: `of accounts at least ${card.slaDays} days old`, tone: (card.firstPayrollRatePct ?? 100) < 80 ? 'warn' : 'good' },
          { label: 'Payroll set up', value: pct(card.configuredRatePct), note: 'of all accounts in the window' },
        ],
      });
    }
    sections.push({
      kind: 'table', heading: 'Stalled onboardings', columns: ['Customer', 'Days since sign-up', 'CSM', 'Next step'], empty: 'No account is past its onboarding deadline.',
      rows: await Promise.all(stalled.map(async (f) => {
        const pb = await this.cx.latestPlaybook(f.id);
        return [f.companyName, String(f.details.daysInOnboarding ?? ''), f.csmEmail ?? 'unassigned', pb?.content.steps[0]?.action ?? 'No playbook yet'];
      })),
    });
    if (card) {
      const label = { live: 'Live', configured: 'Payroll set up, no run yet', in_progress: 'In progress', stuck: 'Stalled' } as const;
      sections.push({
        kind: 'table', heading: 'Accounts in their first 90 days', columns: ['Customer', 'Signed up', 'Days', 'First payroll', 'Status'], empty: 'No accounts signed up in the window.',
        rows: card.rows.map((r) => [r.name, fmtDate(r.createdOn), String(r.daysSinceSignup), r.firstPayrollRunOn ? `${fmtDate(r.firstPayrollRunOn)} (${r.ttfvDays} days)` : 'Not yet', label[r.status]]),
      });
    }
    return this.wrap('implementation', cadence, 'Onboarding report', asOf, period, sections);
  }

  // ------------------------------------------------------------------ support

  private async support(cadence: Cadence, asOf: IsoDate, period: { from: IsoDate; to: IsoDate }): Promise<ReportData> {
    const [movement, risk, clusters, open] = await Promise.all([
      this.analytics.period(period.from, period.to),
      this.flags.list({ status: 'open', type: 'SUPPORT_ESCALATION_RISK', limit: 100 }),
      this.cx.latestClusters(),
      this.db.query<{ open: string; reopened: string; negative: string }>(
        `SELECT count(*) FILTER (WHERE NOT is_closed) AS open,
                count(*) FILTER (WHERE NOT is_closed AND reopen_count > 0) AS reopened,
                count(*) FILTER (WHERE NOT is_closed AND sentiment <= -1) AS negative FROM ticket`,
      ),
    ]);
    const o = open.rows[0]!;
    const sections: Section[] = [
      {
        kind: 'kpis',
        items: [
          { label: 'Tickets created', value: String(movement?.ticketsCreated ?? 0), note: `${fmtDate(period.from)} to ${fmtDate(period.to)}` },
          { label: 'Open now', value: o.open, note: `${o.reopened} reopened` },
          { label: 'Early warnings', value: String(risk.length), note: 'customers with at-risk tickets', tone: risk.length > 0 ? 'warn' : 'good' },
          ...(Number(o.negative) > 0 ? [{ label: 'Frustrated tone', value: o.negative, note: 'open tickets scored negative', tone: 'warn' as const }] : []),
        ],
      },
      this.alertTable('Support early warnings', risk),
    ];
    if (movement) sections.push(this.ticketTable(movement, 'Clients with the most tickets'));
    if (clusters) {
      sections.push({
        kind: 'list', heading: `Recurring themes (analysed ${fmtDate(clusters.content.period.from)} to ${fmtDate(clusters.content.period.to)})`,
        items: clusters.content.themes.map((t) => `${t.name}: ${t.ticketCount} tickets. ${t.suggestedFix}`), empty: 'No themes found.',
      });
    }
    return this.wrap('support', cadence, 'Support report', asOf, period, sections);
  }

  // ------------------------------------------------------------------ shared section builders

  private wrap(audience: Audience, cadence: Cadence, title: string, asOf: IsoDate, period: { from: IsoDate; to: IsoDate }, sections: Section[], prefix?: string): ReportData {
    const when = cadence === 'monthly' ? `${fmtDate(period.from)} to ${fmtDate(period.to)}` : `Data as of ${fmtDate(asOf)}`;
    return { audience, cadence, title, subtitle: prefix ? `${prefix} · ${when}` : when, asOf, period, sections };
  }

  private alertTable(heading: string, flags: StoredFlag[]): Section {
    return {
      kind: 'table', heading, columns: ['Level', 'Customer', 'Problem', 'State'], empty: 'Nothing needs attention.',
      rows: [...flags].sort((a, b) => SEV_RANK[a.severity]! - SEV_RANK[b.severity]!).map((f) => [f.severity, f.companyName, `${FLAG_TITLES[f.type]}: ${f.summary}`, flagState(f)]),
    };
  }

  private alertSummary(flags: StoredFlag[]): Section {
    const byType = new Map<string, { n: number; hot: number }>();
    for (const f of flags) {
      const e = byType.get(f.type) ?? { n: 0, hot: 0 };
      e.n += 1;
      if (f.severity === 'urgent' || f.severity === 'high') e.hot += 1;
      byType.set(f.type, e);
    }
    return {
      kind: 'table', heading: 'Open alerts by type', columns: ['Alert', 'Open', 'Urgent or high'], empty: 'No open alerts.',
      rows: [...byType.entries()].sort((a, b) => b[1].hot - a[1].hot || b[1].n - a[1].n).map(([t, e]) => [FLAG_TITLES[t as keyof typeof FLAG_TITLES], String(e.n), String(e.hot)]),
    };
  }

  private healthTable(p: Portfolio): Section {
    return {
      kind: 'table', heading: 'Customer health', columns: ['Health', 'Customers', 'Share', 'ARR'],
      rows: p.health.map((h) => [h.status, String(h.count), pct(h.pct), formatNgn(h.arrKobo)]),
    };
  }

  private adoptionTable(p: Portfolio): Section {
    const cell = (w: { users: number; ratePct: number | null }) => `${pct(w.ratePct)} (${w.users} of ${p.adoption.base})`;
    return {
      kind: 'table', heading: 'Module adoption: accounts that used it in the last…', columns: ['Module', '30 days', '90 days', '365 days'],
      rows: [
        ['Earned Wage Access', ...p.adoption.ewa.map(cell)],
        ['Statutory remittance', ...p.adoption.statutory.map(cell)],
      ],
    };
  }

  private renewalKpis(m: PeriodAnalytics): Section {
    const r = m.renewals;
    return {
      kind: 'kpis', heading: 'Retention and renewals',
      items: [
        { label: 'Full churn', value: String(m.bridge.fullChurn.length), note: formatNgn(m.bridge.fullChurnKobo), tone: m.bridge.fullChurn.length > 0 ? 'bad' : 'good' },
        { label: 'Partial churn', value: String(m.bridge.partialChurn.length), note: formatNgn(m.bridge.partialChurnKobo), tone: m.bridge.partialChurn.length > 0 ? 'warn' : 'good' },
        { label: 'Renewal rate', value: pct(r.renewalRatePct), note: `${r.renewed} of ${r.eligible} contracts due` },
        { label: 'Net renewal', value: pct(r.netRenewalPct), note: 'ARR kept from the contracts due' },
        { label: 'Average turnaround', value: r.avgTurnaroundDays === null ? 'n/a' : `${r.avgTurnaroundDays} days`, note: 'negative = renewed before expiry' },
      ],
    };
  }

  private expansionSection(m: PeriodAnalytics): Section {
    if (!m.expansionAvailable) {
      return { kind: 'notice', text: 'Expansion revenue is not available yet: the Control Panel revenue view (audit.v_revenue_lines) has not been connected.' };
    }
    const e = m.expansion;
    return {
      kind: 'kpis', heading: 'Expansion revenue',
      items: [
        { label: 'Upsell and cross-sell', value: formatNgn(e.totalKobo) },
        { label: 'From EWA and statutory remittance', value: formatNgn(e.monetizedKobo), note: `${pct(e.monetizedPct)} of expansion revenue` },
      ],
    };
  }

  private ticketTable(m: PeriodAnalytics, heading: string): Section {
    return {
      kind: 'table', heading, columns: ['Customer', 'Tickets'], empty: 'No tickets in this period.',
      rows: m.topTicketClients.slice(0, 8).map((c) => [c.name, String(c.count)]),
    };
  }
}

const signed = (k: bigint) => `${k >= 0n ? '+' : '-'}${formatNgn(k < 0n ? -k : k)}`;
