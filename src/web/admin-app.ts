import { FLAG_TITLES } from '../alerts/message-format.js';
import { MANDATORY_FIELDS } from '../audits/hygiene.audit.js';

/**
 * The admin web app (phase 2): alert inbox, rules, team leads, reconciliation.
 * Plain HTML + JS served by the API at "/". It signs in with Google Identity
 * Services and calls the API with the Google ID token, the same as any client.
 * All data is written with textContent, never innerHTML, so CRM text can't inject markup.
 */
export const ADMIN_APP_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit Assistant</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {
  --bg: #f6f7f8; --surface: #fff; --ink: #15201d; --muted: #5b6b67; --line: #dde3e1;
  --accent: #0d6b5a; --accent-soft: #e2f1ec;
  --urgent: #b42318; --urgent-soft: #fdecea; --high: #b54708; --high-soft: #fdf1e3;
  --medium: #8a6d00; --medium-soft: #fbf5d8; --low: #475467; --low-soft: #eef1f4;
  --font: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #0f1514; --surface: #171f1d; --ink: #e7eeec; --muted: #9aaba6; --line: #2a3634;
  --accent: #4cc2a6; --accent-soft: #15302a; --urgent: #f97066; --urgent-soft: #3a1714;
  --high: #f7a35c; --high-soft: #3a2412; --medium: #e3c34a; --medium-soft: #332c0e; --low: #a5b2c2; --low-soft: #222a33;
  color-scheme: dark; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--font); }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; padding: 12px max(16px, 3vw); background: var(--surface); border-bottom: 1px solid var(--line); }
header h1 { font-size: 16px; margin: 0; font-weight: 600; }
nav { display: flex; gap: 4px; flex-wrap: wrap; }
nav button { font: 500 14px var(--font); padding: 6px 12px; border-radius: 6px; border: 0; background: none; color: var(--muted); cursor: pointer; }
nav button[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
.who { margin-left: auto; font-size: 13px; color: var(--muted); display: flex; gap: 10px; align-items: center; }
main { padding: 20px max(16px, 3vw) 48px; max-width: 1200px; margin: 0 auto; display: grid; gap: 16px; }
main > * { min-width: 0; }
.who { flex-wrap: wrap; }
h2 { font-size: 20px; margin: 0; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
select, input, button.btn { font: 14px var(--font); padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
button.btn { cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--surface); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 760px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font: 500 12px var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg); }
.chip { display: inline-block; font: 600 11.5px var(--font); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.chip.sev { text-transform: capitalize; }
.urgent { color: var(--urgent); background: var(--urgent-soft); } .high { color: var(--high); background: var(--high-soft); }
.medium { color: var(--medium); background: var(--medium-soft); } .low { color: var(--low); background: var(--low-soft); }
.esc { color: var(--urgent); background: var(--urgent-soft); }
.ok { color: var(--accent); background: var(--accent-soft); }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.detail { padding: 16px; display: grid; gap: 10px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.rule { padding: 16px; display: grid; gap: 8px; align-content: start; }
.rule h3 { font-size: 14px; margin: 0; font-family: var(--mono); }
.rule .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.notice { padding: 10px 14px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); }
.notice.err { background: var(--urgent-soft); color: var(--urgent); }
.signin { display: grid; place-items: center; gap: 16px; padding: 80px 16px; text-align: center; }
.stat { padding: 14px 16px; display: grid; gap: 2px; }
.stat b { font-size: 24px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<header>
  <h1>Audit Assistant</h1>
  <nav id="nav" hidden>
    <button data-view="alerts" aria-current="page">Alerts</button>
    <button data-view="rules">Rules</button>
    <button data-view="teams">Team leads</button>
    <button data-view="recon">Reconciliation</button>
  </nav>
  <div class="who" id="who"></div>
</header>
<main>
  <div id="notice" class="notice" role="status" hidden></div>
  <section id="signin" class="signin" hidden>
    <h2>Sign in with your company Google account</h2>
    <div id="gbtn"></div>
  </section>

  <section id="view-alerts" hidden>
    <div class="bar" style="margin-bottom:12px">
      <h2 style="margin-right:auto">Alerts</h2>
      <label class="small">Status <select id="f-status"><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select></label>
      <label class="small">Type <select id="f-type"><option value="">All types</option></select></label>
      <label class="small"><input type="checkbox" id="f-esc"> Escalated only</label>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Level</th><th>Company</th><th>Problem</th><th>CSM</th><th>First seen</th><th>State</th></tr></thead>
        <tbody id="flags"></tbody>
      </table>
    </div>
    <div class="card detail" id="detail" hidden style="margin-top:16px"></div>
  </section>

  <section id="view-rules" hidden>
    <h2>Rules</h2>
    <p class="muted small" id="rules-note"></p>
    <div class="grid2" id="rules"></div>
  </section>

  <section id="view-teams" hidden>
    <h2>Team leads</h2>
    <p class="muted small">Unacknowledged urgent and high alerts go to the CSM's team lead, then to every CS Director. A CSM with no team lead escalates straight to the directors.</p>
    <form class="bar card" id="team-form" style="padding:12px;margin:12px 0" hidden>
      <input id="team-csm" type="email" placeholder="CSM email" required aria-label="CSM email">
      <input id="team-lead" type="email" placeholder="Team lead email" required aria-label="Team lead email">
      <button class="btn primary" type="submit">Save</button>
    </form>
    <div class="card table-wrap"><table><thead><tr><th>CSM</th><th>Team lead</th><th>Changed</th><th></th></tr></thead><tbody id="teams"></tbody></table></div>
  </section>

  <section id="view-recon" hidden>
    <h2>Reconciliation</h2>
    <p class="muted small" id="recon-date"></p>
    <div class="grid2" id="recon" style="margin-top:12px"></div>
    <h2 style="margin-top:20px;font-size:16px">Accounts with sub-accounts</h2>
    <div class="card table-wrap" style="margin-top:8px"><table><thead><tr><th>Parent account</th><th>Sub-accounts</th><th>Active users</th></tr></thead><tbody id="tree"></tbody></table></div>
  </section>
</main>

<script>
const TITLES = ${JSON.stringify(FLAG_TITLES)};
const FIELDS = ${JSON.stringify(Object.keys(MANDATORY_FIELDS))};
// Display order: engagement and escalation first (what CS leadership tunes), then billing.
const RULE_LABELS = {
  inactivity_days_by_health: 'Max days without contact, by health status',
  escalation_business_days: 'Escalate to team lead after (business days)',
  director_escalation_business_days: 'Then to directors after (business days)',
  escalate_severities: 'Alert levels that escalate',
  payroll_grace_business_days: 'Late payroll grace (business days)',
  arr_tolerance_kobo: 'ARR tolerance (kobo; 1 = ₦0.01)',
  mandatory_fields: 'Mandatory HubSpot fields',
  seat_history_days: 'Seat history to compare (days)',
};
const state = { token: null, me: null, view: 'alerts' };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
}
const $ = (id) => document.getElementById(id);
function notice(text, isError) {
  const n = $('notice'); n.textContent = text; n.className = 'notice' + (isError ? ' err' : ''); n.hidden = !text;
  if (text && !isError) setTimeout(() => { if (n.textContent === text) n.hidden = true; }, 4000);
}
function store(key, value) { try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {} }
function recall(key) { try { return sessionStorage.getItem(key); } catch { return null; } }

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { signOut('Your sign-in expired. Please sign in again.'); throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || ('Request failed: ' + res.status));
  return body;
}

function signOut(message) {
  state.token = null; state.me = null; store('idToken', null);
  $('nav').hidden = true; $('who').textContent = '';
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = true));
  $('signin').hidden = false;
  if (message) notice(message, true);
}

async function start() {
  const cfg = await fetch('/app-config').then((r) => r.json());
  if (cfg.authDisabled) return enter();
  state.token = recall('idToken');
  if (state.token) { try { return await enter(); } catch { /* fall through to sign-in */ } }
  $('signin').hidden = false;
  if (!cfg.googleClientId) { notice('Google sign-in is not configured (GOOGLE_OAUTH_CLIENT_ID).', true); return; }
  const s = el('script', { src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = () => {
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (r) => { state.token = r.credential; store('idToken', r.credential); enter().catch((e) => notice(e.message, true)); } });
    google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', text: 'signin_with' });
  };
  document.head.append(s);
}

async function enter() {
  state.me = await api('/me');
  $('signin').hidden = true; $('nav').hidden = false; notice('');
  $('who').replaceChildren(el('span', {}, state.me.email + ' · ' + state.me.role.replace(/_/g, ' ')),
    el('button', { class: 'btn', onclick: () => signOut() }, 'Sign out'));
  show(location.hash.slice(1) || 'alerts');
}

function show(view) {
  if (!['alerts', 'rules', 'teams', 'recon'].includes(view)) view = 'alerts';
  state.view = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  for (const v of ['alerts', 'rules', 'teams', 'recon']) $('view-' + v).hidden = v !== view;
  ({ alerts: loadFlags, rules: loadRules, teams: loadTeams, recon: loadRecon })[view]().catch((e) => e.message !== 'unauthorized' && notice(e.message, true));
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });
window.addEventListener('hashchange', () => state.me && show(location.hash.slice(1)));

/* ---------- Alerts ---------- */
for (const [k, v] of Object.entries(TITLES)) $('f-type').append(el('option', { value: k }, v));
['f-status', 'f-type', 'f-esc'].forEach((id) => $(id).addEventListener('change', () => loadFlags().catch((e) => notice(e.message, true))));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }) : '–';
const canAck = () => ['csm', 'cs_team_lead', 'cs_director', 'super_admin'].includes(state.me.role);

function stateChip(f) {
  if (f.status === 'resolved') return el('span', { class: 'chip ok' }, 'resolved');
  if (f.escalationLevel === 2) return el('span', { class: 'chip esc' }, 'with directors');
  if (f.escalationLevel === 1) return el('span', { class: 'chip esc' }, 'with team lead');
  if (f.acknowledgedAt) return el('span', { class: 'chip ok' }, 'acknowledged');
  return el('span', { class: 'chip low' }, f.notifiedAt ? 'awaiting CSM' : 'not sent yet');
}

async function loadFlags() {
  const q = new URLSearchParams({ status: $('f-status').value });
  if ($('f-type').value) q.set('type', $('f-type').value);
  if ($('f-esc').checked) q.set('escalated', 'true');
  const flags = await api('/flags?' + q);
  $('detail').hidden = true;
  $('flags').replaceChildren(...(flags.length ? flags.map((f) => el('tr', { tabindex: '0', onclick: () => openFlag(f.id), onkeydown: (e) => e.key === 'Enter' && openFlag(f.id) },
    el('td', {}, el('span', { class: 'chip sev ' + f.severity }, f.severity)),
    el('td', {}, el('strong', {}, f.companyName)),
    el('td', {}, TITLES[f.type] || f.type, el('div', { class: 'muted small' }, f.summary)),
    el('td', { class: 'small' }, f.csmEmail || el('span', { class: 'muted' }, 'unassigned')),
    el('td', { class: 'small' }, fmtDate(f.firstSeenAt)),
    el('td', {}, stateChip(f)),
  )) : [el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'No alerts match these filters.'))]));
}

async function openFlag(id) {
  const f = await api('/flags/' + id);
  const box = $('detail');
  const ack = el('button', { class: 'btn primary', onclick: async () => {
    await api('/flags/' + id + '/acknowledge', { method: 'POST' }); notice('Acknowledged'); await loadFlags(); openFlag(id);
  } }, 'Acknowledge');
  ack.hidden = !!f.acknowledgedAt || f.status !== 'open' || !canAck();
  box.replaceChildren(...[
    el('div', { class: 'bar' }, el('h2', { style: 'margin-right:auto' }, f.companyName + ': ' + (TITLES[f.type] || f.type)), stateChip(f), ack),
    el('p', {}, f.summary),
    f.aiRationale ? el('p', { class: 'small' }, el('strong', {}, 'Why: '), f.aiRationale.explanation, el('br'), el('strong', {}, 'Next step: '), f.aiRationale.recommended_action) : null,
    el('p', { class: 'small muted' }, 'Flag #' + f.id + ' · first seen ' + fmtDate(f.firstSeenAt) + (f.acknowledgedAt ? ' · acknowledged by ' + f.acknowledgedBy : '')),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Sent as', 'Channel', 'To', 'Status', 'When'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...f.alerts.map((a) => el('tr', {}, el('td', { class: 'small' }, a.kind.replace('escalation_', 'escalation → ').replace('notify', 'first alert')), el('td', { class: 'small' }, a.channel.replace('_', ' ')),
        el('td', { class: 'mono' }, a.recipient), el('td', {}, el('span', { class: 'chip ' + (a.status === 'sent' ? 'ok' : a.status === 'failed' ? 'urgent' : 'low') }, a.status)),
        el('td', { class: 'small' }, a.sent_at ? new Date(a.sent_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : (a.error || '–'))))))),
    f.alerts.length ? null : el('p', { class: 'small muted' }, 'Nothing has been sent for this alert yet.'),
  ].filter(Boolean));
  box.hidden = false; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- Rules ---------- */
async function loadRules() {
  const rules = await api('/rules');
  const editable = state.me.role === 'super_admin';
  $('rules-note').textContent = editable ? 'Changes apply from the next audit run and are logged with your name.' : 'Only super admins can change rules.';
  const order = Object.keys(RULE_LABELS);
  rules.sort((a, b) => (order.indexOf(a.key) + 99) % 99 - (order.indexOf(b.key) + 99) % 99);
  $('rules').replaceChildren(...rules.map((r) => ruleCard(r, editable)));
}

function ruleCard(r, editable) {
  let read;
  const body = el('div', { style: 'display:grid;gap:8px' });
  if (r.key === 'inactivity_days_by_health') {
    const rows = Object.entries(r.value).map(([k, v]) => [el('input', { value: k, 'aria-label': 'Health status', disabled: !editable || k === 'default' }), el('input', { type: 'number', min: '1', value: v, style: 'width:80px', 'aria-label': 'Days', disabled: !editable })]);
    const list = el('div', { style: 'display:grid;gap:6px' });
    const render = () => list.replaceChildren(...rows.map(([a, b]) => el('div', { class: 'row' }, a, b, el('span', { class: 'small muted' }, 'days'))));
    render();
    body.append(list);
    if (editable) body.append(el('button', { class: 'btn', type: 'button', onclick: () => { rows.push([el('input', { placeholder: 'Health status', 'aria-label': 'Health status' }), el('input', { type: 'number', min: '1', value: '14', style: 'width:80px', 'aria-label': 'Days' })]); render(); } }, 'Add health status'));
    read = () => Object.fromEntries(rows.filter(([a]) => a.value.trim()).map(([a, b]) => [a.value.trim(), Number(b.value)]));
  } else if (Array.isArray(r.value)) {
    const options = r.key === 'escalate_severities' ? ['urgent', 'high', 'medium', 'low'] : FIELDS;
    const boxes = options.map((o) => el('label', { class: 'row small' }, el('input', { type: 'checkbox', value: o, checked: r.value.includes(o), disabled: !editable }), o));
    body.append(...boxes);
    read = () => boxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
  } else {
    const input = el('input', { type: 'number', value: r.value, min: '0', style: 'width:120px', disabled: !editable, 'aria-label': RULE_LABELS[r.key] || r.key });
    body.append(input);
    read = () => Number(input.value);
  }
  const save = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
    try { await api('/rules/' + r.key, { method: 'PUT', body: JSON.stringify({ value: read() }) }); notice('Saved: ' + (RULE_LABELS[r.key] || r.key)); loadRules(); }
    catch (e) { if (e.message !== 'unauthorized') notice(e.message, true); }
  } }, 'Save');
  save.hidden = !editable;
  return el('div', { class: 'card rule' }, el('strong', {}, RULE_LABELS[r.key] || r.key), el('span', { class: 'small muted' }, r.description), body,
    el('div', { class: 'row' }, save, el('span', { class: 'small muted' }, 'Last changed by ' + r.updated_by + ', ' + fmtDate(r.updated_at))));
}

/* ---------- Team leads ---------- */
async function loadTeams() {
  const canEdit = ['super_admin', 'cs_director'].includes(state.me.role);
  $('team-form').hidden = !canEdit;
  const rows = await api('/team');
  $('teams').replaceChildren(...(rows.length ? rows.map((t) => el('tr', {},
    el('td', {}, t.csmEmail), el('td', {}, t.teamLeadEmail), el('td', { class: 'small muted' }, t.updatedBy + ', ' + fmtDate(t.updatedAt)),
    el('td', {}, canEdit ? el('button', { class: 'btn', onclick: async (e) => { e.stopPropagation(); await api('/team/' + encodeURIComponent(t.csmEmail), { method: 'DELETE' }); notice('Removed'); loadTeams(); } }, 'Remove') : null),
  )) : [el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No team leads set. Escalations go straight to the CS Directors.'))]));
}
$('team-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/team/' + encodeURIComponent($('team-csm').value.trim()), { method: 'PUT', body: JSON.stringify({ teamLeadEmail: $('team-lead').value.trim() }) });
    notice('Saved'); $('team-form').reset(); loadTeams();
  } catch (err) { if (err.message !== 'unauthorized') notice(err.message, true); }
});

/* ---------- Reconciliation ---------- */
async function loadRecon() {
  let run;
  try { run = await api('/reports/latest'); } catch (e) { $('recon').replaceChildren(el('p', { class: 'muted' }, e.message)); return; }
  const r = run.summary.reconciliation;
  $('recon-date').textContent = 'From the audit run on ' + fmtDate(run.run_date) + '.';
  const stat = (label, n, note) => el('div', { class: 'card stat' }, el('b', {}, n), el('span', {}, label), el('span', { class: 'small muted' }, note));
  $('recon').replaceChildren(
    stat('Matched', r.matched, 'HubSpot customer linked to an active Control Panel account'),
    stat('HubSpot only', r.hubspotOnly, 'No Control Panel ID on the HubSpot company'),
    stat('Control Panel only', r.controlPanelOnly, 'Active account with no HubSpot customer'),
    stat('Broken links', r.brokenLinks, 'Linked to an inactive or unknown account'),
  );
  const tree = run.summary.hierarchy || [];
  $('tree').replaceChildren(...(tree.length ? tree.map((h) => el('tr', {}, el('td', {}, h.parentName, el('div', { class: 'mono muted' }, h.parentClientId)), el('td', {}, h.subAccountCount), el('td', {}, h.totalActiveUsers))) : [el('tr', {}, el('td', { colspan: '3', class: 'muted' }, 'No accounts with sub-accounts.'))]));
}

start().catch((e) => notice(e.message, true));
</script>
</body>
</html>`;
