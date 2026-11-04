export type SlaState = 'met' | 'ok' | 'at_risk' | 'breached';

export interface SlaRules {
  firstResponseHigh: number;
  firstResponseNormal: number;
  resolutionHigh: number;
  resolutionNormal: number;
  atRiskPct: number;
}

export interface SlaTicket {
  priority: string | null;
  createdAt: string;
  firstResponseAt?: string | null;
  closedAt: string | null;
  isClosed: boolean;
}

export interface SlaClock {
  targetHours: number;
  elapsedHours: number;
  state: SlaState;
}

export interface SlaResult {
  bucket: 'high' | 'normal';
  firstResponse: SlaClock;
  resolution: SlaClock;
  /** Open and past a target: someone should step in. */
  openBreach: boolean;
  /** Open and close to a target. */
  openAtRisk: boolean;
}

const HOUR = 3_600_000;

/** High and urgent tickets get the tighter targets. Everything else uses the normal ones. */
export const bucketOf = (priority: string | null): 'high' | 'normal' => (priority && ['HIGH', 'URGENT'].includes(priority.toUpperCase()) ? 'high' : 'normal');

function clock(startMs: number, endMs: number | null, nowMs: number, target: number, atRiskPct: number, done: boolean): SlaClock {
  const elapsed = Math.max(0, ((endMs ?? nowMs) - startMs) / HOUR);
  const rounded = Math.round(elapsed * 10) / 10;
  if (done) return { targetHours: target, elapsedHours: rounded, state: elapsed <= target ? 'met' : 'breached' };
  return { targetHours: target, elapsedHours: rounded, state: elapsed > target ? 'breached' : elapsed >= (target * atRiskPct) / 100 ? 'at_risk' : 'ok' };
}

/**
 * Where a ticket stands against its first-response and resolution targets.
 * Times are elapsed clock hours, not working hours: a ticket raised on Friday evening is
 * counted through the weekend, so it is the stricter reading.
 */
export function slaFor(t: SlaTicket, rules: SlaRules, now: Date): SlaResult {
  const bucket = bucketOf(t.priority);
  const created = Date.parse(t.createdAt);
  const nowMs = now.getTime();
  const frTarget = bucket === 'high' ? rules.firstResponseHigh : rules.firstResponseNormal;
  const resTarget = bucket === 'high' ? rules.resolutionHigh : rules.resolutionNormal;
  const first = t.firstResponseAt ? Date.parse(t.firstResponseAt) : null;
  // A closed ticket with no recorded reply is treated as answered when it was closed.
  const firstEnd = first ?? (t.isClosed && t.closedAt ? Date.parse(t.closedAt) : null);
  const firstResponse = clock(created, firstEnd, nowMs, frTarget, rules.atRiskPct, firstEnd !== null);
  const resolution = clock(created, t.isClosed && t.closedAt ? Date.parse(t.closedAt) : null, nowMs, resTarget, rules.atRiskPct, t.isClosed);
  const open = !t.isClosed;
  const states = [firstResponse.state, resolution.state];
  return {
    bucket,
    firstResponse,
    resolution,
    openBreach: open && (firstResponse.state === 'breached' && first === null || resolution.state === 'breached'),
    openAtRisk: open && !states.includes('breached') && states.includes('at_risk'),
  };
}

import type { AuditRules } from '../audits/rules.repository.js';
import type { Finding, HubSpotCompany } from '../domain/types.js';
import type { SupportTicket } from '../cx/cx-rules.js';

export const slaRulesFrom = (r: AuditRules): SlaRules => ({
  firstResponseHigh: r.sla_first_response_high_hours,
  firstResponseNormal: r.sla_first_response_normal_hours,
  resolutionHigh: r.sla_resolution_high_hours,
  resolutionNormal: r.sla_resolution_normal_hours,
  atRiskPct: r.sla_at_risk_pct,
});

const hours = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)}h`);

/**
 * One alert per customer that has open tickets past their first-response or resolution target,
 * so the CSM can step in. The alert clears itself when the tickets are answered or closed.
 */
export function auditSlaBreach(tickets: SupportTicket[], companies: HubSpotCompany[], now: Date, rules: SlaRules): Finding[] {
  const byId = new Map(companies.map((c) => [c.hubspotId, c]));
  const late = new Map<string, Array<{ t: SupportTicket; r: SlaResult }>>();
  for (const t of tickets) {
    if (t.isClosed || !t.hubspotCompanyId || !byId.has(t.hubspotCompanyId)) continue;
    const r = slaFor({ priority: t.priority ?? null, createdAt: t.createdAt, firstResponseAt: t.firstResponseAt ?? null, closedAt: null, isClosed: false }, rules, now);
    if (!r.openBreach) continue;
    late.set(t.hubspotCompanyId, [...(late.get(t.hubspotCompanyId) ?? []), { t, r }]);
  }
  return [...late.entries()].map(([companyId, list]) => {
    const c = byId.get(companyId)!;
    const worst = [...list].sort((a, b) => b.r.resolution.elapsedHours - a.r.resolution.elapsedHours)[0]!;
    const why = worst.r.firstResponse.state === 'breached' && !worst.t.firstResponseAt
      ? `no reply after ${hours(worst.r.firstResponse.elapsedHours)} (target ${hours(worst.r.firstResponse.targetHours)})`
      : `open ${hours(worst.r.resolution.elapsedHours)} (target ${hours(worst.r.resolution.targetHours)})`;
    return {
      type: 'SUPPORT_SLA_BREACH',
      severity: list.some((x) => x.r.bucket === 'high') ? 'high' : 'medium',
      entityKey: `hs:${companyId}`,
      hubspotCompanyId: companyId,
      controlPanelId: c.controlPanelId,
      companyName: c.name,
      csmEmail: c.csmEmail,
      summary: `${list.length} ticket${list.length === 1 ? '' : 's'} past the support SLA. Worst: "${worst.t.subject}", ${why}.`,
      details: { tickets: list.map(({ t, r }) => ({ ticketId: t.ticketId, subject: t.subject, priority: t.priority ?? null, firstResponse: r.firstResponse, resolution: r.resolution })) },
    } satisfies Finding;
  });
}
