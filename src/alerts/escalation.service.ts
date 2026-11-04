import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StoredFlag } from '../audits/flag.repository.js';
import { FlagRepository } from '../audits/flag.repository.js';
import { RulesRepository, type AuditRules } from '../audits/rules.repository.js';
import { todayInLagos, type BusinessCalendar, type IsoDate } from '../common/calendar.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { ackUrl, logoUrl } from './ack-link.js';
import { ALERT_SENDERS, type AlertSenders, type ChannelName } from './channels/channels.js';
import {
  escalationChat,
  escalationHtml,
  escalationSubject,
  escalationText,
  levelOf,
  type EscalationItem,
  type EscalationLevel,
  type EscalationRoute,
} from './message-format.js';

export interface EscalationDecision extends EscalationItem {
  level: EscalationLevel;
}

const lagosDate = (iso: string): IsoDate => todayInLagos(new Date(iso));

/**
 * US-16 rules, as a pure function:
 * - Only open flags at an escalating severity, after the CSM was actually notified.
 * - Acknowledging stops escalation, except for engagement droughts: those count as
 *   handled only when a call, meeting or email is logged (which resolves the flag).
 * - Level 0 → team lead after `escalation_business_days` since notification.
 * - Level 1 → CS Directors after `director_escalation_business_days` since the lead escalation.
 */
export function decideEscalations(
  flags: StoredFlag[],
  today: IsoDate,
  calendar: BusinessCalendar,
  rules: Pick<AuditRules, 'escalate_severities' | 'escalation_business_days' | 'director_escalation_business_days'>,
): EscalationDecision[] {
  const out: EscalationDecision[] = [];
  for (const flag of flags) {
    if (flag.status !== 'open' || !flag.notifiedAt || flag.escalationLevel >= 2) continue;
    if (!rules.escalate_severities.includes(flag.severity)) continue;
    const handled = flag.acknowledgedAt !== null && flag.type !== 'ENGAGEMENT_DROUGHT';
    if (handled) continue;

    if (flag.escalationLevel === 0) {
      const waiting = calendar.businessDaysBetween(lagosDate(flag.notifiedAt), today);
      if (waiting >= rules.escalation_business_days) out.push({ flag, level: 'lead', businessDaysWaiting: waiting });
    } else if (flag.escalatedOn) {
      const waiting = calendar.businessDaysBetween(flag.escalatedOn, today);
      if (waiting >= rules.director_escalation_business_days) {
        out.push({ flag, level: 'director', businessDaysWaiting: waiting });
      }
    }
  }
  return out;
}

export interface EscalationResult {
  toLeads: number;
  toDirectors: number;
  failed: number;
  dryRun: boolean;
}

const CHAT_SPACE = 'space:default';

@Injectable()
export class EscalationService {
  private readonly log = new Logger(EscalationService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(FlagRepository) private readonly flags: FlagRepository,
    @Inject(RulesRepository) private readonly rules: RulesRepository,
    @Inject(ALERT_SENDERS) private readonly senders: AlertSenders,
  ) {}

  async run(today: IsoDate): Promise<EscalationResult> {
    const [rules, calendar] = await Promise.all([this.rules.load(), this.rules.calendar()]);
    const candidates = await this.flags.listEscalationCandidates();
    const decisions = decideEscalations(candidates, today, calendar, rules);
    const result: EscalationResult = { toLeads: 0, toDirectors: 0, failed: 0, dryRun: this.cfg.ALERTS_DRY_RUN };
    if (decisions.length === 0) return result;

    const leads = await this.teamLeads();
    const directors = await this.directors();

    // A CSM with no team lead on record goes straight to the directors.
    const groups = new Map<
      string,
      { route: EscalationRoute; level: EscalationLevel; csm: string | null; to: string[]; items: EscalationItem[] }
    >();
    for (const d of decisions) {
      const lead = d.flag.csmEmail ? leads.get(d.flag.csmEmail) : undefined;
      const route: EscalationRoute =
        d.level === 'director' ? 'director' : !d.flag.csmEmail ? 'director_no_csm' : lead ? 'lead' : 'director_no_lead';
      const level = levelOf(route);
      const to = route === 'lead' ? [lead!] : directors;
      const key = `${route}|${d.flag.csmEmail ?? ''}`;
      const g = groups.get(key) ?? { route, level, csm: d.flag.csmEmail, to, items: [] };
      g.items.push({ flag: d.flag, businessDaysWaiting: d.businessDaysWaiting });
      groups.set(key, g);
    }

    const ack = (id: number) => ackUrl(this.cfg.APP_BASE_URL, this.cfg.ACK_LINK_SECRET, id);
    for (const g of groups.values()) {
      if (this.cfg.ALERTS_DRY_RUN) {
        this.log.log(`[dry run] escalate to ${g.level} (${g.to.join(', ') || 'nobody'}): ${g.items.map((i) => `#${i.flag.id}`).join(', ')}`);
        continue;
      }
      const kind = g.level === 'lead' ? 'escalation_lead' : 'escalation_director';
      let sentAny = false;

      if (this.cfg.ALERT_CHANNELS.includes('email') && g.to.length > 0) {
        sentAny =
          (await this.deliver(g.items, 'email', g.to.join(','), kind, () =>
            this.senders.email.send({
              to: g.to,
              subject: escalationSubject(g.route, g.csm, g.items),
              text: escalationText(g.route, g.csm, g.items, ack),
              html: escalationHtml(g.route, g.csm, g.items, ack, logoUrl(this.cfg.APP_BASE_URL)),
            }),
          )) || sentAny;
      }
      if (this.cfg.ALERT_CHANNELS.includes('google_chat') && this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK) {
        const webhook = this.cfg.GOOGLE_CHAT_DEFAULT_WEBHOOK;
        sentAny =
          (await this.deliver(g.items, 'google_chat', CHAT_SPACE, kind, () =>
            this.senders.chat.send(webhook, escalationChat(g.route, g.csm, g.items, ack)),
          )) || sentAny;
      }

      if (!sentAny) {
        result.failed += g.items.length;
        continue; // retried on the next sweep
      }
      const newLevel = g.level === 'lead' ? 1 : 2;
      for (const { flag } of g.items) {
        await this.db.query(
          `UPDATE audit_flag SET escalation_level = $2, escalated_at = now(), escalated_on = $3
            WHERE id = $1 AND escalation_level < $2`,
          [flag.id, newLevel, today],
        );
        await this.db.query(
          `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ('scheduler', 'flag.escalate', 'audit_flag', $1, $2)`,
          [String(flag.id), JSON.stringify({ level: g.level, route: g.route, to: g.to })],
        );
      }
      if (g.level === 'lead') result.toLeads += g.items.length;
      else result.toDirectors += g.items.length;
    }

    this.log.log(`Escalation: ${result.toLeads} to team leads, ${result.toDirectors} to directors, ${result.failed} failed`);
    return result;
  }

  /** Send once per group and record a row per flag. Returns true if the message went out. */
  private async deliver(
    items: EscalationItem[],
    channel: ChannelName,
    recipient: string,
    kind: string,
    send: () => Promise<string>,
  ): Promise<boolean> {
    let status: 'sent' | 'failed' = 'sent';
    let ref: string | null = null;
    let error: string | null = null;
    try {
      ref = await send();
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      this.log.warn(`Escalation ${channel} → ${recipient} failed: ${error}`);
    }
    for (const { flag } of items) {
      await this.db.query(
        `INSERT INTO alert (flag_id, channel, recipient, kind, status, attempts, external_ref, error, sent_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, CASE WHEN $5 = 'sent' THEN now() END)
         ON CONFLICT (flag_id, channel, recipient, kind) DO UPDATE
           SET status = EXCLUDED.status, attempts = alert.attempts + 1, external_ref = EXCLUDED.external_ref,
               error = EXCLUDED.error, sent_at = EXCLUDED.sent_at`,
        [flag.id, channel, recipient, kind, status, ref, error],
      );
    }
    return status === 'sent';
  }

  private async teamLeads(): Promise<Map<string, string>> {
    const { rows } = await this.db.query<{ csm_email: string; team_lead_email: string }>(
      'SELECT csm_email, team_lead_email FROM csm_team',
    );
    return new Map(rows.map((r) => [r.csm_email, r.team_lead_email]));
  }

  /** Every CS Director with access; the fallback list if none is set up yet. */
  private async directors(): Promise<string[]> {
    const { rows } = await this.db.query<{ email: string }>(
      `SELECT email FROM app_user WHERE active AND role = 'cs_director' ORDER BY email`,
    );
    // Sorted here rather than in SQL, so the order doesn't depend on the database collation.
    return rows.length > 0 ? rows.map((r) => r.email).sort() : this.cfg.FALLBACK_ALERT_EMAILS;
  }
}
