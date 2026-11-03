import { describe, expect, it } from 'vitest';
import { decideEscalations } from '../../src/alerts/escalation.service.js';
import { escalationSubject, escalationText } from '../../src/alerts/message-format.js';
import { auditEngagement, thresholdFor } from '../../src/audits/engagement.audit.js';
import { auditLatePayroll } from '../../src/audits/late-payroll.audit.js';
import type { StoredFlag } from '../../src/audits/flag.repository.js';
import { BusinessCalendar } from '../../src/common/calendar.js';
import type { HubSpotCompany } from '../../src/domain/types.js';
import { mapCompany } from '../../src/sources/hubspot/hubspot.mapper.js';
import { propertyMapFromConfig } from '../../src/sources/hubspot/hubspot.mapper.js';
import { loadConfig } from '../../src/config/config.js';

const RULES = { 'At Risk': 7, Neutral: 14, Healthy: 30, default: 14 };

function company(over: Partial<HubSpotCompany> = {}): HubSpotCompany {
  return {
    hubspotId: 'h1', name: 'Acme', domain: null, controlPanelId: 'c1', csmName: 'Ada', csmEmail: 'ada@x.com', csmOwnerId: '9',
    industry: 'Tech', contractEndDate: null, seatTier: 'S', paidSeats: 10, arrKobo: 1n, pricePerSeatMonthlyKobo: 1n,
    healthStatus: 'Neutral', lastActivityDate: '2026-11-01', ...over,
  };
}

describe('US-13 / US-14 engagement drought', () => {
  it('uses the limit for the health status, case-insensitively, with a default', () => {
    expect(thresholdFor('at risk', RULES)).toBe(7);
    expect(thresholdFor(' Healthy ', RULES)).toBe(30);
    expect(thresholdFor('Churning', RULES)).toBe(14);
    expect(thresholdFor(null, RULES)).toBe(14);
  });

  it('flags only when days since last contact exceed the limit', () => {
    // At Risk, limit 7: 7 days is fine, 8 is not.
    expect(auditEngagement([company({ healthStatus: 'At Risk', lastActivityDate: '2026-10-27' })], '2026-11-03', RULES)).toEqual([]);
    const [f] = auditEngagement([company({ healthStatus: 'At Risk', lastActivityDate: '2026-10-26' })], '2026-11-03', RULES);
    expect(f).toMatchObject({ type: 'ENGAGEMENT_DROUGHT', severity: 'high', details: { daysInactive: 8, limitDays: 7 } });
    expect(f?.summary).toBe('8 days since the last call, meeting or email (At Risk, limit 7 days)');
  });

  it('flags customers with no logged contact at all, and sets severity by health', () => {
    const [never] = auditEngagement([company({ lastActivityDate: null })], '2026-11-03', RULES);
    expect(never?.summary).toContain('No call, meeting or email ever logged');
    expect(never?.severity).toBe('medium');
    const [healthy] = auditEngagement([company({ healthStatus: 'Healthy', lastActivityDate: '2026-09-01' })], '2026-11-03', RULES);
    expect(healthy?.severity).toBe('low');
  });

  it('reads HubSpot "Last contacted" timestamps as WAT dates', () => {
    const map = propertyMapFromConfig(loadConfig({ DATABASE_URL: 'x' }));
    // 23:30 UTC on 2 Nov is 00:30 WAT on 3 Nov.
    const c = mapCompany({ id: '1', properties: { name: 'A', notes_last_contacted: '2026-11-02T23:30:00.000Z' } }, map, new Map());
    expect(c.lastActivityDate).toBe('2026-11-03');
    const d = mapCompany({ id: '1', properties: { name: 'A', notes_last_contacted: String(Date.parse('2026-11-02T23:30:00Z')) } }, map, new Map());
    expect(d.lastActivityDate).toBe('2026-11-03');
  });
});

describe('phase-1 wording fixes', () => {
  it('capitalises the late-payroll summary', () => {
    const [f] = auditLatePayroll(
      [{ clientId: 'c', parentClientId: null, name: 'A', isActive: true, activeUsers: 1, contractorUsers: 0, payFrequency: 'SEMI_MONTHLY', payDay: null, lastPayrollPayDate: '2026-10-15', lastPayrollCompletedAt: null }],
      { today: '2026-11-10', calendar: new BusinessCalendar(), graceBusinessDays: 2, companyFor: () => undefined },
    );
    expect(f?.summary.startsWith('Semi-monthly payroll expected 2026-10-31')).toBe(true);
  });
});

describe('US-16 escalation rules', () => {
  const calendar = new BusinessCalendar(['2026-11-09']); // pretend Monday 9 Nov is a holiday
  const rules = { escalate_severities: ['urgent', 'high'] as Array<'urgent' | 'high'>, escalation_business_days: 3, director_escalation_business_days: 2 };
  const flag = (over: Partial<StoredFlag>): StoredFlag => ({
    id: 1, type: 'ARR_MISMATCH', entityKey: 'k', status: 'open', severity: 'high', hubspotCompanyId: '1', controlPanelId: null,
    companyName: 'Acme', csmEmail: 'ada@x.com', summary: 's', details: {}, aiRationale: null, firstSeenAt: '',
    acknowledgedAt: null, acknowledgedBy: null, notifiedAt: '2026-11-03T04:05:00Z', escalationLevel: 0, escalatedAt: null, escalatedOn: null, ...over,
  });

  it('goes to the team lead after 3 business days without acknowledgement', () => {
    expect(decideEscalations([flag({})], '2026-11-05', calendar, rules)).toEqual([]); // Wed, Thu = 2
    const [d] = decideEscalations([flag({})], '2026-11-06', calendar, rules); // + Fri = 3
    expect(d).toMatchObject({ level: 'lead', businessDaysWaiting: 3 });
  });

  it('then to the directors 2 business days after the lead, skipping holidays', () => {
    const escalated = flag({ escalationLevel: 1, escalatedAt: '2026-11-06T07:00:00Z', escalatedOn: '2026-11-06' });
    expect(decideEscalations([escalated], '2026-11-09', calendar, rules)).toEqual([]); // holiday
    expect(decideEscalations([escalated], '2026-11-10', calendar, rules)).toEqual([]); // 1
    expect(decideEscalations([escalated], '2026-11-11', calendar, rules)[0]).toMatchObject({ level: 'director', businessDaysWaiting: 2 });
  });

  it('stops for acknowledged flags, except engagement droughts', () => {
    expect(decideEscalations([flag({ acknowledgedAt: '2026-11-04T09:00:00Z' })], '2026-11-06', calendar, rules)).toEqual([]);
    const drought = flag({ type: 'ENGAGEMENT_DROUGHT', acknowledgedAt: '2026-11-04T09:00:00Z' });
    expect(decideEscalations([drought], '2026-11-06', calendar, rules)).toHaveLength(1);
  });

  it('ignores low-level, unsent, resolved and already-at-director flags', () => {
    const today = '2026-11-20';
    expect(decideEscalations([
      flag({ severity: 'medium' }),
      flag({ notifiedAt: null }),
      flag({ status: 'resolved' }),
      flag({ escalationLevel: 2, escalatedAt: '2026-11-06T07:00:00Z', escalatedOn: '2026-11-06' }),
    ], today, calendar, rules)).toEqual([]);
  });

  it('writes escalation messages that say how long each alert has waited', () => {
    const items = [{ flag: flag({ companyName: 'Lekki Foods' }), businessDaysWaiting: 3 }];
    expect(escalationSubject('lead', 'ada@x.com', items)).toBe('Escalation: 1 alert for ada@x.com not acknowledged');
    expect(escalationText('director', null, items, (id) => `https://a/ack/${id}`)).toContain('Lekki Foods: ARR does not match seats × price (waiting 3 business days)');
  });
});
