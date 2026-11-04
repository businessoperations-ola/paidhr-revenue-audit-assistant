import { Inject, Injectable, Logger } from '@nestjs/common';
import { logoUrl } from '../alerts/ack-link.js';
import { ALERT_SENDERS, type AlertSenders } from '../alerts/channels/channels.js';
import { buildRollups, rootMembers } from '../audits/hierarchy.js';
import { addDays, todayInLagos } from '../common/calendar.js';
import { formatNgn } from '../common/money.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { SnapshotRepository } from '../ingestion/snapshot.repository.js';
import { CONTROL_PANEL_SOURCE, HUBSPOT_SOURCE, type ControlPanelSource, type HubSpotSource } from '../sources/source.types.js';
import {
  BroadcastInput,
  BroadcastSchedule,
  broadcastEmailHtml,
  buildRecipients,
  nextRun,
  renderBroadcast,
  validateBroadcast,
  type AudienceCompany,
  type BroadcastAudience,
  type BroadcastChannel,
  type RecipientRow,
  type Rendered,
  type TokenValues,
} from './broadcast-core.js';

export interface Actor {
  email: string;
  role: string;
}

export class BroadcastError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 422 = 400) {
    super(message);
  }
}

export interface BroadcastRecord {
  id: number;
  name: string;
  subject: string;
  body: string;
  audience: BroadcastAudience;
  filters: BroadcastInput['filters'];
  channels: BroadcastChannel[];
  status: 'draft' | 'scheduled' | 'paused' | 'sent';
  schedule: BroadcastSchedule | null;
  nextRunAt: string | null;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  lastRun: RunRecord | null;
}

export interface RunRecord {
  id: number;
  broadcastId: number;
  trigger: 'manual' | 'schedule';
  status: 'running' | 'completed' | 'failed';
  live: boolean;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface Preview {
  /** Messages that would be sent, by channel. */
  counts: Record<string, number>;
  sendable: number;
  skipped: Array<{ company: string | null; recipient: string; channel: string; reason: string }>;
  samples: Array<{ channel: string; to: string; company: string | null; subject: string; text: string }>;
  warnings: string[];
  live: boolean;
  limit: number;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const STALE_MINUTES = 10;

/** Admin broadcasts: compose, preview, send now or on a schedule, with a full audit trail. */
@Injectable()
export class BroadcastService {
  private readonly log = new Logger(BroadcastService.name);
  private adminCache: { at: number; emails: Set<string> } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(SnapshotRepository) private readonly snapshots: SnapshotRepository,
    @Inject(HUBSPOT_SOURCE) private readonly hubspot: HubSpotSource,
    @Inject(CONTROL_PANEL_SOURCE) private readonly controlPanel: ControlPanelSource,
    @Inject(ALERT_SENDERS) private readonly senders: AlertSenders,
  ) {}

  // ------------------------------------------------------------------ access (US-20)

  /** Only super admins and Heads of CX, and optionally only people who are also Control Panel admins. */
  async access(user: Actor): Promise<{ allowed: boolean; reason: string | null; canSendToClients: boolean; live: boolean }> {
    const live = this.cfg.BROADCASTS_LIVE;
    if (user.role !== 'super_admin' && user.role !== 'cs_director') {
      return { allowed: false, reason: 'Broadcasts are limited to super admins and Heads of CX.', canSendToClients: false, live };
    }
    if (this.cfg.BROADCAST_REQUIRE_CP_ADMIN && !(await this.isControlPanelAdmin(user.email))) {
      return { allowed: false, reason: 'Your account is not an admin in the Control Panel.', canSendToClients: false, live };
    }
    return { allowed: true, reason: null, canSendToClients: user.role === 'super_admin', live };
  }

  private async isControlPanelAdmin(email: string): Promise<boolean> {
    if (!this.adminCache || Date.now() - this.adminCache.at > 60_000) {
      this.adminCache = { at: Date.now(), emails: new Set((await this.controlPanel.fetchAdminEmails()).map((e) => e.toLowerCase())) };
    }
    return this.adminCache.emails.has(email.toLowerCase());
  }

  private async requireAccess(user: Actor, audience?: BroadcastAudience): Promise<void> {
    const a = await this.access(user);
    if (!a.allowed) throw new BroadcastError(a.reason ?? 'Not allowed', 403);
    if (audience === 'clients' && !a.canSendToClients) throw new BroadcastError('Only super admins can write to clients.', 403);
  }

  // ------------------------------------------------------------------ drafts

  async list(user: Actor): Promise<BroadcastRecord[]> {
    await this.requireAccess(user);
    const { rows } = await this.db.query('SELECT * FROM broadcast ORDER BY updated_at DESC LIMIT 200');
    return Promise.all(rows.map((r) => this.toRecord(r)));
  }

  async get(id: number, user: Actor): Promise<BroadcastRecord> {
    await this.requireAccess(user);
    return this.toRecord(await this.load(id));
  }

  async create(raw: unknown, user: Actor): Promise<BroadcastRecord> {
    const input = this.parse(raw);
    await this.requireAccess(user, input.audience);
    const { rows } = await this.db.query(
      `INSERT INTO broadcast (name, subject, body, audience, filters, channels, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [input.name, input.subject, input.body, input.audience, JSON.stringify(input.filters), input.channels, user.email],
    );
    await this.audit(user, 'broadcast.create', rows[0]!.id, { name: input.name, audience: input.audience });
    return this.toRecord(rows[0]!);
  }

  async update(id: number, raw: unknown, user: Actor): Promise<BroadcastRecord> {
    const input = this.parse(raw);
    const current = await this.load(id);
    await this.requireAccess(user, current.audience);
    await this.requireAccess(user, input.audience);
    if (current.status === 'sent') throw new BroadcastError('A broadcast that has been sent cannot be edited. Duplicate it instead.', 409);
    const { rows } = await this.db.query(
      `UPDATE broadcast SET name = $2, subject = $3, body = $4, audience = $5, filters = $6, channels = $7, updated_by = $8, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, input.name, input.subject, input.body, input.audience, JSON.stringify(input.filters), input.channels, user.email],
    );
    await this.audit(user, 'broadcast.update', id, { name: input.name, previousSubject: current.subject, previousBodyLength: String(current.body).length });
    return this.toRecord(rows[0]!);
  }

  private parse(raw: unknown): BroadcastInput {
    const parsed = BroadcastInput.safeParse(raw);
    if (!parsed.success) throw new BroadcastError(parsed.error.issues.map((i) => `${i.path.join('.') || 'broadcast'}: ${i.message}`).join('; '), 422);
    const problem = validateBroadcast(parsed.data);
    if (problem) throw new BroadcastError(problem, 422);
    return parsed.data;
  }

  // ------------------------------------------------------------------ preview (US-21)

  /** What would be sent, without sending or saving anything. */
  async preview(raw: unknown, user: Actor): Promise<Preview> {
    const input = this.parse(raw);
    await this.requireAccess(user, input.audience);
    const { sendable, skipped, rows } = await this.resolve(input);
    const counts: Record<string, number> = {};
    for (const r of sendable) counts[r.row.channel] = (counts[r.row.channel] ?? 0) + 1;
    const warnings: string[] = [];
    if (sendable.length > this.cfg.BROADCAST_MAX_RECIPIENTS) warnings.push(`This would send ${sendable.length} messages; the limit is ${this.cfg.BROADCAST_MAX_RECIPIENTS}. Narrow the audience.`);
    if (skipped.length > 0) warnings.push(`${skipped.length} ${skipped.length === 1 ? 'message cannot' : 'messages cannot'} be sent; see the list below.`);
    if (rows.length === 0) warnings.push('Nobody matches these filters.');
    if (!this.cfg.BROADCASTS_LIVE) warnings.push('Broadcasts are in dry-run mode: sending records what would be sent but delivers nothing.');
    const seen = new Set<string>();
    const samples = sendable.filter((s) => (seen.has(s.row.channel) ? false : (seen.add(s.row.channel), true)) || seen.size < 4).slice(0, 4).map((s) => ({
      channel: s.row.channel, to: s.row.recipient, company: s.row.company?.name ?? null, subject: s.rendered.subject, text: s.row.channel === 'google_chat' ? s.rendered.chat : s.rendered.text,
    }));
    return { counts, sendable: sendable.length, skipped, samples, warnings, live: this.cfg.BROADCASTS_LIVE, limit: this.cfg.BROADCAST_MAX_RECIPIENTS };
  }

  // ------------------------------------------------------------------ send now (US-21)

  /**
   * Starts a send and returns at once; the UI follows its progress. `confirmCount` must equal the
   * number of messages the preview showed, so a send can never be larger than the person approved.
   */
  async send(id: number, confirmCount: number, user: Actor): Promise<RunRecord> {
    const b = await this.load(id);
    await this.requireAccess(user, b.audience);
    if (b.status === 'sent') throw new BroadcastError('This broadcast has already been sent. Duplicate it to send it again.', 409);
    const input = this.parse({ name: b.name, subject: b.subject, body: b.body, audience: b.audience, filters: b.filters, channels: b.channels });
    const { sendable } = await this.resolve(input);
    if (sendable.length === 0) throw new BroadcastError('There is nobody to send this to.', 409);
    if (sendable.length !== confirmCount) throw new BroadcastError(`The audience changed: this would now send ${sendable.length} messages, not ${confirmCount}. Review the preview again.`, 409);
    const run = await this.startRun(id, 'manual', user.email, confirmCount);
    await this.audit(user, 'broadcast.send', id, { runId: run.id, messages: sendable.length, live: run.live });
    void this.processRun(run.id).catch((err) => this.log.error(`Run ${run.id} failed: ${err instanceof Error ? err.message : err}`));
    return run;
  }

  // ------------------------------------------------------------------ schedule (US-22)

  async schedule(id: number, rawSchedule: unknown, user: Actor): Promise<BroadcastRecord> {
    const b = await this.load(id);
    await this.requireAccess(user, b.audience);
    const parsed = BroadcastSchedule.safeParse(rawSchedule);
    if (!parsed.success) throw new BroadcastError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
    const next = nextRun(parsed.data, new Date());
    if (!next) throw new BroadcastError('That time has already passed.', 422);
    const { rows } = await this.db.query(
      `UPDATE broadcast SET schedule = $2, next_run_at = $3, status = 'scheduled', updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(parsed.data), next, user.email],
    );
    await this.audit(user, 'broadcast.schedule', id, { schedule: parsed.data, nextRunAt: next.toISOString() });
    return this.toRecord(rows[0]!);
  }

  async pause(id: number, user: Actor): Promise<BroadcastRecord> {
    const b = await this.load(id);
    await this.requireAccess(user, b.audience);
    if (b.status !== 'scheduled') throw new BroadcastError('Only a scheduled broadcast can be paused.', 409);
    const { rows } = await this.db.query(`UPDATE broadcast SET status = 'paused', next_run_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, user.email]);
    await this.audit(user, 'broadcast.pause', id, {});
    return this.toRecord(rows[0]!);
  }

  /** The `broadcasts` job: continue interrupted runs, then start every schedule that is due. */
  async runDue(): Promise<{ started: number; resumed: number }> {
    const resumed = await this.recoverStale();
    const due = await this.db.transaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM broadcast WHERE status = 'scheduled' AND next_run_at <= now() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 20`);
      const started: Array<{ id: number }> = [];
      for (const b of rows) {
        const schedule = BroadcastSchedule.parse(b.schedule);
        const next = nextRun(schedule, new Date());
        // Advance first, in the same transaction, so a crash can never send the same slot twice.
        await client.query(`UPDATE broadcast SET next_run_at = $2, status = $3 WHERE id = $1`, [b.id, next, next ? 'scheduled' : 'sent']);
        started.push({ id: Number(b.id) });
      }
      return started;
    });
    for (const { id } of due) {
      try {
        const run = await this.startRun(id, 'schedule', 'scheduler');
        await this.processRun(run.id);
      } catch (err) {
        this.log.error(`Scheduled broadcast ${id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { started: due.length, resumed };
  }

  // ------------------------------------------------------------------ runs

  async runs(id: number, user: Actor): Promise<RunRecord[]> {
    await this.requireAccess(user);
    const { rows } = await this.db.query('SELECT * FROM broadcast_run WHERE broadcast_id = $1 ORDER BY id DESC LIMIT 20', [id]);
    return rows.map(toRun);
  }

  async run(runId: number, user: Actor) {
    await this.requireAccess(user);
    const { rows } = await this.db.query('SELECT * FROM broadcast_run WHERE id = $1', [runId]);
    if (!rows[0]) throw new BroadcastError('Run not found', 404);
    const recipients = await this.db.query(
      `SELECT id, company_name, recipient, channel, status, error, sent_at FROM broadcast_recipient WHERE run_id = $1 ORDER BY id LIMIT 500`,
      [runId],
    );
    return {
      ...toRun(rows[0]),
      recipients: recipients.rows.map((r) => ({
        id: Number(r.id), company: r.company_name, recipient: r.recipient, channel: r.channel, status: r.status, error: r.error, sentAt: r.sent_at ? iso(r.sent_at) : null,
      })),
    };
  }

  // ------------------------------------------------------------------ resolving and sending

  private async resolve(input: BroadcastInput): Promise<{
    rows: RecipientRow[];
    sendable: Array<{ row: RecipientRow; rendered: Rendered }>;
    skipped: Preview['skipped'];
  }> {
    const [companies, users] = await Promise.all([this.audienceCompanies(), this.users()]);
    const rows = buildRecipients(input.audience, input.channels, companies, users, input.filters);
    const sendable: Array<{ row: RecipientRow; rendered: Rendered }> = [];
    const skipped: Preview['skipped'] = [];
    for (const row of rows) {
      if (row.skipReason) {
        skipped.push({ company: row.company?.name ?? null, recipient: row.recipient, channel: row.channel, reason: row.skipReason });
        continue;
      }
      const r = renderBroadcast(input, row.company ? tokenValues(row.company) : {});
      if (!r.rendered) {
        skipped.push({ company: row.company?.name ?? null, recipient: row.recipient, channel: row.channel, reason: `Missing ${r.missing.map((t) => `{{${t}}}`).join(', ')} for this customer` });
        continue;
      }
      sendable.push({ row, rendered: r.rendered });
    }
    return { rows, sendable, skipped };
  }

  private async audienceCompanies(): Promise<AudienceCompany[]> {
    const asOf = await this.snapshots.latestSnapshotDate(todayInLagos());
    if (!asOf) return [];
    const [companies, accounts] = await Promise.all([this.snapshots.loadCompanies(asOf), this.snapshots.loadAccounts(asOf)]);
    const rollups = buildRollups(accounts);
    const members = rootMembers(accounts);
    const cutoff = addDays(asOf, -90);
    const used = (group: Array<{ ewaLastUsedOn: string | null; statutoryLastUsedOn: string | null }> | undefined, pick: 'ewaLastUsedOn' | 'statutoryLastUsedOn') =>
      (group ?? []).some((a) => a[pick] !== null && a[pick]! >= cutoff);
    return companies.map((c) => ({
      hubspotId: c.hubspotId, name: c.name, csmName: c.csmName, csmEmail: c.csmEmail, csmOwnerId: c.csmOwnerId, arrKobo: c.arrKobo,
      healthStatus: c.healthStatus, activeSeats: c.controlPanelId ? (rollups.get(c.controlPanelId)?.totalActiveUsers ?? null) : null,
      contractEndDate: c.contractEndDate, primaryContactEmail: c.primaryContactEmail,
      usesEwa: used(c.controlPanelId ? members.get(c.controlPanelId) : undefined, 'ewaLastUsedOn'),
      usesStatutory: used(c.controlPanelId ? members.get(c.controlPanelId) : undefined, 'statutoryLastUsedOn'),
    }));
  }

  private async users(): Promise<Array<{ email: string; role: string }>> {
    return (await this.db.query<{ email: string; role: string }>('SELECT email, role FROM app_user WHERE active ORDER BY email')).rows;
  }

  private async startRun(broadcastId: number, trigger: 'manual' | 'schedule', startedBy: string, expectedSendable?: number): Promise<RunRecord> {
    const b = await this.load(broadcastId);
    const input = this.parse({ name: b.name, subject: b.subject, body: b.body, audience: b.audience, filters: b.filters, channels: b.channels });
    const { sendable, skipped } = await this.resolve(input);
    if (expectedSendable !== undefined && sendable.length !== expectedSendable) {
      throw new BroadcastError(`The audience changed: this would now send ${sendable.length} messages, not ${expectedSendable}. Review the preview again.`, 409);
    }
    if (sendable.length > this.cfg.BROADCAST_MAX_RECIPIENTS) {
      throw new BroadcastError(`This would send ${sendable.length} messages; the limit is ${this.cfg.BROADCAST_MAX_RECIPIENTS}.`, 409);
    }
    const live = this.cfg.BROADCASTS_LIVE;
    return this.db.transaction(async (client) => {
      // One run at a time per broadcast.
      await client.query('SELECT pg_advisory_xact_lock($1)', [broadcastId]);
      const running = await client.query(`SELECT 1 FROM broadcast_run WHERE broadcast_id = $1 AND status = 'running'`, [broadcastId]);
      if (running.rowCount) throw new BroadcastError('This broadcast is already sending.', 409);
      const { rows } = await client.query(
        `INSERT INTO broadcast_run (broadcast_id, trigger, status, live, total, skipped, started_by)
         VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING *`,
        [broadcastId, trigger, live, sendable.length + skipped.length, skipped.length, startedBy],
      );
      const runId = Number(rows[0].id);
      const records = [
        ...sendable.map((s) => ({ company_id: s.row.company?.hubspotId ?? null, company_name: s.row.company?.name ?? null, recipient: s.row.recipient, channel: s.row.channel, status: live ? 'pending' : 'dry_run', rendered_subject: s.rendered.subject, rendered_body: s.row.channel === 'google_chat' ? s.rendered.chat : s.rendered.text, rendered_html: s.row.channel === 'email' ? s.rendered.html : null, error: null })),
        ...skipped.map((s) => ({ company_id: null, company_name: s.company, recipient: s.recipient, channel: s.channel, status: 'skipped', rendered_subject: null, rendered_body: null, rendered_html: null, error: s.reason })),
      ];
      if (records.length > 0) {
        await client.query(
          `INSERT INTO broadcast_recipient (run_id, hubspot_company_id, company_name, recipient, channel, status, rendered_subject, rendered_body, rendered_html, error)
           SELECT $1, company_id, company_name, recipient, channel, status, rendered_subject, rendered_body, rendered_html, error
             FROM jsonb_to_recordset($2::jsonb) AS x(company_id text, company_name text, recipient text, channel text, status text, rendered_subject text, rendered_body text, rendered_html text, error text)
           ON CONFLICT DO NOTHING`,
          [runId, JSON.stringify(records)],
        );
      }
      if (!live) {
        // A dry run delivers nothing: it records what would have been sent, and finishes at once.
        const done = await client.query(`UPDATE broadcast_run SET status = 'completed', finished_at = now() WHERE id = $1 RETURNING *`, [runId]);
        await this.markSentIfOnce(client, broadcastId, trigger);
        return toRun(done.rows[0]);
      }
      return toRun(rows[0]);
    });
  }

  /** Sends every pending row of a run. Safe to call again: each row is claimed once, so nothing is sent twice. */
  async processRun(runId: number): Promise<void> {
    const { rows } = await this.db.query('SELECT r.*, b.name, b.audience FROM broadcast_run r JOIN broadcast b ON b.id = r.broadcast_id WHERE r.id = $1', [runId]);
    const run = rows[0];
    if (!run || run.status !== 'running') return;
    const notedCompanies = new Set<string>();
    for (;;) {
      const claimed = await this.db.query(
        `UPDATE broadcast_recipient SET status = 'sending', updated_at = now()
          WHERE id = (SELECT id FROM broadcast_recipient WHERE run_id = $1 AND status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [runId],
      );
      const row = claimed.rows[0];
      if (!row) break;
      let status: 'sent' | 'failed' | 'skipped' = 'sent';
      let ref: string | null = null;
      let error: string | null = null;
      try {
        ref = await this.deliver(row, run.audience, run.name, notedCompanies);
        if (ref === null) {
          status = 'skipped';
          error = 'No destination is set up for this channel';
        }
      } catch (err) {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
      }
      await this.db.query(`UPDATE broadcast_recipient SET status = $2, external_ref = $3, error = $4, updated_at = now(), sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`, [row.id, status, ref, error]);
      await this.refreshCounts(runId);
      if (this.cfg.BROADCAST_SEND_DELAY_MS > 0) await new Promise((r) => setTimeout(r, this.cfg.BROADCAST_SEND_DELAY_MS));
    }
    await this.finishIfDone(runId, run.broadcast_id, run.trigger);
  }

  private async deliver(row: Record<string, any>, audience: BroadcastAudience, broadcastName: string, notedCompanies: Set<string>): Promise<string | null> {
    const channel = row.channel as BroadcastChannel;
    if (channel === 'email') {
      const footer = audience === 'clients' ? 'You are receiving this message because your company is a PaidHR customer.' : 'Sent by the PaidHR Customer Experience team.';
      const html = broadcastEmailHtml({ subject: row.rendered_subject, bodyHtml: row.rendered_html ?? htmlFromText(row.rendered_body), logoUrl: logoUrl(this.cfg.APP_BASE_URL), footer });
      const ref = await this.senders.email.send({ to: [row.recipient], subject: row.rendered_subject, text: row.rendered_body, html });
      if (audience === 'clients' && row.hubspot_company_id && !notedCompanies.has(row.hubspot_company_id)) {
        notedCompanies.add(row.hubspot_company_id);
        // US-23: a copy goes on the customer's HubSpot activity feed. A logging failure does not undo the send.
        await this.hubspot
          .createNote({ companyId: row.hubspot_company_id, body: `Broadcast "${broadcastName}" sent to ${row.recipient}\n\nSubject: ${row.rendered_subject}\n\n${row.rendered_body}`, at: new Date() })
          .catch((err) => this.log.warn(`CRM note failed for company ${row.hubspot_company_id}: ${err instanceof Error ? err.message : err}`));
      }
      return ref;
    }
    if (channel === 'google_chat') {
      if (!this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK) return null;
      return this.senders.chat.send(this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK, `*${row.rendered_subject}*\n${row.rendered_body}`);
    }
    if (!row.hubspot_company_id) return null;
    const owner = (await this.db.query<{ csm_owner_id: string | null }>(
      'SELECT csm_owner_id FROM hs_company_snapshot WHERE hubspot_id = $1 ORDER BY snapshot_date DESC LIMIT 1',
      [row.hubspot_company_id],
    )).rows[0]?.csm_owner_id ?? null;
    return this.senders.task.create({
      companyId: row.hubspot_company_id, ownerId: owner, subject: row.rendered_subject, body: row.rendered_body,
      priority: 'MEDIUM', dueAt: new Date(`${addDays(todayInLagos(), 2)}T17:00:00+01:00`),
    });
  }

  private async refreshCounts(runId: number): Promise<void> {
    await this.db.query(
      `UPDATE broadcast_run SET
         sent = (SELECT count(*) FROM broadcast_recipient WHERE run_id = $1 AND status = 'sent'),
         failed = (SELECT count(*) FROM broadcast_recipient WHERE run_id = $1 AND status = 'failed'),
         skipped = (SELECT count(*) FROM broadcast_recipient WHERE run_id = $1 AND status = 'skipped')
       WHERE id = $1`,
      [runId],
    );
  }

  private async finishIfDone(runId: number, broadcastId: number, trigger: 'manual' | 'schedule'): Promise<void> {
    await this.refreshCounts(runId);
    const open = await this.db.query(`SELECT 1 FROM broadcast_recipient WHERE run_id = $1 AND status IN ('pending', 'sending') LIMIT 1`, [runId]);
    if (open.rowCount) return;
    await this.db.transaction(async (client) => {
      await client.query(`UPDATE broadcast_run SET status = 'completed', finished_at = now() WHERE id = $1 AND status = 'running'`, [runId]);
      await this.markSentIfOnce(client, broadcastId, trigger);
    });
  }

  /** A manual send of a draft marks it as sent; a recurring broadcast stays scheduled. */
  private async markSentIfOnce(client: { query: (q: string, p?: unknown[]) => Promise<unknown> }, broadcastId: number, trigger: string): Promise<void> {
    if (trigger === 'manual') await client.query(`UPDATE broadcast SET status = 'sent' WHERE id = $1 AND status = 'draft'`, [broadcastId]);
  }

  /** After a crash: rows stuck mid-send are failed (never retried, so a client cannot get two copies), the rest continue. */
  private async recoverStale(): Promise<number> {
    const stale = await this.db.query(
      `SELECT DISTINCT r.id FROM broadcast_run r JOIN broadcast_recipient p ON p.run_id = r.id
        WHERE r.status = 'running' AND r.live AND p.status IN ('pending', 'sending') AND p.updated_at < now() - make_interval(mins => $1)`,
      [STALE_MINUTES],
    );
    for (const { id } of stale.rows) {
      await this.db.query(
        `UPDATE broadcast_recipient SET status = 'failed', error = 'Interrupted while sending; not retried to avoid sending twice', updated_at = now()
          WHERE run_id = $1 AND status = 'sending' AND updated_at < now() - make_interval(mins => $2)`,
        [id, STALE_MINUTES],
      );
      await this.processRun(Number(id));
    }
    return stale.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: number): Promise<Record<string, any>> {
    const { rows } = await this.db.query('SELECT * FROM broadcast WHERE id = $1', [id]);
    if (!rows[0]) throw new BroadcastError('Broadcast not found', 404);
    return rows[0];
  }

  private async toRecord(r: Record<string, any>): Promise<BroadcastRecord> {
    const last = await this.db.query('SELECT * FROM broadcast_run WHERE broadcast_id = $1 ORDER BY id DESC LIMIT 1', [r.id]);
    return {
      id: Number(r.id), name: r.name, subject: r.subject, body: r.body, audience: r.audience, filters: r.filters, channels: r.channels,
      status: r.status, schedule: r.schedule, nextRunAt: r.next_run_at ? iso(r.next_run_at) : null, createdBy: r.created_by, updatedBy: r.updated_by,
      updatedAt: iso(r.updated_at), lastRun: last.rows[0] ? toRun(last.rows[0]) : null,
    };
  }

  private audit(user: Actor, action: string, id: number | string, details: Record<string, unknown>) {
    return this.db.query(`INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, $2, 'broadcast', $3, $4)`, [user.email, action, String(id), JSON.stringify(details)]);
  }
}

function toRun(r: Record<string, any>): RunRecord {
  return {
    id: Number(r.id), broadcastId: Number(r.broadcast_id), trigger: r.trigger, status: r.status, live: r.live, total: r.total, sent: r.sent,
    failed: r.failed, skipped: r.skipped, startedBy: r.started_by, startedAt: iso(r.started_at), finishedAt: r.finished_at ? iso(r.finished_at) : null, error: r.error,
  };
}

function tokenValues(c: AudienceCompany): TokenValues {
  return {
    company_name: c.name,
    csm_name: c.csmName,
    arr_ngn: c.arrKobo === null ? null : formatNgn(c.arrKobo),
    active_seats: c.activeSeats === null ? null : String(c.activeSeats),
    health_status: c.healthStatus,
    contract_end_date: c.contractEndDate ? new Date(`${c.contractEndDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null,
  };
}

/** Stored rows keep the plain-text rendering; the HTML email is rebuilt from it with line breaks kept. */
function htmlFromText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#0B1A3C">${p.split('\n').map((l) => l.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)).join('<br>')}</p>`)
    .join('');
}
