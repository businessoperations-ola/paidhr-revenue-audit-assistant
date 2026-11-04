import { describe, expect, it } from 'vitest';
import { eventLabel } from '../../src/adoption/modules.js';
import { auditSlaBreach, bucketOf, slaFor, type SlaRules } from '../../src/adoption/sla.js';
import type { SupportTicket } from '../../src/cx/cx-rules.js';
import { FIXTURE_COMPANIES } from '../../src/sources/fixtures/fixture.sources.js';

const RULES: SlaRules = { firstResponseHigh: 4, firstResponseNormal: 8, resolutionHigh: 24, resolutionNormal: 72, atRiskPct: 75 };
const NOW = new Date('2026-11-10T12:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const open = (hours: number, over: Partial<{ priority: string | null; firstResponseAt: string | null }> = {}) => ({ priority: 'MEDIUM', createdAt: ago(hours), firstResponseAt: null, closedAt: null, isClosed: false, ...over });

describe('support SLA clocks', () => {
  it('gives high and urgent tickets the tighter targets', () => {
    expect(bucketOf('HIGH')).toBe('high');
    expect(bucketOf('urgent')).toBe('high');
    expect(bucketOf('MEDIUM')).toBe('normal');
    expect(bucketOf(null)).toBe('normal');
    expect(slaFor(open(5, { priority: 'HIGH' }), RULES, NOW).firstResponse.state).toBe('breached');
    expect(slaFor(open(5), RULES, NOW).firstResponse.state).toBe('ok');
  });

  it('moves from on track to at risk to breached as time passes', () => {
    expect(slaFor(open(5), RULES, NOW).firstResponse).toMatchObject({ state: 'ok', targetHours: 8, elapsedHours: 5 });
    expect(slaFor(open(6), RULES, NOW).firstResponse.state).toBe('at_risk'); // 75% of 8h
    expect(slaFor(open(8), RULES, NOW).firstResponse.state).toBe('at_risk'); // exactly on target is not late yet
    expect(slaFor(open(8.1), RULES, NOW).firstResponse.state).toBe('breached');
  });

  it('is met when support replied in time, and a late reply stays on record without raising an open breach', () => {
    const inTime = slaFor(open(30, { firstResponseAt: ago(30 - 3) }), RULES, NOW);
    expect(inTime.firstResponse).toMatchObject({ state: 'met', elapsedHours: 3 });
    const late = slaFor(open(30, { firstResponseAt: ago(30 - 12) }), RULES, NOW);
    expect(late.firstResponse.state).toBe('breached');
    expect(late.openBreach).toBe(false); // answered, and resolution (72h) is still fine
    expect(slaFor(open(80, { firstResponseAt: ago(70) }), RULES, NOW).openBreach).toBe(true); // resolution overdue
  });

  it('flags open tickets close to a target as at risk, but not ones already breached', () => {
    expect(slaFor(open(6), RULES, NOW)).toMatchObject({ openAtRisk: true, openBreach: false });
    expect(slaFor(open(9), RULES, NOW)).toMatchObject({ openAtRisk: false, openBreach: true });
  });

  it('judges a closed ticket against its targets and never as an open breach', () => {
    const quick = slaFor({ priority: 'HIGH', createdAt: ago(40), firstResponseAt: ago(39), closedAt: ago(30), isClosed: true }, RULES, NOW);
    expect(quick.resolution).toMatchObject({ state: 'met', elapsedHours: 10 });
    const slow = slaFor({ priority: 'HIGH', createdAt: ago(100), firstResponseAt: null, closedAt: ago(40), isClosed: true }, RULES, NOW);
    expect(slow.resolution.state).toBe('breached');
    expect(slow.firstResponse.state).toBe('breached'); // no reply recorded: treated as answered at close, 60h in
    expect(slow.openBreach).toBe(false);
  });
});

describe('support SLA alerts', () => {
  const t = (id: string, company: string | null, over: Partial<SupportTicket> = {}): SupportTicket => ({
    ticketId: id, hubspotCompanyId: company, subject: `Ticket ${id}`, createdAt: ago(30), isClosed: false, reopenCount: 0, sentiment: null, priority: 'MEDIUM', firstResponseAt: null, ...over,
  });

  it('raises one alert per customer, high when a high or urgent ticket is late, with the worst ticket named', () => {
    const f = auditSlaBreach([t('a', '1003', { priority: 'HIGH' }), t('b', '1003'), t('c', '1002')], FIXTURE_COMPANIES, NOW, RULES);
    expect(f.map((x) => [x.companyName, x.severity]).sort()).toEqual([['Kano Holdings Group', 'high'], ['Lekki Foods', 'medium']]);
    const kano = f.find((x) => x.companyName === 'Kano Holdings Group')!;
    expect(kano).toMatchObject({ type: 'SUPPORT_SLA_BREACH', entityKey: 'hs:1003', csmEmail: 'tunde.bello@example.com' });
    expect(kano.summary).toMatch(/^2 tickets past the support SLA\./);
    expect(kano.summary).toContain('no reply after 30h (target 4h)');
    expect(kano.summary).toContain('Ticket a');
    expect((kano.details.tickets as unknown[]).length).toBe(2);
  });

  it('stays quiet for answered, closed, on-track and unlinked tickets', () => {
    const f = auditSlaBreach(
      [t('a', '1003', { firstResponseAt: ago(28) }), t('b', '1003', { isClosed: true }), t('c', '1003', { createdAt: ago(2) }), t('d', null), t('e', 'unknown')],
      FIXTURE_COMPANIES, NOW, RULES,
    );
    expect(f).toEqual([]);
  });
});

describe('activity labels', () => {
  it('uses plain words for known events and a readable form for new ones', () => {
    expect(eventLabel('LEAVE_REQUEST')).toBe('Leave requests');
    expect(eventLabel('SIGN_IN')).toBe('Sign-ins');
    expect(eventLabel('BENEFIT_ENROLMENT')).toBe('Benefit enrolment');
  });
});
