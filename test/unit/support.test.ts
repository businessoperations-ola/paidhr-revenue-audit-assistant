import { describe, expect, it, vi } from 'vitest';
import { ackSignature, ackUrl, verifyAck } from '../../src/alerts/ack-link.js';
import { chatMessage, emailBody, emailSubject, escalationHtml, escalationNote } from '../../src/alerts/message-format.js';
import type { StoredFlag } from '../../src/audits/flag.repository.js';
import { BusinessCalendar, addMonthsClamped, todayInLagos } from '../../src/common/calendar.js';
import { formatNgn, parseNgnToKobo } from '../../src/common/money.js';
import { loadConfig } from '../../src/config/config.js';
import { HubSpotClient } from '../../src/sources/hubspot/hubspot.client.js';
import { mapAccountRow } from '../../src/sources/control-panel/control-panel.repository.js';

describe('money', () => {
  it('parses Naira strings exactly into kobo', () => {
    expect(parseNgnToKobo('1,200,000.50')).toBe(120000050n);
    expect(parseNgnToKobo('₦ 2500')).toBe(250000n);
    expect(parseNgnToKobo('NGN99.9')).toBe(9990n);
    expect(parseNgnToKobo(0.1 + 0.2)).toBe(30n);
    expect(parseNgnToKobo('12.345')).toBeNull();
    expect(parseNgnToKobo('abc')).toBeNull();
    expect(parseNgnToKobo('')).toBeNull();
  });
  it('formats kobo as Naira', () => {
    expect(formatNgn(144000000n)).toBe('₦1,440,000.00');
    expect(formatNgn(-5n)).toBe('-₦0.05');
  });
});

describe('calendar', () => {
  it('uses Lagos time for "today"', () => {
    expect(todayInLagos(new Date('2026-11-03T23:30:00Z'))).toBe('2026-11-04');
  });
  it('clamps month ends', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('counts business days around weekends and holidays', () => {
    const cal = new BusinessCalendar(['2026-10-01']);
    expect(cal.addBusinessDays('2026-09-30', 1)).toBe('2026-10-02'); // skips the holiday
    expect(cal.addBusinessDays('2026-10-02', 1)).toBe('2026-10-05'); // skips the weekend
    expect(cal.businessDaysBetween('2026-09-30', '2026-10-05')).toBe(2);
  });
});

describe('ack links', () => {
  it('only verify for the flag they were made for', () => {
    const sig = ackSignature('secret-secret-123', 7);
    expect(verifyAck('secret-secret-123', 7, sig)).toBe(true);
    expect(verifyAck('secret-secret-123', 8, sig)).toBe(false);
    expect(verifyAck('other-secret-1234', 7, sig)).toBe(false);
    expect(verifyAck('secret-secret-123', 7, 'short')).toBe(false);
    expect(ackUrl('https://audit.example/', 'secret-secret-123', 7)).toBe(`https://audit.example/ack/7?sig=${sig}`);
  });
});

describe('message formatting', () => {
  const flag = (over: Partial<StoredFlag>): StoredFlag => ({
    id: 1, type: 'ARR_MISMATCH', entityKey: 'hs:1', status: 'open', severity: 'high', hubspotCompanyId: '1',
    controlPanelId: 'c', companyName: 'Acme <Ltd>', csmEmail: 'ada@x.com', summary: 'ARR off by ₦5', details: {},
    aiRationale: null, firstSeenAt: '', acknowledgedAt: null, acknowledgedBy: null, notifiedAt: null, escalationLevel: 0, escalatedAt: null, escalatedOn: null, ...over,
  });
  const ack = (id: number) => `https://a/ack/${id}`;

  it('escapes HTML in email and strips angle brackets in chat', () => {
    const { html } = emailBody('ada@x.com', [flag({})], ack);
    expect(html).toContain('Acme &lt;Ltd&gt;');
    expect(html).not.toContain('Acme <Ltd>');
    expect(chatMessage('ada@x.com', [flag({})], ack)).toContain('*Acme Ltd*');
  });

  it('marks urgent subjects and includes the AI next step when present', () => {
    const urgent = flag({ id: 2, type: 'LATE_PAYROLL', severity: 'urgent', companyName: 'Lekki Foods' });
    expect(emailSubject([urgent])).toBe('URGENT: Payroll run is late at Lekki Foods');
    const withAi = flag({ aiRationale: { explanation: 'e', likely_cause: 'c', recommended_action: 'Update the deal ARR', model: 'm' } });
    expect(chatMessage(null, [withAi], ack)).toContain('_Next step:_ Update the deal ARR');
    expect(chatMessage(null, [withAi], ack)).toContain('unassigned accounts');
  });

  it('renders branded HTML email with the hosted logo and blue Acknowledge buttons', () => {
    const { html } = emailBody('a@x.com', [flag({ severity: 'urgent', type: 'LATE_PAYROLL' })], ack, 'Footer note', 'https://audit.example.com/brand/paidhr-logo-white.png');
    expect(html).toContain('src="https://audit.example.com/brand/paidhr-logo-white.png"');
    expect(html).toContain('background:#004AF5'); // brand blue header and buttons
    expect(html).toContain('background:#FDC023'); // yellow rule
    expect(html).toContain('Urgent: action needed');
    expect(html).toContain('href="https://a/ack/1"');
    expect(html).toContain('Footer note');
    // Without a logo URL it falls back to the word mark.
    expect(emailBody('a@x.com', [flag({})], ack).html).toContain('>PaidHR</span>');
    const esc = escalationHtml('director_no_lead', 'ada@x.com', [{ flag: flag({}), businessDaysWaiting: 3 }], ack, null);
    expect(esc).toContain('Director escalation');
    expect(esc).toContain('has no team lead on record');
    expect(esc).toContain('Open 3 business days, not acknowledged.');
  });

  it('only promises escalation for flags that actually escalate', () => {
    const rules = { severities: ['urgent', 'high'], businessDays: 3 };
    const note = escalationNote([flag({ severity: 'high' })], rules);
    expect(note).toBe('If urgent and high alerts are not acknowledged within 3 business days, they go to your team lead, or to the CS Directors if you have none on record.');
    expect(emailBody('a@x.com', [flag({})], ack, note).text).toContain(note!);
    expect(escalationNote([flag({ severity: 'low' })], rules)).toBeNull();
    expect(emailBody('a@x.com', [flag({ severity: 'low' })], ack, null).text).not.toContain('team lead');
  });
});

describe('config', () => {
  it('refuses unsafe production settings', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', NODE_ENV: 'production', AUTH_DISABLED: 'true' })).toThrow(/AUTH_DISABLED/);
    expect(() => loadConfig({ DATABASE_URL: 'x', NODE_ENV: 'production' })).toThrow(/ACK_LINK_SECRET/);
    expect(loadConfig({ DATABASE_URL: 'x', ALERT_CHANNELS: 'email, google_chat' }).ALERT_CHANNELS).toEqual(['email', 'google_chat']);
  });
});

describe('Control Panel row mapping', () => {
  it('normalises ids, frequencies and dates', () => {
    expect(
      mapAccountRow({
        client_id: 12, parent_client_id: null, name: 'A', is_active: true, active_users: '7', contractor_users: 1,
        pay_frequency: 'semi-monthly', pay_day: null, last_payroll_pay_date: new Date('2026-10-31T00:00:00Z'),
        last_payroll_completed_at: null,
      }),
    ).toMatchObject({ clientId: '12', activeUsers: 7, payFrequency: 'SEMI_MONTHLY', lastPayrollPayDate: '2026-10-31' });
    expect(mapAccountRow({ client_id: 'x', parent_client_id: 'p', name: 'B', is_active: true, active_users: 0, contractor_users: 0, pay_frequency: 'fortnightly', pay_day: null, last_payroll_pay_date: null, last_payroll_completed_at: null }).payFrequency).toBeNull();
  });
});

describe('HubSpot client', () => {
  const cfg = loadConfig({ DATABASE_URL: 'x', HUBSPOT_TOKEN: 'pat-test' });

  function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  it('pages through companies, maps properties and resolves owner emails', async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.includes('/owners')) return json({ results: [{ id: '77', email: 'Ngozi@X.com' }] });
      const after = calls.filter((c) => c.url.includes('/search')).length;
      if (after === 1) {
        return json({
          results: [{ id: '1', properties: { name: 'Acme', hubspot_owner_id: '77', arr_ngn: '1440000', price_per_seat_monthly_ngn: '3000', paid_seats: '40', contract_end_date: '1798675200000', control_panel_id: ' CP-1 ' } }],
          paging: { next: { after: 'abc' } },
        });
      }
      return json({ results: [{ id: '2', properties: { name: 'Beta', csm_email: 'Tunde@X.com' } }] });
    });
    const client = new HubSpotClient(cfg, fetchFn as typeof fetch, async () => {});
    const companies = await client.fetchActiveCustomers();

    expect(companies).toHaveLength(2);
    expect(companies[0]).toMatchObject({ hubspotId: '1', csmEmail: 'ngozi@x.com', csmOwnerId: '77', controlPanelId: 'CP-1', paidSeats: 40, arrKobo: 144000000n, contractEndDate: '2026-12-31' });
    expect(companies[1]).toMatchObject({ csmEmail: 'tunde@x.com', arrKobo: null });
    const searches = calls.filter((c) => c.url.includes('/search'));
    expect(searches[1]?.body.after).toBe('abc');
    expect(searches[0]?.body.filterGroups[0].filters[0]).toEqual({ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' });
  });

  it('retries on 429 using Retry-After, then fails clearly on 4xx', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({ id: 'task-9' })));
    const client = new HubSpotClient(cfg, fetchFn as unknown as typeof fetch, async (ms) => void sleeps.push(ms));
    const id = await client.createTask({ companyId: '1', ownerId: '77', subject: 's', body: 'b', priority: 'HIGH', dueAt: new Date('2026-11-03T16:00:00Z') });
    expect(id).toBe('task-9');
    expect(sleeps).toEqual([2000]);
    const sent = JSON.parse(String((fetchFn.mock.calls[1] as any)[1].body));
    expect(sent.properties).toMatchObject({ hubspot_owner_id: '77', hs_task_priority: 'HIGH' });
    expect(sent.associations[0].types[0].associationTypeId).toBe(192);

    const failing = new HubSpotClient(cfg, (async () => json({ message: 'bad' }, 400)) as unknown as typeof fetch, async () => {});
    await expect(failing.createTask({ companyId: '1', ownerId: null, subject: 's', body: 'b', priority: 'LOW', dueAt: new Date() })).rejects.toThrow(/400/);
  });
});
