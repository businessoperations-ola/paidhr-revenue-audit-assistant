import type { StoredFlag } from '../audits/flag.repository.js';
import type { FlagType } from '../domain/types.js';

export const FLAG_TITLES: Record<FlagType, string> = {
  ARR_MISMATCH: 'ARR does not match seats × price',
  SEAT_INCREASE_NO_ARR_CHANGE: 'Seats grew, ARR did not',
  RENEWAL_NO_ARR_CHANGE: 'Renewed with ARR unchanged',
  UNLINKED_HUBSPOT_COMPANY: 'HubSpot customer not linked to Control Panel',
  UNLINKED_CONTROL_PANEL_ACCOUNT: 'Control Panel account missing from HubSpot',
  BROKEN_LINK: 'HubSpot links to an inactive or unknown account',
  SEAT_OVERAGE: 'More users than paid seats',
  MISSING_FIELDS: 'Missing HubSpot fields',
  LATE_PAYROLL: 'Payroll run is late',
  ENGAGEMENT_DROUGHT: 'No contact within the limit',
};

export type AckUrlFn = (flagId: number) => string;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Google Chat text supports *bold*, _italic_ and <url|label> links. */
function chatSafe(s: string): string {
  return s.replace(/[<>]/g, '');
}

export function chatMessage(recipient: string | null, flags: StoredFlag[], ackUrl: AckUrlFn): string {
  const urgent = flags.some((f) => f.severity === 'urgent');
  const who = recipient ?? 'unassigned accounts (no CSM in HubSpot)';
  const header = urgent
    ? `🚨 *Urgent audit alert for ${who}*`
    : `*${flags.length} new audit flag${flags.length === 1 ? '' : 's'} for ${who}*`;
  const lines = flags.map((f) => {
    const parts = [
      `${f.severity === 'urgent' ? '🚨 ' : ''}*${chatSafe(f.companyName)}*: ${FLAG_TITLES[f.type]}`,
      chatSafe(f.summary),
    ];
    if (f.aiRationale) parts.push(`_Next step:_ ${chatSafe(f.aiRationale.recommended_action)}`);
    parts.push(`<${ackUrl(f.id)}|Acknowledge>`);
    return parts.join('\n');
  });
  return [header, ...lines].join('\n\n');
}

export function emailSubject(flags: StoredFlag[]): string {
  const urgent = flags.filter((f) => f.severity === 'urgent');
  if (urgent.length > 0) {
    const first = urgent[0]!;
    return urgent.length === 1
      ? `URGENT: ${FLAG_TITLES[first.type]} at ${first.companyName}`
      : `URGENT: ${urgent.length} urgent audit alerts, ${flags.length} in total`;
  }
  return `${flags.length} new audit flag${flags.length === 1 ? '' : 's'} need your attention`;
}

/**
 * The closing line of a CSM email. It only promises escalation for flags that
 * actually escalate, so it never claims something the system won't do.
 */
export function escalationNote(flags: StoredFlag[], escalate: { severities: string[]; businessDays: number } | null): string | null {
  if (!escalate || !flags.some((f) => escalate.severities.includes(f.severity))) return null;
  const levels = escalate.severities.join(' and ');
  return `If ${levels} alerts are not acknowledged within ${escalate.businessDays} business days, they go to your team lead, or to the CS Directors if you have none on record.`;
}

export function emailBody(
  recipient: string | null,
  flags: StoredFlag[],
  ackUrl: AckUrlFn,
  note: string | null = null,
): { text: string; html: string } {
  const greeting = recipient ? 'Hi,' : 'These accounts have no CSM assigned in HubSpot.';
  const text = [
    greeting,
    '',
    'The Revenue & Data Audit Assistant found the following:',
    '',
    ...flags.flatMap((f) => [
      `- [${f.severity.toUpperCase()}] ${f.companyName}: ${FLAG_TITLES[f.type]}`,
      `  ${f.summary}`,
      ...(f.aiRationale
        ? [`  Why: ${f.aiRationale.explanation}`, `  Next step: ${f.aiRationale.recommended_action}`]
        : []),
      `  Acknowledge: ${ackUrl(f.id)}`,
      '',
    ]),
    ...(note ? [note] : []),
  ].join('\n');

  const rows = flags
    .map(
      (f) => `<tr>
  <td style="padding:8px;border-bottom:1px solid #ddd;vertical-align:top"><strong>${escapeHtml(f.companyName)}</strong><br>
    <span style="color:${f.severity === 'urgent' ? '#b42318' : '#555'}">${escapeHtml(FLAG_TITLES[f.type])} · ${f.severity}</span></td>
  <td style="padding:8px;border-bottom:1px solid #ddd;vertical-align:top">${escapeHtml(f.summary)}${
    f.aiRationale
      ? `<br><br><em>Why:</em> ${escapeHtml(f.aiRationale.explanation)}<br><em>Next step:</em> ${escapeHtml(f.aiRationale.recommended_action)}`
      : ''
  }</td>
  <td style="padding:8px;border-bottom:1px solid #ddd;vertical-align:top"><a href="${escapeHtml(ackUrl(f.id))}">Acknowledge</a></td>
</tr>`,
    )
    .join('\n');

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<p>${escapeHtml(greeting)}</p>
<p>The Revenue &amp; Data Audit Assistant found the following:</p>
<table style="border-collapse:collapse;width:100%">${rows}</table>
${note ? `<p style="color:#555">${escapeHtml(note)}</p>` : ''}
</div>`;
  return { text, html };
}

export function taskSubject(flag: StoredFlag): string {
  return `[Audit] ${FLAG_TITLES[flag.type]}: ${flag.companyName}`;
}

export function taskBody(flag: StoredFlag, ackUrl: AckUrlFn): string {
  return [
    flag.summary,
    ...(flag.aiRationale ? ['', `Why: ${flag.aiRationale.explanation}`, `Next step: ${flag.aiRationale.recommended_action}`] : []),
    '',
    `Audit flag #${flag.id}. Acknowledge: ${ackUrl(flag.id)}`,
  ].join('\n');
}

export type EscalationLevel = 'lead' | 'director';

/**
 * Why an escalation reaches its recipient. Directors hear about an alert either
 * after the team lead had it (`director`), or directly because the CSM has no
 * team lead on record (`director_no_lead`) or the account has no CSM (`director_no_csm`).
 */
export type EscalationRoute = 'lead' | 'director' | 'director_no_lead' | 'director_no_csm';

export function levelOf(route: EscalationRoute): EscalationLevel {
  return route === 'lead' ? 'lead' : 'director';
}

export interface EscalationItem {
  flag: StoredFlag;
  /** Business days since the CSM was notified (lead) or since the lead was (director). */
  businessDaysWaiting: number;
}

/** Why the item is still open: an acknowledged no-contact alert still needs a logged contact. */
function itemState(f: StoredFlag): string {
  return f.acknowledgedAt && f.type === 'ENGAGEMENT_DROUGHT'
    ? 'acknowledged, but no call, meeting or email logged yet'
    : 'not acknowledged';
}

/** US-16: what a team lead or director receives about one CSM's unhandled alerts. */
export function escalationSubject(route: EscalationRoute, csm: string | null, items: EscalationItem[]): string {
  const who = csm ?? 'accounts with no CSM';
  const n = `${items.length} alert${items.length === 1 ? '' : 's'}`;
  switch (route) {
    case 'lead':
      return `Escalation: ${n} for ${who} ${items.length === 1 ? 'needs' : 'need'} follow-up`;
    case 'director':
      return `Director escalation: ${n} for ${who} still unhandled after team lead`;
    case 'director_no_lead':
      return `Director escalation: ${n} for ${who} (no team lead on record)`;
    case 'director_no_csm':
      return `Director escalation: ${n} on ${who}`;
  }
}

function intro(route: EscalationRoute, csm: string | null): string {
  switch (route) {
    case 'lead':
      return `These alerts for ${csm} are still open after the CSM was notified.`;
    case 'director':
      return `These alerts for ${csm} were escalated to their team lead and are still unhandled.`;
    case 'director_no_lead':
      return `These alerts for ${csm} are still open. ${csm} has no team lead on record, so they come straight to you.`;
    case 'director_no_csm':
      return 'These alerts are on accounts with no CSM assigned in HubSpot, so they come straight to you.';
  }
}

function outro(route: EscalationRoute): string {
  switch (route) {
    case 'lead':
      return 'Please follow up with the CSM. Anything still unhandled goes to the CS Directors next.';
    case 'director':
      return 'Please follow up with the team lead and CSM.';
    case 'director_no_lead':
      return 'Please follow up with the CSM, and set their team lead in the Audit Assistant (Team leads).';
    case 'director_no_csm':
      return 'Please assign a CSM to these accounts in HubSpot.';
  }
}

export function escalationText(route: EscalationRoute, csm: string | null, items: EscalationItem[], ackUrl: AckUrlFn): string {
  return [
    intro(route, csm),
    '',
    ...items.flatMap(({ flag: f, businessDaysWaiting }) => [
      `- [${f.severity.toUpperCase()}] ${f.companyName}: ${FLAG_TITLES[f.type]}`,
      `  ${f.summary}`,
      `  Open ${businessDaysWaiting} business days, ${itemState(f)}. Acknowledge: ${ackUrl(f.id)}`,
      '',
    ]),
    outro(route),
  ].join('\n');
}

export function escalationChat(route: EscalationRoute, csm: string | null, items: EscalationItem[], ackUrl: AckUrlFn): string {
  const n = `${items.length} alert${items.length === 1 ? '' : 's'}`;
  const who = csm ?? 'accounts with no CSM';
  const head =
    route === 'lead'
      ? `⏫ *Escalated to team lead: ${n} for ${who}*`
      : route === 'director'
        ? `⏫⏫ *Escalated to CS Directors: ${n} for ${who}, still unhandled after team lead*`
        : `⏫⏫ *Escalated to CS Directors: ${n} for ${who}${route === 'director_no_lead' ? ' (no team lead on record)' : ''}*`;
  return [
    head,
    ...items.map(
      ({ flag: f, businessDaysWaiting }) =>
        `*${chatSafe(f.companyName)}*: ${FLAG_TITLES[f.type]} · open ${businessDaysWaiting} business days, ${itemState(f)}\n${chatSafe(f.summary)}\n<${ackUrl(f.id)}|Acknowledge>`,
    ),
  ].join('\n\n');
}
