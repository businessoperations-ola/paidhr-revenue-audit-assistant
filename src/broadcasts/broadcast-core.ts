import { z } from 'zod';
import { BRAND, escapeHtml } from '../alerts/message-format.js';
import type { IsoDate } from '../common/calendar.js';

// ====================================================================== input shape

export type BroadcastAudience = 'clients' | 'csms' | 'cx_team';
export type BroadcastChannel = 'email' | 'google_chat' | 'hubspot_task';

export const BroadcastFilters = z.object({
  /** Health statuses to include. */
  health: z.array(z.string().min(1).max(40)).max(10).optional(),
  /** CSM emails to include. */
  csm: z.array(z.string().email()).max(100).optional(),
  arrMinNgn: z.number().min(0).optional(),
  arrMaxNgn: z.number().min(0).optional(),
  /** Used or not used Earned Wage Access in the last 90 days. */
  ewa: z.enum(['used', 'not_used']).optional(),
  statutory: z.enum(['used', 'not_used']).optional(),
  /** CX-team audience only: which app roles to include. Default is everyone with access. */
  roles: z.array(z.string().min(1).max(40)).max(10).optional(),
});
export type BroadcastFilters = z.infer<typeof BroadcastFilters>;

export const BroadcastInput = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  audience: z.enum(['clients', 'csms', 'cx_team']),
  filters: BroadcastFilters.default({}),
  channels: z.array(z.enum(['email', 'google_chat', 'hubspot_task'])).min(1).max(3),
});
export type BroadcastInput = z.infer<typeof BroadcastInput>;

const ALLOWED_CHANNELS: Record<BroadcastAudience, BroadcastChannel[]> = {
  // Clients only ever get email. Chat is an internal space, and tasks are for CSMs.
  clients: ['email'],
  csms: ['email', 'google_chat', 'hubspot_task'],
  cx_team: ['email', 'google_chat'],
};

/** Returns a plain-English problem with the broadcast, or null when it can be saved. */
export function validateBroadcast(input: BroadcastInput): string | null {
  const bad = input.channels.filter((c) => !ALLOWED_CHANNELS[input.audience].includes(c));
  if (bad.length > 0) return `${input.audience === 'clients' ? 'Client broadcasts' : 'This audience'} cannot use: ${bad.join(', ')}`;
  if (new Set(input.channels).size !== input.channels.length) return 'Each channel can be chosen once';
  const used = findTokens(`${input.subject}\n${input.body}`);
  const unknown = used.filter((t) => !(TOKENS as readonly string[]).includes(t));
  if (unknown.length > 0) return `Unknown token${unknown.length > 1 ? 's' : ''}: ${unknown.map((t) => `{{${t}}}`).join(', ')}. Use: ${TOKENS.map((t) => `{{${t}}}`).join(', ')}`;
  if (input.audience === 'cx_team' && used.length > 0) return 'Company tokens cannot be used when writing to the CX team';
  if (input.filters.arrMinNgn !== undefined && input.filters.arrMaxNgn !== undefined && input.filters.arrMinNgn > input.filters.arrMaxNgn) return 'Minimum ARR is above maximum ARR';
  return null;
}

// ====================================================================== tokens (US-23)

export const TOKENS = ['company_name', 'csm_name', 'arr_ngn', 'active_seats', 'health_status', 'contract_end_date'] as const;
export type Token = (typeof TOKENS)[number];
export type TokenValues = Record<Token, string | null>;

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

export function findTokens(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]!.toLowerCase()))];
}

// ====================================================================== rich text

/**
 * Broadcasts are written in a small, safe format: paragraphs, "- " bullets, **bold**, _italic_ and
 * [text](https://link). Everything else is plain text, so no HTML from the editor ever reaches a client.
 */
function inlineHtml(escaped: string): string {
  return escaped
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" style="color:${BRAND.blue}">$1</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
}

const P = 'margin:0 0 14px;font-size:15px;line-height:1.6;color:' + BRAND.midnight;

/** `body` must already have its tokens replaced by placeholders; see renderBroadcast. */
export function richTextToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^[-*]\s+/.test(l))) {
        return `<ul style="margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.6;color:${BRAND.midnight}">${lines.map((l) => `<li>${inlineHtml(escapeHtml(l.replace(/^[-*]\s+/, '')))}</li>`).join('')}</ul>`;
      }
      return `<p style="${P}">${lines.map((l) => inlineHtml(escapeHtml(l))).join('<br>')}</p>`;
    })
    .join('');
}

export function richTextToPlain(body: string): string {
  return body
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2')
    .replace(/^[-*]\s+/gm, '• ');
}

/** Google Chat text: *bold*, _italic_, <url|label>. Angle brackets typed by the author are dropped first. */
export function richTextToChat(body: string): string {
  return body
    .replace(/[<>]/g, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]\n|]+)\]\((https?:\/\/[^\s)|]+)\)/g, '<$2|$1>')
    .replace(/^[-*]\s+/gm, '• ');
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
  chat: string;
}

/**
 * Fills in the tokens for one recipient. Returns `missing` instead of a message when a value the
 * template needs is not known, so nobody ever receives "₦undefined" or an empty name.
 */
export function renderBroadcast(template: { subject: string; body: string }, values: Partial<TokenValues>): { rendered: Rendered; missing: [] } | { rendered: null; missing: string[] } {
  const used = findTokens(`${template.subject}\n${template.body}`);
  const missing = used.filter((t) => !values[t as Token]);
  if (missing.length > 0) return { rendered: null, missing };

  const val = (t: string) => values[t as Token]!;
  const raw = (s: string) => s.replace(TOKEN_RE, (_m, t: string) => val(t.toLowerCase()));
  // HTML: swap tokens for placeholders, render, then insert the escaped values, so a value
  // containing markup or markdown characters can never change the formatting.
  const placeholders: string[] = [];
  const withPlaceholders = template.body.replace(TOKEN_RE, (_m, t: string) => `\u0001${placeholders.push(val(t.toLowerCase())) - 1}\u0002`);
  const html = richTextToHtml(withPlaceholders).replace(/\u0001(\d+)\u0002/g, (_m, i: string) => escapeHtml(placeholders[Number(i)]!));
  const body = raw(template.body);
  return {
    missing: [],
    rendered: {
      subject: raw(template.subject).replace(/\s+/g, ' ').trim().slice(0, 200),
      html,
      text: richTextToPlain(body),
      chat: richTextToChat(body),
    },
  };
}

/** Branded email around a rendered broadcast. */
export function broadcastEmailHtml(opts: { subject: string; bodyHtml: string; logoUrl: string | null; footer: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};font-family:${BRAND.font}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.line}">
  <tr><td style="background:${BRAND.blue};padding:20px 28px">${opts.logoUrl ? `<img src="${escapeHtml(opts.logoUrl)}" alt="PaidHR" height="28" style="display:block;height:28px;width:auto;border:0">` : `<span style="color:#ffffff;font-size:20px;font-weight:700">PaidHR</span>`}</td></tr>
  <tr><td style="height:4px;background:${BRAND.yellow};line-height:4px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:28px 28px 12px">
    <div style="font-size:22px;font-weight:700;color:${BRAND.navy};margin-bottom:16px">${escapeHtml(opts.subject)}</div>
    ${opts.bodyHtml}
  </td></tr>
  <tr><td style="padding:12px 28px 24px;font-size:12px;color:${BRAND.muted};border-top:1px solid ${BRAND.line}">${escapeHtml(opts.footer)}</td></tr>
  <tr><td style="background:${BRAND.midnight};padding:14px 28px;font-size:12px;color:#ffffff">PaidHR</td></tr>
</table></td></tr></table></body></html>`;
}

// ====================================================================== audience (US-21)

export interface AudienceCompany {
  hubspotId: string;
  name: string;
  csmName: string | null;
  csmEmail: string | null;
  csmOwnerId: string | null;
  arrKobo: bigint | null;
  healthStatus: string | null;
  /** Active users across the account and its sub-accounts. */
  activeSeats: number | null;
  contractEndDate: IsoDate | null;
  primaryContactEmail: string | null;
  usesEwa: boolean;
  usesStatutory: boolean;
}

export function filterCompanies(companies: AudienceCompany[], f: BroadcastFilters): AudienceCompany[] {
  const health = f.health?.map((h) => h.toLowerCase());
  const csm = f.csm?.map((e) => e.toLowerCase());
  return companies.filter((c) => {
    if (health && !health.includes((c.healthStatus ?? '').toLowerCase())) return false;
    if (csm && !(c.csmEmail && csm.includes(c.csmEmail.toLowerCase()))) return false;
    const arr = c.arrKobo === null ? null : Number(c.arrKobo / 100n);
    if (f.arrMinNgn !== undefined && (arr === null || arr < f.arrMinNgn)) return false;
    if (f.arrMaxNgn !== undefined && (arr === null || arr > f.arrMaxNgn)) return false;
    if (f.ewa && c.usesEwa !== (f.ewa === 'used')) return false;
    if (f.statutory && c.usesStatutory !== (f.statutory === 'used')) return false;
    return true;
  });
}

export interface RecipientRow {
  channel: BroadcastChannel;
  /** Email address, "space:default" for the Chat space, or the CSM for a HubSpot task. */
  recipient: string;
  company: AudienceCompany | null;
  /** Set when this row cannot be sent, and why. */
  skipReason?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHAT = 'space:default';

/** Everyone a broadcast would go to, one row per message. Rows that cannot be sent say why. */
export function buildRecipients(
  audience: BroadcastAudience,
  channels: BroadcastChannel[],
  companies: AudienceCompany[],
  users: Array<{ email: string; role: string }>,
  filters: BroadcastFilters,
): RecipientRow[] {
  const rows: RecipientRow[] = [];
  if (audience === 'cx_team') {
    const roles = filters.roles;
    const team = users.filter((u) => !roles || roles.includes(u.role));
    if (channels.includes('email')) for (const u of team) rows.push({ channel: 'email', recipient: u.email, company: null });
    if (channels.includes('google_chat')) rows.push({ channel: 'google_chat', recipient: CHAT, company: null });
    return rows;
  }
  for (const c of filterCompanies(companies, filters)) {
    for (const channel of channels) {
      if (audience === 'clients') {
        const emails = (c.primaryContactEmail ?? '').split(/[;,\s]+/).filter(Boolean);
        const valid = [...new Set(emails.filter((e) => EMAIL_RE.test(e)).map((e) => e.toLowerCase()))];
        if (valid.length === 0) rows.push({ channel, recipient: '(none)', company: c, skipReason: emails.length ? 'Contact email is not valid' : 'No contact email in HubSpot' });
        else for (const e of valid) rows.push({ channel, recipient: e, company: c });
      } else if (channel === 'email') {
        rows.push(c.csmEmail ? { channel, recipient: c.csmEmail, company: c } : { channel, recipient: '(none)', company: c, skipReason: 'No CSM assigned' });
      } else if (channel === 'google_chat') {
        rows.push({ channel, recipient: CHAT, company: c });
      } else {
        rows.push({ channel, recipient: c.csmEmail ?? 'unassigned', company: c });
      }
    }
  }
  return rows;
}

// ====================================================================== schedule (US-22)

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 08:00');
const DayOfMonth = z.number().int().min(1).max(28); // 1-28 so every month has the day

export const BroadcastSchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), runAt: z.string().datetime() }),
  z.object({ kind: z.literal('weekly'), dayOfWeek: z.number().int().min(1).max(7), time: Time }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: DayOfMonth, time: Time }),
  z.object({ kind: z.literal('quarterly'), dayOfMonth: DayOfMonth, startMonth: z.number().int().min(1).max(12), time: Time }),
]);
export type BroadcastSchedule = z.infer<typeof BroadcastSchedule>;

const WAT_MS = 3_600_000; // Nigeria is UTC+1 all year

/**
 * The next moment a schedule fires after `after`, as an instant. Times are West Africa Time.
 * weekly: dayOfWeek 1 = Monday … 7 = Sunday. quarterly: every third month from startMonth.
 * Returns null when a one-off time has passed.
 */
export function nextRun(schedule: BroadcastSchedule, after: Date): Date | null {
  if (schedule.kind === 'once') {
    const at = new Date(schedule.runAt);
    return at > after ? at : null;
  }
  const [hh, mm] = schedule.time.split(':').map(Number) as [number, number];
  const local = new Date(after.getTime() + WAT_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const at = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day, hh, mm) - WAT_MS);

  if (schedule.kind === 'weekly') {
    for (let i = 0; i <= 14; i += 1) {
      const dow = ((new Date(Date.UTC(y, m, d + i)).getUTCDay() + 6) % 7) + 1;
      const candidate = at(y, m, d + i);
      if (dow === schedule.dayOfWeek && candidate > after) return candidate;
    }
    return null;
  }
  for (let i = 0; i <= 14; i += 1) {
    const monthIndex = (m + i) % 12;
    if (schedule.kind === 'quarterly' && (((monthIndex - (schedule.startMonth - 1)) % 3) + 3) % 3 !== 0) continue;
    const candidate = at(y, m + i, schedule.dayOfMonth);
    if (candidate > after) return candidate;
  }
  return null;
}
