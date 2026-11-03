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

export function emailBody(recipient: string | null, flags: StoredFlag[], ackUrl: AckUrlFn): { text: string; html: string } {
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
    'Unacknowledged alerts will escalate to your team lead.',
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
<p style="color:#555">Unacknowledged alerts will escalate to your team lead.</p>
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
