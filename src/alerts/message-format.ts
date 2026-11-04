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
  ONBOARDING_STAGNATION: 'Onboarding stalled: payroll not set up',
  SUPPORT_ESCALATION_RISK: 'Support issue at risk of escalating',
};

export type AckUrlFn = (flagId: number) => string;

export function escapeHtml(s: string): string {
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
  logoUrl: string | null = null,
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

  const html = brandedEmailHtml({
    logoUrl,
    heading: flags.some((f) => f.severity === 'urgent') ? 'Urgent: action needed' : 'New audit alerts',
    intro: [greeting, 'The Revenue & Data Audit Assistant found the following:'],
    items: flags.map((f) => ({
      flag: f,
      lines: [
        f.summary,
        ...(f.aiRationale ? [`Why: ${f.aiRationale.explanation}`, `Next step: ${f.aiRationale.recommended_action}`] : []),
      ],
      ackUrl: ackUrl(f.id),
    })),
    footer: note,
  });
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

/* ---------- Branded HTML email (PaidHR colours; tables and inline styles for email clients) ---------- */

export const BRAND = {
  blue: '#004AF5',
  navy: '#012B86',
  navInk: '#0B2D74',
  midnight: '#0B1A3C',
  yellow: '#FDC023',
  page: '#F6F7FF',
  muted: '#485266',
  line: '#E3E6EF',
  font: "Gilroy, 'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif",
};

const SEVERITY_STYLE: Record<string, { fg: string; bg: string }> = {
  urgent: { fg: '#C4320A', bg: '#FDEEE8' },
  high: { fg: '#B54708', bg: '#FEF3E2' },
  medium: { fg: '#8A6100', bg: '#FFF6D6' },
  low: { fg: '#485266', bg: '#EEF0F5' },
};

export interface BrandedEmailItem {
  flag: StoredFlag;
  lines: string[];
  ackUrl: string;
}

export function brandedEmailHtml(opts: {
  logoUrl: string | null;
  heading: string;
  intro: string[];
  items: BrandedEmailItem[];
  footer: string | null;
}): string {
  const items = opts.items
    .map(({ flag: f, lines, ackUrl }) => {
      const sev = SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.low!;
      return `<tr><td style="padding:16px 0;border-top:1px solid ${BRAND.line}">
  <span style="display:inline-block;font-size:12px;font-weight:600;color:${sev.fg};background:${sev.bg};border-radius:999px;padding:3px 10px;text-transform:capitalize">${escapeHtml(f.severity)}</span>
  <div style="font-size:16px;font-weight:700;color:${BRAND.navInk};margin:8px 0 2px">${escapeHtml(f.companyName)}</div>
  <div style="font-size:14px;font-weight:600;color:${BRAND.navy};margin-bottom:6px">${escapeHtml(FLAG_TITLES[f.type])}</div>
  ${lines.map((l) => `<div style="font-size:14px;line-height:1.55;color:${BRAND.muted};margin-bottom:4px">${escapeHtml(l)}</div>`).join('')}
  <a href="${escapeHtml(ackUrl)}" style="display:inline-block;margin-top:10px;background:${BRAND.blue};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:9px 18px;border-radius:8px">Acknowledge</a>
</td></tr>`;
    })
    .join('\n');

  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};font-family:${BRAND.font}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.line}">
  <tr><td style="background:${BRAND.blue};padding:20px 28px">
    ${opts.logoUrl ? `<img src="${escapeHtml(opts.logoUrl)}" alt="PaidHR" height="28" style="display:block;height:28px;width:auto;border:0">` : `<span style="color:#ffffff;font-size:20px;font-weight:700">PaidHR</span>`}
  </td></tr>
  <tr><td style="height:4px;background:${BRAND.yellow};line-height:4px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:24px 28px 8px">
    <div style="font-size:22px;font-weight:700;color:${BRAND.navy};margin-bottom:10px">${escapeHtml(opts.heading)}</div>
    ${opts.intro.map((p) => `<p style="margin:0 0 8px;font-size:15px;color:${BRAND.muted}">${escapeHtml(p)}</p>`).join('')}
  </td></tr>
  <tr><td style="padding:0 28px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr>
  ${opts.footer ? `<tr><td style="padding:12px 28px 24px;font-size:13px;color:${BRAND.muted};border-top:1px solid ${BRAND.line}">${escapeHtml(opts.footer)}</td></tr>` : ''}
  <tr><td style="background:${BRAND.midnight};padding:14px 28px;font-size:12px;color:#ffffff">PaidHR <span style="color:${BRAND.yellow};font-weight:600">Revenue &amp; Data Audit Assistant</span></td></tr>
</table>
</td></tr></table></body></html>`;
}

/** The branded HTML version of an escalation email; the text version is escalationText. */
export function escalationHtml(
  route: EscalationRoute,
  csm: string | null,
  items: EscalationItem[],
  ackUrl: AckUrlFn,
  logoUrl: string | null,
): string {
  return brandedEmailHtml({
    logoUrl,
    heading: route === 'lead' ? 'Escalation: alerts need follow-up' : 'Director escalation',
    intro: [intro(route, csm)],
    items: items.map(({ flag: f, businessDaysWaiting }) => ({
      flag: f,
      lines: [f.summary, `Open ${businessDaysWaiting} business days, ${itemState(f)}.`],
      ackUrl: ackUrl(f.id),
    })),
    footer: outro(route),
  });
}
