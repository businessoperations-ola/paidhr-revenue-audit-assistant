import { describe, expect, it } from 'vitest';
import {
  BroadcastInput,
  buildRecipients,
  filterCompanies,
  findTokens,
  nextRun,
  renderBroadcast,
  richTextToChat,
  richTextToHtml,
  validateBroadcast,
  type AudienceCompany,
  type BroadcastSchedule,
} from '../../src/broadcasts/broadcast-core.js';

const N = (naira: number) => BigInt(naira) * 100n;
const co = (id: string, over: Partial<AudienceCompany> = {}): AudienceCompany => ({
  hubspotId: id, name: `Co ${id}`, csmName: 'Ada', csmEmail: 'ada@x.com', csmOwnerId: '9', arrKobo: N(1_000_000), healthStatus: 'Healthy',
  activeSeats: 40, contractEndDate: '2027-01-31', primaryContactEmail: `hr@co${id}.example`, usesEwa: false, usesStatutory: false, ...over,
});
const input = (over: Partial<BroadcastInput> = {}): BroadcastInput =>
  BroadcastInput.parse({ name: 'n', subject: 'Hello {{company_name}}', body: 'Hi {{csm_name}}', audience: 'clients', channels: ['email'], ...over });

describe('US-23 tokens', () => {
  it('finds tokens in any case and spacing, once each', () => {
    expect(findTokens('Hi {{company_name}}, {{ CSM_NAME }} and {{company_name}} again')).toEqual(['company_name', 'csm_name']);
  });

  it('fills every token for one customer', () => {
    const r = renderBroadcast(
      { subject: 'Update for {{company_name}}', body: 'Your ARR is {{arr_ngn}} for {{active_seats}} seats.' },
      { company_name: 'Lekki Foods', arr_ngn: '₦1,200,000.00', active_seats: '40' },
    );
    expect(r.rendered).toMatchObject({ subject: 'Update for Lekki Foods', text: 'Your ARR is ₦1,200,000.00 for 40 seats.' });
  });

  it('refuses to render when a needed value is missing, naming it', () => {
    const r = renderBroadcast({ subject: 's', body: 'Seats: {{active_seats}} owner {{csm_name}}' }, { csm_name: 'Ada', active_seats: null });
    expect(r).toEqual({ rendered: null, missing: ['active_seats'] });
  });

  it('keeps a value full of markup or markdown from changing the message', () => {
    const r = renderBroadcast({ subject: 's', body: 'Dear **{{company_name}}** and {{csm_name}}' }, { company_name: '<b>Evil</b> & _Co_', csm_name: '*x*' });
    expect(r.rendered!.html).toContain('<strong>&lt;b&gt;Evil&lt;/b&gt; &amp; _Co_</strong>');
    expect(r.rendered!.html).not.toContain('<b>');
    // Two tokens containing underscores must not be read as italic around the text between them.
    const two = renderBroadcast({ subject: 's', body: '{{csm_name}} and {{arr_ngn}}' }, { csm_name: 'A', arr_ngn: 'B' });
    expect(two.rendered!.html).toContain('A and B');
    expect(two.rendered!.html).not.toContain('<em>');
  });
});

describe('rich text (a safe subset)', () => {
  it('renders paragraphs, bullets, bold, italic and http(s) links, and escapes everything else', () => {
    const html = richTextToHtml('Hello **team**,\nsee _this_ [guide](https://paidhr.com/help).\n\n- one\n- two\n\n<script>alert(1)</script>');
    expect(html).toContain('<strong>team</strong>');
    expect(html).toContain('<em>this</em>');
    expect(html).toContain('<a href="https://paidhr.com/help"');
    expect(html).toContain('<ul');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('does not turn javascript: or other schemes into links', () => {
    const html = richTextToHtml('[click](javascript:alert(1)) and [ok](http://a.example/x?y=1&z=2)');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="http://a.example/x?y=1&amp;z=2"');
  });

  it('converts to Google Chat syntax and drops typed angle brackets', () => {
    expect(richTextToChat('**Bold** <b>x</b> [link](https://a.example)\n- item')).toBe('*Bold* bx/b <https://a.example|link>\n• item');
  });
});

describe('validation', () => {
  it('limits channels per audience: clients get email only', () => {
    expect(validateBroadcast(input({ channels: ['email', 'google_chat'] }))).toMatch(/Client broadcasts cannot use: google_chat/);
    expect(validateBroadcast(input({ audience: 'csms', channels: ['email', 'google_chat', 'hubspot_task'] }))).toBeNull();
    expect(validateBroadcast(input({ audience: 'cx_team', subject: 's', body: 'b', channels: ['hubspot_task'] }))).toMatch(/cannot use: hubspot_task/);
  });
  it('rejects unknown tokens and tokens for the CX team', () => {
    expect(validateBroadcast(input({ body: 'Hi {{ceo_name}}' }))).toMatch(/Unknown token: \{\{ceo_name\}\}/);
    expect(validateBroadcast(input({ audience: 'cx_team', channels: ['email'] }))).toMatch(/cannot be used when writing to the CX team/);
    expect(validateBroadcast(input({ audience: 'cx_team', subject: 'Notice', body: 'All hands', channels: ['email'] }))).toBeNull();
  });
  it('rejects an inverted ARR range', () => {
    expect(validateBroadcast(input({ filters: { arrMinNgn: 10, arrMaxNgn: 5 } }))).toMatch(/Minimum ARR/);
  });
});

describe('US-21 audience filters', () => {
  const companies = [
    co('1', { healthStatus: 'At Risk', arrKobo: N(500_000), usesEwa: true }),
    co('2', { healthStatus: 'Healthy', arrKobo: N(2_000_000), csmEmail: 'bo@x.com' }),
    co('3', { healthStatus: null, arrKobo: null }),
  ];
  const ids = (f: Parameters<typeof filterCompanies>[1]) => filterCompanies(companies, f).map((c) => c.hubspotId);

  it('filters by health, CSM, ARR range and module use, all combined', () => {
    expect(ids({})).toEqual(['1', '2', '3']);
    expect(ids({ health: ['at risk'] })).toEqual(['1']);
    expect(ids({ csm: ['BO@x.com'] })).toEqual(['2']);
    expect(ids({ arrMinNgn: 1_000_000 })).toEqual(['2']);
    expect(ids({ arrMaxNgn: 1_000_000 })).toEqual(['1']); // no ARR means it cannot match a range
    expect(ids({ ewa: 'used' })).toEqual(['1']);
    expect(ids({ ewa: 'not_used', health: ['Healthy'] })).toEqual(['2']);
  });

  it('builds one row per client contact, splitting several addresses and skipping bad ones with a reason', () => {
    const rows = buildRecipients('clients', ['email'], [co('1', { primaryContactEmail: 'a@x.com; B@x.com, a@x.com' }), co('2', { primaryContactEmail: null }), co('3', { primaryContactEmail: 'not-an-email' })], [], {});
    expect(rows.map((r) => [r.company!.hubspotId, r.recipient, r.skipReason ?? null])).toEqual([
      ['1', 'a@x.com', null], ['1', 'b@x.com', null], ['2', '(none)', 'No contact email in HubSpot'], ['3', '(none)', 'Contact email is not valid'],
    ]);
  });

  it('sends CSM broadcasts to each CSM per account, as email, one chat post per account, and a HubSpot task', () => {
    const rows = buildRecipients('csms', ['email', 'google_chat', 'hubspot_task'], [co('1'), co('2', { csmEmail: null })], [], {});
    expect(rows.map((r) => [r.channel, r.recipient, r.skipReason ?? null])).toEqual([
      ['email', 'ada@x.com', null], ['google_chat', 'space:default', null], ['hubspot_task', 'ada@x.com', null],
      ['email', '(none)', 'No CSM assigned'], ['google_chat', 'space:default', null], ['hubspot_task', 'unassigned', null],
    ]);
  });

  it('sends CX-team broadcasts to app users by role, with one shared chat post', () => {
    const users = [{ email: 'a@x.com', role: 'csm' }, { email: 'b@x.com', role: 'viewer' }, { email: 'c@x.com', role: 'cs_director' }];
    expect(buildRecipients('cx_team', ['email', 'google_chat'], [], users, { roles: ['csm', 'cs_director'] }).map((r) => [r.channel, r.recipient])).toEqual([
      ['email', 'a@x.com'], ['email', 'c@x.com'], ['google_chat', 'space:default'],
    ]);
  });
});

describe('US-22 schedules (West Africa Time)', () => {
  const at = (s: string) => new Date(s);
  const next = (s: BroadcastSchedule, after: string) => nextRun(s, at(after))?.toISOString();

  it('weekly: Monday 08:00 WAT is Monday 07:00 UTC, and rolls to the following week once passed', () => {
    const s: BroadcastSchedule = { kind: 'weekly', dayOfWeek: 1, time: '08:00' };
    expect(next(s, '2026-11-03T10:00:00Z')).toBe('2026-11-09T07:00:00.000Z'); // from a Tuesday
    expect(next(s, '2026-11-09T06:59:00Z')).toBe('2026-11-09T07:00:00.000Z'); // a minute before
    expect(next(s, '2026-11-09T07:00:00Z')).toBe('2026-11-16T07:00:00.000Z'); // exactly at the time: next week
  });

  it('monthly: the 1st at 08:00 WAT, across a year end', () => {
    const s: BroadcastSchedule = { kind: 'monthly', dayOfMonth: 1, time: '08:00' };
    expect(next(s, '2026-12-15T00:00:00Z')).toBe('2027-01-01T07:00:00.000Z');
    expect(next(s, '2026-11-01T06:00:00Z')).toBe('2026-11-01T07:00:00.000Z');
  });

  it('uses the WAT date, not the UTC date: 23:30 UTC is already tomorrow in Lagos', () => {
    const s: BroadcastSchedule = { kind: 'monthly', dayOfMonth: 1, time: '00:30' };
    // 30 Nov 23:30 UTC = 1 Dec 00:30 WAT, which is exactly 00:30 on the 1st, so the next one is January.
    expect(next(s, '2026-11-30T23:30:00Z')).toBe('2026-12-31T23:30:00.000Z'); // 1 Jan 00:30 WAT
  });

  it('quarterly: every third month from the start month', () => {
    const s: BroadcastSchedule = { kind: 'quarterly', dayOfMonth: 5, startMonth: 2, time: '09:00' }; // Feb, May, Aug, Nov
    expect(next(s, '2026-11-06T00:00:00Z')).toBe('2027-02-05T08:00:00.000Z');
    expect(next(s, '2026-11-01T00:00:00Z')).toBe('2026-11-05T08:00:00.000Z');
    expect(next(s, '2027-02-05T08:00:00Z')).toBe('2027-05-05T08:00:00.000Z');
  });

  it('once: returns the time while it is ahead, and null after', () => {
    const s: BroadcastSchedule = { kind: 'once', runAt: '2026-12-01T07:00:00.000Z' };
    expect(next(s, '2026-11-30T00:00:00Z')).toBe('2026-12-01T07:00:00.000Z');
    expect(next(s, '2026-12-01T07:00:00Z')).toBeUndefined();
  });
});
