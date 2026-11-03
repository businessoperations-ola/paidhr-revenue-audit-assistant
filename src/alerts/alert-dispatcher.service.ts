import { Inject, Injectable, Logger } from '@nestjs/common';
import { RATIONALE_GENERATOR, RATIONALE_TYPES, type RationaleGenerator } from '../ai/rationale.service.js';
import { FlagRepository, type StoredFlag } from '../audits/flag.repository.js';
import { addDays, todayInLagos } from '../common/calendar.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { hubspotPriority } from '../sources/source.types.js';
import { ackUrl, logoUrl } from './ack-link.js';
import { ALERT_SENDERS, type AlertSenders, type ChannelName } from './channels/channels.js';
import { RulesRepository } from '../audits/rules.repository.js';
import { chatMessage, emailBody, emailSubject, escalationNote, taskBody, taskSubject } from './message-format.js';

export const MAX_ATTEMPTS = 3;
const CHAT_SPACE = 'space:default';

interface Delivery {
  flagId: number;
  channel: ChannelName;
  recipient: string;
}

export interface DispatchResult {
  flagsConsidered: number;
  sent: number;
  failed: number;
  skipped: number;
  rationalesWritten: number;
  dryRun: boolean;
}

/**
 * US-15: route every open, undelivered flag to its CSM.
 * - Urgent flags (late payroll) go out one by one, on every channel.
 * - Everything else is grouped into one chat message and one email per CSM.
 * - Every flag tied to a HubSpot company gets a follow-up task assigned to the CSM.
 * Flags with no CSM go to FALLBACK_ALERT_EMAILS and the default chat space.
 */
@Injectable()
export class AlertDispatcher {
  private readonly log = new Logger(AlertDispatcher.name);
  private readonly channels: ChannelName[];

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(ALERT_SENDERS) private readonly senders: AlertSenders,
    @Inject(RATIONALE_GENERATOR) private readonly rationale: RationaleGenerator,
    @Inject(RulesRepository) private readonly rules: RulesRepository,
  ) {
    this.channels = cfg.ALERT_CHANNELS.filter((c): c is ChannelName =>
      ['google_chat', 'email', 'hubspot_task'].includes(c),
    );
  }

  async dispatch(): Promise<DispatchResult> {
    const pending = await this.flags.listUndelivered(this.channels, MAX_ATTEMPTS);
    const result: DispatchResult = {
      flagsConsidered: pending.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      rationalesWritten: 0,
      dryRun: this.cfg.ALERTS_DRY_RUN,
    };
    if (pending.length === 0) return result;

    result.rationalesWritten = await this.addRationales(pending);
    const rules = await this.rules.load();
    const escalate = { severities: rules.escalate_severities, businessDays: rules.escalation_business_days };
    const done = await this.completedDeliveries(pending.map((f) => f.id));
    const isDone = (d: Delivery) => done.has(`${d.flagId}|${d.channel}|${d.recipient}`);
    const ack = (id: number) => ackUrl(this.cfg.APP_BASE_URL, this.cfg.ACK_LINK_SECRET, id);

    // Group by CSM; urgent flags each get their own group.
    const groups: Array<{ csm: string | null; flags: StoredFlag[] }> = [];
    const byCsm = new Map<string, StoredFlag[]>();
    for (const f of pending) {
      if (f.severity === 'urgent') groups.push({ csm: f.csmEmail, flags: [f] });
      else {
        const key = f.csmEmail ?? '';
        byCsm.set(key, [...(byCsm.get(key) ?? []), f]);
      }
    }
    for (const [csm, flags] of byCsm) groups.push({ csm: csm || null, flags });

    for (const group of groups) {
      if (this.channels.includes('google_chat')) {
        await this.deliverGroup(result, group.flags, 'google_chat', CHAT_SPACE, isDone, async (flags) => {
          if (!this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK) return null;
          return this.senders.chat.send(this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK, chatMessage(group.csm, flags, ack));
        });
      }
      if (this.channels.includes('email')) {
        const to = group.csm ? [group.csm] : this.cfg.FALLBACK_ALERT_EMAILS;
        const recipient = to.join(',') || 'none';
        await this.deliverGroup(result, group.flags, 'email', recipient, isDone, async (flags) => {
          if (to.length === 0) return null;
          const body = emailBody(group.csm, flags, ack, escalationNote(flags, escalate), logoUrl(this.cfg.APP_BASE_URL));
          return this.senders.email.send({ to, subject: emailSubject(flags), ...body });
        });
      }
    }

    if (this.channels.includes('hubspot_task')) {
      const owners = await this.ownerIds(pending.map((f) => f.hubspotCompanyId).filter((x): x is string => !!x));
      for (const f of pending) {
        const ownerId = f.hubspotCompanyId ? (owners.get(f.hubspotCompanyId) ?? null) : null;
        const recipient = ownerId ?? 'unassigned';
        await this.deliverGroup(result, [f], 'hubspot_task', recipient, isDone, async () => {
          if (!f.hubspotCompanyId) return null; // Control-Panel-only flags have no company to attach to.
          return this.senders.task.create({
            companyId: f.hubspotCompanyId,
            ownerId,
            subject: taskSubject(f),
            body: taskBody(f, ack),
            priority: hubspotPriority(f.severity),
            // Urgent: due today. Others: due in 3 days.
            dueAt: new Date(`${f.severity === 'urgent' ? todayInLagos() : addDays(todayInLagos(), 3)}T17:00:00+01:00`),
          });
        });
      }
    }

    this.log.log(
      `Dispatch: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped across ${pending.length} flags` +
        (result.dryRun ? ' (dry run, nothing sent)' : ''),
    );
    return result;
  }

  /**
   * Send one message covering `flags` on one channel, then record an alert row
   * per flag. `send` returning null means "nothing to send to" (skipped).
   */
  private async deliverGroup(
    result: DispatchResult,
    allFlags: StoredFlag[],
    channel: ChannelName,
    recipient: string,
    isDone: (d: Delivery) => boolean,
    send: (flags: StoredFlag[]) => Promise<string | null>,
  ): Promise<void> {
    const flags = allFlags.filter((f) => !isDone({ flagId: f.id, channel, recipient }));
    if (flags.length === 0) return;

    if (this.cfg.ALERTS_DRY_RUN) {
      this.log.log(`[dry run] ${channel} → ${recipient}: ${flags.map((f) => `#${f.id}`).join(', ')}`);
      return;
    }

    let status: 'sent' | 'failed' | 'skipped';
    let externalRef: string | null = null;
    let error: string | null = null;
    try {
      externalRef = await send(flags);
      status = externalRef === null ? 'skipped' : 'sent';
      if (status === 'skipped') error = 'No destination configured for this recipient';
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      this.log.warn(`${channel} → ${recipient} failed: ${error}`);
    }

    for (const f of flags) {
      await this.db.query(
        `INSERT INTO alert (flag_id, channel, recipient, kind, status, attempts, external_ref, error, sent_at)
         VALUES ($1, $2, $3, 'notify', $4, 1, $5, $6, CASE WHEN $4 = 'sent' THEN now() END)
         ON CONFLICT (flag_id, channel, recipient, kind) DO UPDATE
           SET status = EXCLUDED.status, attempts = alert.attempts + 1, external_ref = EXCLUDED.external_ref,
               error = EXCLUDED.error, sent_at = EXCLUDED.sent_at`,
        [f.id, channel, recipient, status, externalRef, error],
      );
      if (status === 'sent') {
        // The escalation clock (US-16) starts at the first successful delivery.
        await this.db.query('UPDATE audit_flag SET notified_at = coalesce(notified_at, now()) WHERE id = $1', [f.id]);
      }
      result[status] += 1;
    }
  }

  /** (flag, channel, recipient) combinations already sent, skipped, or out of retries. */
  private async completedDeliveries(flagIds: number[]): Promise<Set<string>> {
    const { rows } = await this.db.query<{ flag_id: string; channel: string; recipient: string }>(
      `SELECT flag_id, channel, recipient FROM alert
        WHERE flag_id = ANY($1) AND kind = 'notify' AND (status IN ('sent', 'skipped') OR attempts >= $2)`,
      [flagIds, MAX_ATTEMPTS],
    );
    return new Set(rows.map((r) => `${r.flag_id}|${r.channel}|${r.recipient}`));
  }

  private async ownerIds(companyIds: string[]): Promise<Map<string, string>> {
    if (companyIds.length === 0) return new Map();
    const { rows } = await this.db.query<{ hubspot_id: string; csm_owner_id: string | null }>(
      `SELECT DISTINCT ON (hubspot_id) hubspot_id, csm_owner_id
         FROM hs_company_snapshot WHERE hubspot_id = ANY($1)
        ORDER BY hubspot_id, snapshot_date DESC`,
      [companyIds],
    );
    return new Map(rows.filter((r) => r.csm_owner_id).map((r) => [r.hubspot_id, r.csm_owner_id!]));
  }

  private async addRationales(flags: StoredFlag[]): Promise<number> {
    if (!this.cfg.AI_RATIONALE_ENABLED) return 0;
    let written = 0;
    for (const f of flags) {
      if (written >= this.cfg.AI_MAX_RATIONALES_PER_RUN) break;
      if (f.aiRationale || !RATIONALE_TYPES.has(f.type)) continue;
      const r = await this.rationale.generate(f);
      if (!r) continue;
      await this.flags.setRationale(f.id, r);
      f.aiRationale = r;
      written += 1;
    }
    return written;
  }
}
