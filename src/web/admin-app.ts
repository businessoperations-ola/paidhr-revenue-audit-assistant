import { FLAG_TITLES } from '../alerts/message-format.js';
import { MANDATORY_FIELDS } from '../audits/hygiene.audit.js';
import { INSIGHTS_HTML, INSIGHTS_JS } from './admin-app-insights.js';
import { LOGO_BLUE_DATA_URI, LOGO_WHITE_DATA_URI } from './brand/logos.js';

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
<title>CX Internal tool</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>
/*
 * PaidHR brand, sampled from paidhr.com: brand blue #004AF5 / #154BF5, navy headings #012B86,
 * nav navy #0B2D74, midnight #0B1A3C, yellow #FDC023, page #F6F7FF, icon circles #D7E4FF.
 * Type: Gilroy (PaidHR's licensed font) when installed, else Plus Jakarta Sans.
 * Light only, like PaidHR's own product.
 */
:root {
  --blue: #004af5; --blue-2: #154bf5; --blue-hover: #003ccc; --blue-soft: #d7e4ff; --blue-faint: #eef3ff;
  --navy: #012b86; --nav-ink: #0b2d74; --midnight: #0b1a3c; --yellow: #fdc023;
  --bg: #f6f7ff; --surface: #ffffff; --ink: #0b1a3c; --muted: #485266; --faint: #7f828c;
  --line: #e3e6ef; --field: #c6c5ca;
  --urgent: #c4320a; --urgent-soft: #fdeee8; --high: #b54708; --high-soft: #fef3e2;
  --medium: #8a6100; --medium-soft: #fff6d6; --low: #485266; --low-soft: #eef0f5;
  --ok: #027a48; --ok-soft: #e7f6ee;
  --font: "Gilroy", "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif;
  color-scheme: light;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 var(--font); }
h1, h2, h3 { color: var(--navy); font-weight: 700; letter-spacing: -0.01em; }

/* Announcement strip, as on paidhr.com */
.strip { background: var(--midnight); color: #fff; text-align: center; font-size: 13.5px; font-weight: 500; padding: 9px 16px; }
.strip b { color: var(--yellow); font-weight: 600; }
.strip.va { background: var(--yellow); color: var(--midnight); } .strip.va b { color: var(--midnight); }
.strip.va .btn { margin-left: 8px; padding: 3px 12px; }

header.top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; padding: 14px max(16px, 3vw); background: var(--bg); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; text-decoration: none; }
.brand img { height: 30px; width: auto; display: block; }
.brand span { font-weight: 600; color: var(--nav-ink); font-size: 14px; padding-left: 12px; border-left: 1px solid var(--field); white-space: nowrap; }
header.top { position: sticky; top: 0; z-index: 4; }
.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); align-items: start; }
nav { position: sticky; top: 62px; display: grid; gap: 2px; padding: 20px 14px; align-content: start; min-height: calc(100vh - 62px); border-right: 1px solid var(--line); background: var(--surface); }
nav .group { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); padding: 14px 12px 6px; }
nav .group:first-child { padding-top: 0; }
nav button { font: 500 15px var(--font); text-align: left; padding: 9px 12px; border: 0; border-radius: 8px; background: none; color: var(--nav-ink); cursor: pointer; }
nav button:hover { background: var(--blue-faint); }
nav button[aria-current="page"] { background: var(--blue-soft); color: var(--navy); font-weight: 600; }
@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; }
  nav { position: static; display: flex; overflow-x: auto; min-height: 0; padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--line); }
  nav .group { display: none; }
  nav button { white-space: nowrap; }
}
.role-chip { font: 600 12px var(--font); padding: 3px 10px; border-radius: 999px; background: var(--blue-soft); color: var(--navy); text-transform: capitalize; }
.role-chip.admin { background: var(--yellow); color: var(--midnight); }
.features { list-style: none; padding: 0; margin: 28px 0 0; display: grid; gap: 12px; max-width: 46ch; }
.features li { display: flex; gap: 12px; align-items: flex-start; color: rgba(255, 255, 255, .92); font-size: 16px; }
.features li::before { content: ""; flex: none; width: 22px; height: 22px; margin-top: 2px; border-radius: 50%; background: var(--yellow) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 12.5l4 4 8-9' fill='none' stroke='%230b1a3c' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 14px no-repeat; }
.who { margin-left: auto; font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }

main { padding: 24px max(16px, 3vw) 56px; width: 100%; max-width: 1200px; margin: 0 auto; display: grid; gap: 16px; }
main > * { min-width: 0; }
h2 { font-size: 24px; margin: 0; }
.bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
select, input { font: 14px var(--font); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--field); background: var(--surface); color: var(--ink); }
input::placeholder { color: #afb3b8; }
input[type="checkbox"] { accent-color: var(--blue); width: 16px; height: 16px; padding: 0; vertical-align: -3px; }
button.btn { font: 600 14px var(--font); padding: 8px 16px; border-radius: 8px; border: 1px solid var(--blue); background: var(--surface); color: var(--blue); cursor: pointer; }
button.btn:hover { background: var(--blue-faint); }
button.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
button.primary:hover { background: var(--blue-hover); border-color: var(--blue-hover); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 1px 2px rgba(11, 26, 60, .04); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 760px; }
th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; background: var(--surface); }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--blue-faint); }
tbody tr:last-child td { border-bottom: 0; }
td strong { color: var(--nav-ink); }
.chip { display: inline-block; font: 600 12px var(--font); padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.chip.sev { text-transform: capitalize; }
.urgent { color: var(--urgent); background: var(--urgent-soft); } .high { color: var(--high); background: var(--high-soft); }
.medium { color: var(--medium); background: var(--medium-soft); } .low { color: var(--low); background: var(--low-soft); }
.esc { color: var(--urgent); background: var(--urgent-soft); }
.ok { color: var(--ok); background: var(--ok-soft); }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 12.5px; }
.detail { padding: 20px; display: grid; gap: 10px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.rule { padding: 18px; display: grid; gap: 8px; align-content: start; }
.rule > strong { color: var(--navy); font-size: 15px; }
.rule .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.notice { padding: 10px 14px; border-radius: 8px; background: var(--blue-soft); color: var(--navy); font-weight: 500; }
.notice.err { background: var(--urgent-soft); color: var(--urgent); }
.stat { padding: 16px 18px; display: grid; gap: 2px; }
.stat b { font-size: 30px; color: var(--blue-2); font-variant-numeric: tabular-nums; line-height: 1.2; }
.stat span:first-of-type { font-weight: 600; color: var(--nav-ink); }

/* Sign-in: PaidHR login layout. Brand blue, yellow diagonal band, white card. */
.signin-page { position: fixed; inset: 0; overflow: auto; background: var(--blue); color: #fff; display: grid; grid-template-rows: auto 1fr; z-index: 5; }
.signin-page::before { content: ""; position: fixed; right: -12vw; bottom: -30vh; width: 34vw; height: 120vh; background: var(--yellow); transform: rotate(45deg); transform-origin: center; z-index: -1; }
.signin-page { isolation: isolate; }
.signin-top { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 28px max(20px, 3vw); }
.signin-top img { height: 40px; width: auto; display: block; }
.signin-top a { color: #fff; font-weight: 700; text-decoration: none; font-size: 15px; }
.signin-top a b { color: var(--yellow); }
.signin-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: 40px; align-items: center; padding: 24px max(20px, 5vw) 64px; }
@media (max-width: 860px) { .signin-body { grid-template-columns: 1fr; } .signin-page::before { display: none; } }
.signin-pitch h1 { color: #fff; font-size: clamp(34px, 5vw, 56px); line-height: 1.08; margin: 0 0 18px; font-weight: 700; }
.signin-pitch .meaning { font-size: 15px; color: var(--yellow); margin: 0 0 14px; }
.signin-pitch .meaning b { color: #fff; }
.signin-pitch p { font-size: 18px; color: rgba(255, 255, 255, .9); max-width: 32ch; margin: 0; }
.signin-card { background: #fff; color: var(--ink); border-radius: 6px; padding: 40px 36px; display: grid; gap: 14px; box-shadow: 0 20px 50px rgba(11, 26, 60, .25); }
.signin-card h2 { color: #000; font-size: 34px; font-weight: 700; }
.signin-card p { margin: 0; color: var(--muted); font-size: 15px; }
.signin-card .gbtn-wrap { min-height: 44px; margin-top: 8px; }
.signin-card .fine { font-size: 13px; color: var(--faint); border-top: 1px solid var(--line); padding-top: 14px; margin-top: 6px; }
</style>
</head>
<body>
<div class="strip va" id="vabar" hidden></div>
<div class="strip" id="strip" hidden>Alerts are in <b>dry-run mode</b>: nothing is sent to CSMs, team leads or HubSpot.</div>
<header class="top" id="top" hidden>
  <a class="brand" href="#alerts" aria-label="CX Internal tool"><img src="${LOGO_BLUE_DATA_URI}" alt="PaidHR" width="86" height="30"><span>CX Internal tool</span></a>
  <div class="who" id="who"></div>
</header>
<section id="signin" class="signin-page" hidden>
  <div class="signin-top">
    <img src="${LOGO_WHITE_DATA_URI}" alt="PaidHR" width="126" height="40">
    <a id="help" href="#" hidden>Having trouble? <b>Get help →</b></a>
  </div>
  <div class="signin-body">
    <div class="signin-pitch">
      <h1>CX Internal tool</h1>
      <p class="meaning">PaidHR internal · for the CX team</p>
      <p>One place for the PaidHR CX team to catch billing and payroll problems early, see product adoption, grow accounts and keep customers.</p>
      <ul class="features">
        <li>Daily checks on billing, payroll and account data, sent to the right CSM</li>
        <li>Leadership, CSM, implementation and support reports</li>
        <li>Onboarding, expansion and support tools for the CX team</li>
        <li>Admin console for rules, users and broadcasts</li>
      </ul>
    </div>
    <div class="signin-card">
      <h2>Welcome back!</h2>
      <p>Sign in with your PaidHR Google Workspace account. What you see depends on your role.</p>
      <div id="signin-notice" class="notice err" role="alert" hidden></div>
      <div class="gbtn-wrap" id="gbtn"></div>
      <p class="fine">Only company accounts that an admin has added can sign in. Need access? Ask your Head of CX.</p>
    </div>
  </div>
</section>
<div class="shell" id="shell" hidden>
<nav id="nav" aria-label="Main"></nav>
<main id="app">
  <div id="notice" class="notice" role="status" hidden></div>

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
    <p class="muted small">Unacknowledged urgent and high alerts go to the CSM's team lead, then to every Head of CX. A CSM with no team lead escalates straight to the Head of CX.</p>
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
${INSIGHTS_HTML}
</main>
</div>

<script>
const TITLES = ${JSON.stringify(FLAG_TITLES)};
const FIELDS = ${JSON.stringify(Object.keys(MANDATORY_FIELDS))};
// Display order: engagement and escalation first (what CS leadership tunes), then billing.
const RULE_LABELS = {
  inactivity_days_by_health: 'Max days without contact, by health status',
  escalation_business_days: 'Escalate to team lead after (business days)',
  director_escalation_business_days: 'Then to the Head of CX after (business days)',
  escalate_severities: 'Alert levels that escalate',
  payroll_grace_business_days: 'Late payroll grace (business days)',
  arr_tolerance_kobo: 'ARR tolerance (kobo; 1 = ₦0.01)',
  mandatory_fields: 'Mandatory HubSpot fields',
  seat_history_days: 'Seat history to compare (days)',
};
const state = { token: null, me: null, view: 'alerts', dryRun: false, viewAs: recall('viewAs') || '' };

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
  // Signed out, errors show on the sign-in card; signed in, in the page.
  if (!state.me && isError && text) { const s = $('signin-notice'); s.textContent = text; s.hidden = false; return; }
  const n = $('notice'); n.textContent = text; n.className = 'notice' + (isError ? ' err' : ''); n.hidden = !text;
  if (text && !isError) setTimeout(() => { if (n.textContent === text) n.hidden = true; }, 4000);
}
function store(key, value) { try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {} }
function recall(key) { try { return sessionStorage.getItem(key); } catch { return null; } }

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  if (state.viewAs) headers['x-view-as'] = state.viewAs;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { signOut('Your sign-in expired. Please sign in again.'); throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || ('Request failed: ' + res.status));
  return body;
}

function signOut(message) {
  state.token = null; state.me = null; state.viewAs = ''; store('idToken', null); store('viewAs', null);
  $('shell').hidden = true; $('who').textContent = '';
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = true));
  $('top').hidden = true; $('app').hidden = true; $('strip').hidden = true;
  $('signin').hidden = false;
  if (message) notice(message, true);
}

async function start() {
  const cfg = await fetch('/app-config').then((r) => r.json());
  state.dryRun = !!cfg.alertsDryRun;
  if (cfg.helpEmail) { $('help').href = 'mailto:' + cfg.helpEmail; $('help').hidden = false; }
  if (cfg.authDisabled) return enter();
  state.token = recall('idToken');
  if (state.token) { try { return await enter(); } catch { /* fall through to sign-in */ } }
  $('top').hidden = true; $('app').hidden = true;
  $('signin').hidden = false;
  if (!cfg.googleClientId) { notice('Google sign-in is not configured (GOOGLE_OAUTH_CLIENT_ID).', true); return; }
  const s = el('script', { src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = () => {
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (r) => { state.token = r.credential; store('idToken', r.credential); enter().catch((e) => notice(e.message, true)); } });
    google.accounts.id.renderButton($('gbtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'rectangular', width: 340 });
  };
  document.head.append(s);
}

async function enter() {
  state.me = await api('/me');
  $('signin').hidden = true; $('signin-notice').hidden = true;
  $('top').hidden = false; $('app').hidden = false; $('shell').hidden = false; $('strip').hidden = !state.dryRun; notice('');
  const real = state.me.viewingAs ? state.me.viewingAs.actual : { email: state.me.email, role: state.me.role };
  const who = [];
  if (state.me.canViewAs) {
    const groups = [['cs_director', 'Heads of CX'], ['cs_team_lead', 'Team leads'], ['csm', 'CSMs'], ['implementation_manager', 'Implementation'], ['support_specialist', 'Support'], ['viewer', 'Viewers'], ['super_admin', 'Super admins']];
    const sel = el('select', { id: 'viewas', 'aria-label': 'View as', onchange: (e) => { state.viewAs = e.target.value; store('viewAs', state.viewAs || null); enter().catch((err) => notice(err.message, true)); } },
      el('option', { value: '' }, 'My own view'),
      ...groups.map(([r, label]) => { const ps = state.me.people.filter((p) => p.role === r); return ps.length ? el('optgroup', { label }, ps.map((p) => el('option', { value: p.email, selected: p.email === state.viewAs }, (p.name || p.email)))) : null; }));
    who.push(el('label', { class: 'small' }, 'View as ', sel));
  }
  who.push(el('span', { class: 'role-chip' + (state.me.isAdmin ? ' admin' : ''), style: 'text-transform:none' }, ROLE_NAMES[state.me.role] || state.me.role), el('span', {}, state.me.email), el('button', { class: 'btn', onclick: () => signOut() }, 'Sign out'));
  $('who').replaceChildren(...who);
  $('vabar').hidden = !state.me.viewingAs;
  if (state.me.viewingAs) $('vabar').replaceChildren('Viewing as ', el('b', {}, state.me.email + ' (' + (ROLE_NAMES[state.me.role] || state.me.role) + ')'), '. This is what they see. It is read-only. ', el('button', { class: 'btn', onclick: () => { state.viewAs = ''; store('viewAs', null); enter().catch((err) => notice(err.message, true)); } }, 'Back to my view'));
  buildNav();
  const wanted = location.hash.slice(1);
  show(allowedViews().includes(wanted) ? wanted : allowedViews().includes('dashboard') ? 'dashboard' : 'alerts');
}

const NAV = [
  { v: 'dashboard', label: 'Dashboard', group: 'Workspace', not: ['support_specialist', 'implementation_manager'] },
  { v: 'alerts', label: 'Alerts', group: 'Workspace' },
  { v: 'reports', label: 'Reports', group: 'Workspace' },
  { v: 'cx', label: 'Growth', group: 'Workspace', not: ['support_specialist'] },
  { v: 'support', label: 'Support themes', group: 'Workspace', not: ['csm', 'implementation_manager'] },
  { v: 'adoption', label: 'Adoption rate', group: 'Adoption & Upsell', not: ['support_specialist', 'implementation_manager'] },
  { v: 'churn', label: 'Churn risk', group: 'Adoption & Upsell', not: ['support_specialist', 'implementation_manager'] },
  { v: 'upsell', label: 'Upsell opportunities', group: 'Adoption & Upsell', not: ['support_specialist', 'implementation_manager'] },
  { v: 'signals', label: 'Growth signals', group: 'Adoption & Upsell', not: ['support_specialist', 'implementation_manager'] },
  { v: 'rules', label: 'Rules', group: 'admin', also: ['cs_team_lead', 'viewer'] },
  { v: 'teams', label: 'Team leads', group: 'admin', also: ['cs_team_lead', 'viewer'] },
  { v: 'recon', label: 'Reconciliation', group: 'admin', also: ['cs_team_lead', 'viewer'] },
  { v: 'catalog', label: 'Modules and seasons', group: 'admin' },
  { v: 'broadcasts', label: 'Broadcasts', group: 'admin' },
  { v: 'users', label: 'Users', group: 'admin' },
];
function navItems() {
  const r = state.me.role;
  return NAV.filter((i) => i.group === 'admin' ? (state.me.isAdmin || (i.also || []).includes(r)) : !(i.not || []).includes(r));
}
const allowedViews = () => navItems().map((i) => i.v);
function buildNav() {
  const nav = $('nav'); nav.replaceChildren();
  let last = null;
  for (const i of navItems()) {
    const g = i.group === 'admin' ? (state.me.isAdmin ? 'Administration' : 'Reference') : i.group;
    if (g !== last) { nav.append(el('div', { class: 'group' }, g)); last = g; }
    nav.append(el('button', { 'data-view': i.v }, i.v === 'dashboard' && state.me.role === 'csm' ? 'My portfolio' : i.label));
  }
}

function show(view) {
  if (!allowedViews().includes(view)) view = allowedViews()[0];
  state.view = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  for (const v of ALL_VIEWS) $('view-' + v).hidden = v !== view;
  ({ alerts: loadFlags, rules: loadRules, teams: loadTeams, recon: loadRecon, dashboard: loadDashboard, adoption: loadAdoption, churn: loadChurn, upsell: loadUpsell, signals: loadSignals, catalog: loadCatalog, reports: loadReports, cx: loadCx, support: loadSupport, broadcasts: loadBroadcasts, users: loadUsers })[view]().catch((e) => e.message !== 'unauthorized' && notice(e.message, true));
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) show(b.dataset.view); });
window.addEventListener('hashchange', () => state.me && show(location.hash.slice(1)));

/* ---------- Alerts ---------- */
for (const [k, v] of Object.entries(TITLES)) $('f-type').append(el('option', { value: k }, v));
['f-status', 'f-type', 'f-esc'].forEach((id) => $(id).addEventListener('change', () => loadFlags().catch((e) => notice(e.message, true))));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }) : '–';
const canAck = () => ['csm', 'cs_team_lead', 'cs_director', 'super_admin'].includes(state.me.role);

function stateChip(f) {
  if (f.status === 'resolved') return el('span', { class: 'chip ok' }, 'resolved');
  if (f.escalationLevel === 2) return el('span', { class: 'chip esc' }, 'with Head of CX');
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
  )) : [el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No team leads set. Escalations go straight to the Head of CX.'))]));
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

${INSIGHTS_JS}
start().catch((e) => notice(e.message, true));
</script>
</body>
</html>`;
