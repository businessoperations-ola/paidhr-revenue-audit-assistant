import { todayInLagos } from '../../common/calendar.js';
import { parseNgnToKobo } from '../../common/money.js';
import type { AppConfig } from '../../config/config.js';
import type { HubSpotCompany } from '../../domain/types.js';

export type HubSpotPropertyMap = {
  controlPanelId: string;
  csmName: string;
  csmEmail: string;
  industry: string;
  contractEnd: string;
  seatTier: string;
  paidSeats: string;
  arr: string;
  pricePerSeat: string;
  health: string;
  lastActivity: string;
};

export function propertyMapFromConfig(cfg: AppConfig): HubSpotPropertyMap {
  return {
    controlPanelId: cfg.HS_PROP_CONTROL_PANEL_ID,
    csmName: cfg.HS_PROP_CSM_NAME,
    csmEmail: cfg.HS_PROP_CSM_EMAIL,
    industry: cfg.HS_PROP_INDUSTRY,
    contractEnd: cfg.HS_PROP_CONTRACT_END,
    seatTier: cfg.HS_PROP_SEAT_TIER,
    paidSeats: cfg.HS_PROP_PAID_SEATS,
    arr: cfg.HS_PROP_ARR,
    pricePerSeat: cfg.HS_PROP_PRICE_PER_SEAT,
    health: cfg.HS_PROP_HEALTH,
    lastActivity: cfg.HS_PROP_LAST_ACTIVITY,
  };
}

/** Every HubSpot property the audits request. */
export function requestedProperties(map: HubSpotPropertyMap): string[] {
  return ['name', 'domain', 'hubspot_owner_id', 'lifecyclestage', ...Object.values(map)];
}

function text(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function int(v: string | null | undefined): number | null {
  const t = text(v);
  if (t === null) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * HubSpot date properties arrive as 'YYYY-MM-DD', epoch milliseconds, or an ISO
 * timestamp. Date-only values are kept as-is; moments in time become WAT dates.
 */
function date(v: string | null | undefined): string | null {
  const t = text(v);
  if (t === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : todayInLagos(d);
  }
  if (/^\d+$/.test(t)) {
    // Date-only properties are midnight UTC; keep their calendar day.
    const d = new Date(Number(t));
    return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? d.toISOString().slice(0, 10) : todayInLagos(d);
  }
  return null;
}

export interface HubSpotCompanyRecord {
  id: string;
  properties: Record<string, string | null | undefined>;
}

export function mapCompany(
  record: HubSpotCompanyRecord,
  map: HubSpotPropertyMap,
  ownerEmails: Map<string, string>,
): HubSpotCompany {
  const p = record.properties;
  const ownerId = text(p.hubspot_owner_id);
  return {
    hubspotId: record.id,
    name: text(p.name) ?? `HubSpot company ${record.id}`,
    domain: text(p.domain),
    controlPanelId: text(p[map.controlPanelId]),
    csmName: text(p[map.csmName]),
    // Prefer an explicit CSM email property; fall back to the record owner's email.
    csmEmail: text(p[map.csmEmail])?.toLowerCase() ?? (ownerId ? ownerEmails.get(ownerId) ?? null : null),
    csmOwnerId: ownerId,
    industry: text(p[map.industry]),
    contractEndDate: date(p[map.contractEnd]),
    seatTier: text(p[map.seatTier]),
    paidSeats: int(p[map.paidSeats]),
    arrKobo: parseNgnToKobo(text(p[map.arr])),
    pricePerSeatMonthlyKobo: parseNgnToKobo(text(p[map.pricePerSeat])),
    healthStatus: text(p[map.health]),
    lastActivityDate: date(p[map.lastActivity]),
  };
}
