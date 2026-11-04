/**
 * Screens for phases 3 and 4: Reports, Growth & onboarding (radar, scorecard), Support themes,
 * Broadcasts. Plain JS added to the admin app. Everything from the API is written with
 * textContent (via el()), never innerHTML. No backticks in here: this is embedded in a template.
 */
export const INSIGHTS_HTML = /* html */ `
  <section id="view-adoption" hidden>
    <div class="bar" style="margin-bottom:12px">
      <h2 style="margin-right:auto">Product adoption</h2>
      <label class="small" id="ad-who-wrap">Show <select id="ad-who"></select></label>
      <input id="ad-search" type="search" placeholder="Search clients" aria-label="Search clients">
    </div>
    <p class="muted small" id="ad-asof"></p>
    <h3 style="margin:12px 0 4px;font-size:16px">Modules: most purchased, in use, and open for upsell</h3>
    <p class="muted small" id="ad-mod-note"></p>
    <div class="card table-wrap"><table style="min-width:900px"><thead><tr><th>Module</th><th>Bought by</th><th>In use</th><th>Bought but not used</th><th>Possible upsell</th></tr></thead><tbody id="ad-matrix"></tbody></table></div>
    <h3 style="margin:24px 0 8px;font-size:16px">Clients</h3>
    <div class="card table-wrap"><table style="min-width:1000px"><thead><tr><th>Client</th><th>Primary admin</th><th>Secondary admin</th><th>Employees active</th><th>Activity, 30 days</th><th>Support SLA</th><th>Modules in use</th><th>Upsell ready</th></tr></thead><tbody id="ad-clients"></tbody></table></div>
    <div class="card detail" id="ad-detail" hidden style="margin-top:16px"></div>
  </section>

  <section id="view-dashboard" hidden>
    <div class="bar" style="margin-bottom:12px">
      <h2 id="db-title" style="margin-right:auto">My portfolio</h2>
      <label class="small" id="db-who-wrap">Show <select id="db-who"></select></label>
      <label class="small">Sort <select id="db-sort"><option value="attention">Needs attention first</option><option value="arr">Largest ARR</option><option value="renewal">Renewal soonest</option><option value="health">Health</option><option value="name">Name</option></select></label>
      <input id="db-search" type="search" placeholder="Search clients" aria-label="Search clients">
    </div>
    <p class="muted small" id="db-asof"></p>
    <div class="grid2" id="db-kpis" style="margin:12px 0"></div>
    <div id="db-team-wrap" hidden>
      <h3 style="margin:16px 0 8px;font-size:16px">By CSM</h3>
      <div class="card table-wrap"><table style="min-width:640px"><thead><tr><th>CSM</th><th>Clients</th><th>ARR</th><th>At Risk</th><th>Renewals in 90 days</th><th>Open alerts</th></tr></thead><tbody id="db-team"></tbody></table></div>
    </div>
    <h3 style="margin:20px 0 8px;font-size:16px">Clients</h3>
    <div class="card table-wrap"><table style="min-width:980px"><thead><tr><th>Client</th><th>Health</th><th>ARR</th><th>Renewal</th><th>Seats in use</th><th>Last contact</th><th>Payroll</th><th>Alerts</th><th>Tickets</th></tr></thead><tbody id="db-clients"></tbody></table></div>
    <div class="card detail" id="db-detail" hidden style="margin-top:16px"></div>
  </section>

  <section id="view-reports" hidden>
    <div class="bar" style="margin-bottom:12px">
      <h2 style="margin-right:auto">Reports</h2>
      <label class="small">Report <select id="rp-audience"></select></label>
      <label class="small">Period <select id="rp-cadence"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="monthly">Monthly</option></select></label>
      <label class="small" id="rp-who-wrap" hidden>Whose <select id="rp-who"></select></label>
      <button class="btn primary" id="rp-go">Show</button>
    </div>
    <div id="rp-body" class="grid2"></div>
    <h2 style="margin-top:24px;font-size:16px">Schedules</h2>
    <p class="muted small">Reports go out automatically at 08:00 Lagos time when switched on. Personal CSM reports are email only.</p>
    <div class="card table-wrap" style="margin-top:8px"><table><thead><tr><th>Report</th><th>Period</th><th>Sends to</th><th>On</th></tr></thead><tbody id="rp-sched"></tbody></table></div>
  </section>

  <section id="view-cx" hidden>
    <h2>Growth and onboarding</h2>
    <h3 style="margin:16px 0 4px">Expansion radar</h3>
    <p class="muted small" id="cx-radar-note"></p>
    <div class="card table-wrap"><table><thead><tr><th>Company</th><th>CSM</th><th>Signals and the conversation they suggest</th><th></th></tr></thead><tbody id="cx-radar"></tbody></table></div>
    <div class="card detail" id="cx-qbr" hidden style="margin-top:16px"></div>
    <h3 style="margin:24px 0 4px">First 90 days</h3>
    <div class="grid2" id="cx-score"></div>
    <div class="card table-wrap" style="margin-top:12px"><table><thead><tr><th>Account</th><th>Signed up</th><th>Days</th><th>Payroll set up</th><th>First payroll</th><th>Days to value</th><th>Status</th></tr></thead><tbody id="cx-score-rows"></tbody></table></div>
  </section>

  <section id="view-support" hidden>
    <div class="bar" style="margin-bottom:12px">
      <h2 style="margin-right:auto">Support themes</h2>
      <button class="btn primary" id="sp-run">Find themes now</button>
    </div>
    <p class="muted small" id="sp-note"></p>
    <div id="sp-body" class="grid2"></div>
  </section>

  <section id="view-users" hidden>
    <h2>Users</h2>
    <p class="muted small">Everyone who can sign in. People sign in with their Google Workspace account; the role decides what they see. Deactivating stops sign-in and all notifications but keeps the history.</p>
    <form class="bar card" id="us-form" style="padding:12px;margin:12px 0">
      <input id="us-email" type="email" placeholder="name@paidhr.com" required aria-label="Email">
      <input id="us-name" placeholder="Name (optional)" maxlength="120" aria-label="Name">
      <select id="us-role" aria-label="Role"></select>
      <button class="btn primary" type="submit">Add user</button>
    </form>
    <div class="card table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Reports to</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody id="us-rows"></tbody></table></div>
  </section>

  <section id="view-broadcasts" hidden>
    <h2>Broadcasts</h2>
    <div class="notice" id="bc-locked" hidden></div>
    <div id="bc-main">
      <div class="card table-wrap" style="margin:12px 0"><table><thead><tr><th>Name</th><th>To</th><th>Status</th><th>Next send</th><th>Last run</th></tr></thead><tbody id="bc-list"></tbody></table></div>
      <form class="card detail" id="bc-form">
        <strong id="bc-title" style="color:var(--navy)">New broadcast</strong>
        <input id="bc-name" placeholder="Name (only you see this)" required maxlength="120" aria-label="Name">
        <div class="bar">
          <label class="small">To <select id="bc-aud"><option value="csms">CSMs</option><option value="cx_team">CX team</option><option value="clients">Clients</option></select></label>
          <label class="small"><input type="checkbox" class="bc-ch" value="email" checked> Email</label>
          <label class="small"><input type="checkbox" class="bc-ch" value="google_chat"> Google Chat</label>
          <label class="small"><input type="checkbox" class="bc-ch" value="hubspot_task"> HubSpot task</label>
        </div>
        <div class="bar" id="bc-filters">
          <input id="bc-health" placeholder="Health (e.g. At Risk, Healthy)" aria-label="Health filter">
          <input id="bc-csm" placeholder="CSM emails, comma separated" aria-label="CSM filter">
          <input id="bc-arrmin" type="number" min="0" placeholder="Min ARR (NGN)" aria-label="Minimum ARR">
          <input id="bc-arrmax" type="number" min="0" placeholder="Max ARR (NGN)" aria-label="Maximum ARR">
          <select id="bc-ewa" aria-label="EWA"><option value="">EWA: any</option><option value="used">Uses EWA</option><option value="not_used">Does not use EWA</option></select>
          <select id="bc-stat" aria-label="Statutory"><option value="">Statutory: any</option><option value="used">Uses statutory</option><option value="not_used">Does not</option></select>
          <input id="bc-roles" placeholder="Roles (CX team only)" aria-label="Role filter" hidden>
        </div>
        <input id="bc-subject" placeholder="Subject" required maxlength="200" aria-label="Subject">
        <textarea id="bc-body" rows="7" placeholder="Message. **bold**, [link](https://...), - bullets. Tokens: {{company_name}} {{csm_name}} {{arr_ngn}} {{active_seats}} {{health_status}} {{contract_end_date}}" required maxlength="5000" aria-label="Message" style="font:14px var(--font);padding:10px 12px;border-radius:8px;border:1px solid var(--field);width:100%"></textarea>
        <div class="bar">
          <button class="btn" type="submit" id="bc-save">Save draft</button>
          <button class="btn" type="button" id="bc-preview">Preview</button>
        </div>
        <div id="bc-prev" hidden></div>
      </form>
    </div>
  </section>
`;

export const INSIGHTS_JS = String.raw`
const ALL_VIEWS = ['dashboard', 'adoption', 'alerts', 'rules', 'teams', 'recon', 'reports', 'cx', 'support', 'broadcasts', 'users'];
const AUDIENCE_LABELS = { executive: 'Leadership', csm: 'CSM portfolio', implementation: 'Implementation', support: 'Support' };
const ROLE_AUDIENCES = { csm: ['csm'], implementation_manager: ['implementation'], support_specialist: ['support'] };
const money = (kobo) => '₦' + (Number(BigInt(kobo) / 100n)).toLocaleString('en-NG');
const isMgr = () => ['super_admin', 'cs_director'].includes(state.me.role);

/* ---------- Reports ---------- */
function drawSection(s) {
  const c = el('div', { class: 'card detail' });
  if (s.heading) c.append(el('strong', { style: 'color:var(--navy)' }, s.heading));
  if (s.kind === 'kpis') {
    c.append(el('div', { class: 'grid2' }, s.items.map((i) => el('div', { class: 'stat' }, el('b', {}, i.value), el('span', {}, i.label), i.note ? el('span', { class: 'small muted' }, i.note) : null))));
  } else if (s.kind === 'table') {
    c.append(s.rows.length ? el('div', { class: 'table-wrap' }, el('table', { style: 'min-width:0' }, el('thead', {}, el('tr', {}, s.columns.map((h) => el('th', {}, h)))), el('tbody', {}, s.rows.map((r) => el('tr', { style: 'cursor:default' }, r.map((v) => el('td', {}, v))))))) : el('p', { class: 'muted small' }, s.empty || 'Nothing to show.'));
  } else if (s.kind === 'bridge') {
    const max = s.steps.reduce((m, x) => { const v = BigInt(x.kobo); return (v < 0n ? -v : v) > m ? (v < 0n ? -v : v) : m; }, 1n);
    c.append(...s.steps.map((x) => {
      const v = BigInt(x.kobo); const w = Number(((v < 0n ? -v : v) * 100n) / max);
      const color = x.type === 'down' ? 'var(--urgent)' : x.type === 'up' ? 'var(--ok)' : 'var(--blue)';
      return el('div', { style: 'display:grid;grid-template-columns:130px 1fr 130px;gap:10px;align-items:center' }, el('span', { class: 'small' }, x.label), el('div', { style: 'background:var(--blue-faint);border-radius:4px;height:14px' }, el('div', { style: 'height:14px;border-radius:4px;width:' + Math.max(w, 1) + '%;background:' + color })), el('b', { class: 'small', style: 'text-align:right' }, x.value));
    }));
  } else if (s.kind === 'list') {
    c.append(s.items.length ? el('ul', { style: 'margin:0;padding-left:18px' }, s.items.map((i) => el('li', {}, i))) : el('p', { class: 'muted small' }, s.empty || 'Nothing to show.'));
  } else if (s.kind === 'text') { c.append(el('p', { style: 'margin:0' }, s.text)); }
  else if (s.kind === 'notice') { return el('div', { class: 'notice', style: 'grid-column:1/-1' }, s.text); }
  c.style.gridColumn = '1 / -1';
  return c;
}
async function loadReports() {
  const sel = $('rp-audience');
  const allowed = ROLE_AUDIENCES[state.me.role] || Object.keys(AUDIENCE_LABELS);
  sel.replaceChildren(...allowed.map((a) => el('option', { value: a }, AUDIENCE_LABELS[a])));
  if (!sel.dataset.wired) {
    sel.dataset.wired = '1';
    sel.addEventListener('change', syncWho);
    $('rp-go').addEventListener('click', () => showReport().catch((e) => notice(e.message, true)));
  }
  const people = await api('/portfolio/people').catch(() => []);
  state.people = people;
  $('rp-audience').options[0] && (sel.value = allowed[0]);
  syncWho();
  await showReport();
  if (['csm', 'implementation_manager', 'support_specialist'].includes(state.me.role)) { $('rp-sched').closest('div').hidden = true; return; }
  const rows = await api('/reports/schedules');
  const names = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  $('rp-sched').replaceChildren(...rows.map((r) => el('tr', { style: 'cursor:default' }, el('td', {}, AUDIENCE_LABELS[r.audience]), el('td', {}, names[r.cadence]), el('td', { class: 'small muted' }, r.channels.join(', ')),
    el('td', {}, el('input', { type: 'checkbox', checked: r.enabled, disabled: state.me.role !== 'cs_director', 'aria-label': 'Send ' + r.key, onchange: async (e) => { try { await api('/reports/schedules/' + r.key, { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) }); notice('Saved'); } catch (err) { e.target.checked = !e.target.checked; notice(err.message, true); } } })))));
}
function syncWho() {
  const people = state.people || [];
  const show = $('rp-audience').value === 'csm' && (people.length > 1 || state.me.role !== 'csm');
  $('rp-who-wrap').hidden = !show;
  if (show) {
    const label = state.me.role === 'cs_director' || state.me.role === 'super_admin' || state.me.role === 'viewer' ? 'Everyone (team report)' : 'My whole team';
    $('rp-who').replaceChildren(el('option', { value: '' }, label), ...people.map((p) => el('option', { value: p.email }, (p.name || p.email) + (p.email === state.me.email ? ' (me)' : ''))));
  }
}
async function showReport() {
  const q = new URLSearchParams({ audience: $('rp-audience').value, cadence: $('rp-cadence').value });
  if ($('rp-audience').value === 'csm' && !$('rp-who-wrap').hidden && $('rp-who').value) q.set('csm', $('rp-who').value);
  let r;
  try { r = await api('/reports/preview?' + q); } catch (e) { $('rp-body').replaceChildren(el('p', { class: 'muted' }, e.message)); return; }
  $('rp-body').replaceChildren(el('div', { style: 'grid-column:1/-1' }, el('h3', { style: 'margin:0' }, r.title), el('span', { class: 'small muted' }, r.subtitle)), ...r.sections.map(drawSection));
}

/* ---------- Growth: radar, scorecard, QBR ---------- */
async function loadCx() {
  const canQbr = ['csm', 'cs_director', 'cs_team_lead'].includes(state.me.role);
  try {
    const radar = await api('/cx/radar');
    $('cx-radar-note').textContent = 'As of ' + fmtDate(radar.asOf) + '. Accounts showing signs they are ready for more.' + (state.me.role === 'csm' ? ' Showing your accounts.' : '');
    $('cx-radar').replaceChildren(...(radar.entries.length ? radar.entries.map((e) => el('tr', { style: 'cursor:default' },
      el('td', {}, el('strong', {}, e.name), el('div', { class: 'small muted' }, e.arrKobo ? money(e.arrKobo) + ' ARR' : '')), el('td', { class: 'small' }, e.csmEmail || 'Unassigned'),
      el('td', {}, e.signals.map((s) => el('div', { style: 'margin-bottom:6px' }, el('span', { class: 'chip low' }, s.text), el('div', { class: 'small muted' }, s.play)))),
      el('td', {}, canQbr ? el('button', { class: 'btn', onclick: () => openQbr(e) }, 'Draft QBR') : null))) : [el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No accounts match the radar rules right now.'))]));
  } catch (e) { $('cx-radar').replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'muted' }, e.message))); }
  try {
    const s = await api('/cx/scorecard');
    const stat = (label, n, note) => el('div', { class: 'card stat' }, el('b', {}, n), el('span', {}, label), el('span', { class: 'small muted' }, note));
    const pct = (v) => (v == null ? '–' : v + '%');
    $('cx-score').replaceChildren(stat('Accounts in window', s.cohort, 'Signed up in the last ' + s.windowDays + ' days'), stat('Average days to first value', s.avgTtfvDays == null ? '–' : s.avgTtfvDays, 'Median ' + (s.medianTtfvDays == null ? '–' : s.medianTtfvDays)), stat('First payroll rate', pct(s.firstPayrollRatePct), 'Of accounts past the ' + s.slaDays + '-day target'), stat('Payroll set up', pct(s.configuredRatePct), 'Of all accounts in the window'));
    $('cx-score-rows').replaceChildren(...s.rows.map((r) => el('tr', { style: 'cursor:default' }, el('td', {}, el('strong', {}, r.name)), el('td', {}, fmtDate(r.createdOn)), el('td', {}, r.daysSinceSignup), el('td', {}, fmtDate(r.configuredOn)), el('td', {}, fmtDate(r.firstPayrollRunOn)), el('td', {}, r.ttfvDays == null ? '–' : r.ttfvDays), el('td', {}, el('span', { class: 'chip ' + (String(r.status).includes('STAGNAT') ? 'high' : 'low') }, String(r.status).toLowerCase().replace(/_/g, ' '))))));
  } catch (e) { $('cx-score').replaceChildren(el('p', { class: 'muted' }, e.message)); $('cx-score-rows').replaceChildren(); }
}
async function openQbr(entry, boxId) {
  const box = $(boxId || 'cx-qbr'); box.hidden = false; box.replaceChildren(el('p', { class: 'muted' }, 'Drafting the QBR for ' + entry.name + '...'));
  try {
    const out = await api('/cx/accounts/' + encodeURIComponent(entry.hubspotId) + '/qbr', { method: 'POST' });
    const q = out.content;
    box.replaceChildren(el('strong', { style: 'color:var(--navy);font-size:18px' }, q.title), el('span', { class: 'small muted' }, 'Draft written by Claude from CRM and Control Panel facts. Check it before using it.'),
      el('p', {}, q.executive_summary), el('p', {}, q.health_narrative),
      el('div', { class: 'grid2' }, el('div', {}, el('strong', {}, 'Wins'), el('ul', {}, q.wins.map((w) => el('li', {}, w)))), el('div', {}, el('strong', {}, 'Risks'), el('ul', {}, q.risks.map((w) => el('li', {}, w))))),
      el('strong', {}, 'Growth opportunities'), el('ul', {}, q.growth_opportunities.map((g) => el('li', {}, el('b', {}, g.opportunity), ': ', g.evidence, ' Ask: ', g.suggested_ask))),
      el('strong', {}, 'Questions for the client'), el('ul', {}, q.questions_for_client.map((w) => el('li', {}, w))),
      el('strong', {}, 'Slides'), ...q.slides.map((s, i) => el('div', {}, el('b', {}, (i + 1) + '. ' + s.title), el('ul', {}, s.bullets.map((b) => el('li', {}, b))))));
  } catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.message)); }
}

/* ---------- Support themes ---------- */
async function loadSupport() {
  const canRun = ['support_specialist', 'cs_director', 'super_admin'].includes(state.me.role);
  $('sp-run').hidden = !canRun;
  if (!$('sp-run').dataset.wired) { $('sp-run').dataset.wired = '1'; $('sp-run').addEventListener('click', async () => { $('sp-run').disabled = true; try { await api('/cx/clusters/run', { method: 'POST' }); notice('Themes updated'); await loadSupport(); } catch (e) { notice(e.message, true); } finally { $('sp-run').disabled = false; } }); }
  const r = await api('/cx/clusters');
  if (!r.aiEnabled) { $('sp-note').textContent = 'Claude features are switched off, so themes are not being written.'; }
  if (!r.latest) { if (r.aiEnabled) $('sp-note').textContent = 'No themes yet. They are written every Monday, or press the button.'; $('sp-body').replaceChildren(); return; }
  const c = r.latest.content;
  $('sp-note').textContent = c.ticketsAnalysed + ' tickets from ' + fmtDate(c.period.from) + ' to ' + fmtDate(c.period.to) + '. ' + (c.unclusteredNote || '') + ' Drafts written by Claude: review before use.';
  $('sp-body').replaceChildren(...c.themes.map((t) => el('div', { class: 'card detail' }, el('strong', { style: 'color:var(--navy);font-size:16px' }, t.name + ' (' + t.ticketCount + ' tickets)'),
    el('p', { class: 'muted small', style: 'margin:0' }, t.rootCause), el('div', {}, el('b', {}, 'Suggested fix: '), t.suggestedFix),
    el('div', {}, el('b', {}, 'Macro: '), t.macro.subject), el('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0;background:var(--blue-faint);padding:8px;border-radius:6px' }, t.macro.body),
    el('div', {}, el('b', {}, 'Knowledge base: '), t.kbArticle.title), el('ol', { class: 'small', style: 'margin:0;padding-left:18px' }, t.kbArticle.outline.map((o) => el('li', {}, o))),
    el('span', { class: 'mono muted' }, t.ticketIds.join(', ')))));
}

/* ---------- Broadcasts ---------- */
const bcState = { editing: null, access: null };
const bcInput = () => {
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const f = {};
  if ($('bc-health').value.trim()) f.health = list($('bc-health').value);
  if ($('bc-csm').value.trim()) f.csm = list($('bc-csm').value);
  if ($('bc-arrmin').value !== '') f.arrMinNgn = Number($('bc-arrmin').value);
  if ($('bc-arrmax').value !== '') f.arrMaxNgn = Number($('bc-arrmax').value);
  if ($('bc-ewa').value) f.ewa = $('bc-ewa').value;
  if ($('bc-stat').value) f.statutory = $('bc-stat').value;
  if ($('bc-roles').value.trim()) f.roles = list($('bc-roles').value);
  return { name: $('bc-name').value, subject: $('bc-subject').value, body: $('bc-body').value, audience: $('bc-aud').value, filters: f, channels: [...document.querySelectorAll('.bc-ch')].filter((c) => c.checked).map((c) => c.value) };
};
function bcSyncAudience() {
  const a = $('bc-aud').value;
  const allowed = { clients: ['email'], csms: ['email', 'google_chat', 'hubspot_task'], cx_team: ['email', 'google_chat'] }[a];
  document.querySelectorAll('.bc-ch').forEach((c) => { c.disabled = !allowed.includes(c.value); if (c.disabled) c.checked = false; });
  $('bc-roles').hidden = a !== 'cx_team'; $('bc-filters').querySelectorAll('input:not(#bc-roles),select').forEach((x) => (x.hidden = a === 'cx_team'));
}
async function loadBroadcasts() {
  bcState.access = await api('/broadcasts/access');
  $('bc-locked').hidden = bcState.access.allowed; $('bc-main').hidden = !bcState.access.allowed;
  if (!bcState.access.allowed) { $('bc-locked').textContent = bcState.access.reason; return; }
  if (!bcState.access.canSendToClients) { const o = [...$('bc-aud').options].find((x) => x.value === 'clients'); if (o) o.remove(); }
  if (!$('bc-form').dataset.wired) {
    $('bc-form').dataset.wired = '1';
    $('bc-aud').addEventListener('change', bcSyncAudience);
    $('bc-form').addEventListener('submit', async (e) => { e.preventDefault(); try { const saved = await bcSave(); notice('Draft saved'); bcState.editing = saved.id; await loadBroadcasts(); } catch (err) { notice(err.message, true); } });
    $('bc-preview').addEventListener('click', () => bcPreview().catch((e) => notice(e.message, true)));
  }
  bcSyncAudience();
  const rows = await api('/broadcasts');
  $('bc-list').replaceChildren(...(rows.length ? rows.map((b) => el('tr', { onclick: () => bcEdit(b) }, el('td', {}, el('strong', {}, b.name), el('div', { class: 'small muted' }, b.subject)), el('td', { class: 'small' }, b.audience.replace('_', ' ') + ' · ' + b.channels.join(', ')),
    el('td', {}, el('span', { class: 'chip ' + (b.status === 'sent' ? 'ok' : 'low') }, b.status)), el('td', { class: 'small' }, b.nextRunAt ? new Date(b.nextRunAt).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : '–'),
    el('td', { class: 'small' }, b.lastRun ? b.lastRun.sent + ' sent, ' + b.lastRun.failed + ' failed' + (b.lastRun.live ? '' : ' (dry run)') : '–'))) : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No broadcasts yet.'))]));
}
function bcEdit(b) {
  bcState.editing = b.status === 'sent' ? null : b.id;
  $('bc-title').textContent = b.status === 'sent' ? 'Duplicate of "' + b.name + '" (sent broadcasts cannot be edited)' : 'Edit broadcast';
  $('bc-name').value = b.name + (b.status === 'sent' ? ' (copy)' : ''); $('bc-subject').value = b.subject; $('bc-body').value = b.body; $('bc-aud').value = b.audience;
  document.querySelectorAll('.bc-ch').forEach((c) => (c.checked = b.channels.includes(c.value)));
  const f = b.filters || {};
  $('bc-health').value = (f.health || []).join(', '); $('bc-csm').value = (f.csm || []).join(', '); $('bc-arrmin').value = f.arrMinNgn ?? ''; $('bc-arrmax').value = f.arrMaxNgn ?? '';
  $('bc-ewa').value = f.ewa || ''; $('bc-stat').value = f.statutory || ''; $('bc-roles').value = (f.roles || []).join(', ');
  bcSyncAudience(); $('bc-prev').hidden = true; $('bc-form').scrollIntoView({ behavior: 'smooth' });
}
async function bcSave() {
  const body = JSON.stringify(bcInput());
  return bcState.editing ? api('/broadcasts/' + bcState.editing, { method: 'PUT', body }) : api('/broadcasts', { method: 'POST', body });
}
async function bcPreview() {
  const p = await api('/broadcasts/preview', { method: 'POST', body: JSON.stringify(bcInput()) });
  const box = $('bc-prev'); box.hidden = false;
  const kids = [el('div', { class: 'notice' }, p.sendable + ' messages would be sent' + (p.live ? '.' : ' (dry run: nothing will actually be sent).') + ' ' + Object.entries(p.counts).map(([k, v]) => v + ' ' + k.replace('_', ' ')).join(', '))];
  for (const w of p.warnings) kids.push(el('div', { class: 'notice err' }, w));
  if (p.skipped.length) kids.push(el('details', {}, el('summary', { class: 'small' }, p.skipped.length + ' skipped'), el('ul', { class: 'small' }, p.skipped.map((s) => el('li', {}, (s.company || 'Team') + ' (' + s.channel + '): ' + s.reason)))));
  kids.push(...p.samples.slice(0, 3).map((s) => el('div', { class: 'card detail' }, el('span', { class: 'small muted' }, s.channel + ' to ' + s.to + (s.company ? ' · ' + s.company : '')), el('strong', {}, s.subject), el('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0' }, s.text))));
  const actions = el('div', { class: 'bar' });
  if (p.sendable > 0) {
    actions.append(el('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
      if (!confirm('Send ' + p.sendable + ' messages now?' + (p.live ? '' : ' (dry run)'))) return;
      e.target.disabled = true;
      try { const saved = await bcSave(); bcState.editing = saved.id; const run = await api('/broadcasts/' + saved.id + '/send', { method: 'POST', body: JSON.stringify({ confirmCount: p.sendable }) }); await bcWatch(run.id); } catch (err) { notice(err.message, true); e.target.disabled = false; }
    } }, 'Send now'));
    const when = el('input', { type: 'datetime-local', 'aria-label': 'Send at (Lagos time)' });
    actions.append(el('span', { class: 'small muted' }, 'or schedule once (Lagos time):'), when, el('button', { class: 'btn', type: 'button', onclick: async () => {
      if (!when.value) return notice('Pick a date and time', true);
      try { const saved = await bcSave(); bcState.editing = saved.id; await api('/broadcasts/' + saved.id + '/schedule', { method: 'POST', body: JSON.stringify({ schedule: { kind: 'once', runAt: new Date(when.value + ':00+01:00').toISOString() } }) }); notice('Scheduled'); loadBroadcasts(); } catch (err) { notice(err.message, true); }
    } }, 'Schedule'));
  }
  kids.push(actions);
  box.replaceChildren(...kids);
}
async function bcWatch(runId) {
  const box = $('bc-prev'); box.hidden = false;
  for (let i = 0; i < 600; i++) {
    const r = await api('/broadcasts/runs/' + runId);
    box.replaceChildren(el('div', { class: 'notice' }, (r.status === 'running' ? 'Sending... ' : 'Finished. ') + r.sent + ' sent, ' + r.failed + ' failed, ' + r.skipped + ' skipped of ' + r.total + (r.live ? '' : ' (dry run)')),
      ...r.recipients.filter((x) => x.status === 'failed').map((x) => el('div', { class: 'notice err' }, x.recipient + ': ' + x.error)));
    if (r.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  loadBroadcasts();
}

/* ---------- Users ---------- */
const ROLE_NAMES = { super_admin: 'Super admin', cs_director: 'Head of CX', cs_team_lead: 'CS Team Lead', csm: 'CSM', implementation_manager: 'Implementation Manager', support_specialist: 'Support Specialist', viewer: 'Viewer' };
const roleOptions = () => Object.entries(ROLE_NAMES).filter(([k]) => k !== 'super_admin' || state.me.role === 'super_admin');
async function loadUsers() {
  if (!$('us-form').dataset.wired) {
    $('us-form').dataset.wired = '1';
    $('us-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/users', { method: 'POST', body: JSON.stringify({ email: $('us-email').value.trim(), name: $('us-name').value.trim() || undefined, role: $('us-role').value }) }); notice('User added. They can now sign in with Google.'); $('us-form').reset(); loadUsers(); }
      catch (err) { if (err.message !== 'unauthorized') notice(err.message, true); }
    });
  }
  $('us-role').replaceChildren(...roleOptions().map(([k, v]) => el('option', { value: k, selected: k === 'csm' }, v)));
  const rows = await api('/users');
  const rel = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }) : 'Never';
  const change = async (u, patch, ok) => { try { await api('/users/' + encodeURIComponent(u.email), { method: 'PUT', body: JSON.stringify(patch) }); notice(ok); loadUsers(); } catch (err) { if (err.message !== 'unauthorized') notice(err.message, true); loadUsers(); } };
  $('us-rows').replaceChildren(...rows.map((u) => {
    const self = u.email === state.me.email;
    const locked = u.role === 'super_admin' && state.me.role !== 'super_admin';
    const sel = el('select', { 'aria-label': 'Role for ' + u.email, disabled: self || locked, onchange: (e) => change(u, { role: e.target.value }, 'Role updated') }, Object.entries(ROLE_NAMES).filter(([k]) => k !== 'super_admin' || state.me.role === 'super_admin' || u.role === 'super_admin').map(([k, v]) => el('option', { value: k, selected: k === u.role }, v)));
    const mgrs = rows.filter((m) => m.active && ['super_admin', 'cs_director', 'cs_team_lead'].includes(m.role) && m.email !== u.email);
    const mgr = el('select', { 'aria-label': 'Reports to, for ' + u.email, disabled: locked || ['super_admin', 'cs_director', 'viewer'].includes(u.role), onchange: (e) => change(u, { managerEmail: e.target.value || null }, 'Reporting line updated') },
      el('option', { value: '' }, ['super_admin', 'cs_director', 'viewer'].includes(u.role) ? 'Top of the organogram' : 'Nobody yet'), ...mgrs.map((m) => el('option', { value: m.email, selected: m.email === u.managerEmail }, (m.name || m.email) + ' (' + ROLE_NAMES[m.role] + ')')));
    return el('tr', { style: 'cursor:default' },
      el('td', {}, el('strong', {}, u.name || u.email), u.name ? el('div', { class: 'small muted' }, u.email) : null, self ? el('span', { class: 'small muted' }, ' (you)') : null),
      el('td', {}, sel), el('td', {}, mgr), el('td', {}, el('span', { class: 'chip ' + (u.active ? 'ok' : 'low') }, u.active ? 'active' : 'deactivated')),
      el('td', { class: 'small muted' }, rel(u.lastSeenAt)),
      el('td', {}, self || locked ? null : el('button', { class: 'btn', onclick: () => change(u, { active: !u.active }, u.active ? 'User deactivated' : 'User restored') }, u.active ? 'Deactivate' : 'Restore')));
  }));
}

/* ---------- Dashboard: every client in your scope ---------- */
const dbState = { data: null, sel: null };
const HEALTH = { 'at risk': 'high', neutral: 'medium', healthy: 'ok' };
const SEV_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const ago = (d) => d == null ? 'Never' : d === 0 ? 'Today' : d + (d === 1 ? ' day ago' : ' days ago');
function renewalChip(d, iso) {
  if (d == null) return el('span', { class: 'muted small' }, 'No date');
  const cls = d < 0 ? 'urgent' : d <= 30 ? 'high' : d <= 90 ? 'medium' : 'low';
  return el('div', {}, el('div', { class: 'small' }, fmtDate(iso)), el('span', { class: 'chip ' + cls }, d < 0 ? 'ended ' + (-d) + 'd ago' : 'in ' + d + ' days'));
}
function seatBar(c) {
  if (c.activeSeats == null) return el('span', { class: 'muted small' }, c.paidSeats == null ? '–' : c.paidSeats + ' paid');
  const u = c.utilisationPct;
  const over = u != null && u > 100;
  const bar = u == null ? null : el('div', { style: 'height:6px;background:var(--blue-faint);border-radius:3px;margin-top:4px;width:110px' }, el('div', { style: 'height:6px;border-radius:3px;width:' + Math.min(u, 100) + '%;background:' + (over ? 'var(--urgent)' : u < 50 ? 'var(--high)' : 'var(--blue)') }));
  return el('div', {}, el('span', {}, c.activeSeats + (c.paidSeats != null ? ' of ' + c.paidSeats : '')), u != null ? el('span', { class: 'small ' + (over ? '' : 'muted'), style: over ? 'color:var(--urgent);font-weight:600' : '' }, ' (' + u + '%)') : null, bar,
    c.seatChange90d ? el('div', { class: 'small muted' }, (c.seatChange90d > 0 ? '+' : '') + c.seatChange90d + ' in 90 days') : null);
}
const payrollChip = (p) => el('span', { class: 'chip ' + ({ ok: 'ok', late: 'urgent', not_set_up: 'high', unknown: 'low' }[p.status]) }, { ok: 'on track', late: 'late', not_set_up: 'not set up', unknown: 'not linked' }[p.status]);
const attention = (c) => (c.topSeverity ? SEV_RANK[c.topSeverity] : 5) * 1000 + ((c.health || '').toLowerCase() === 'at risk' ? 0 : 500) + Math.min(Math.max(c.daysToRenewal == null ? 400 : c.daysToRenewal, 0), 400);
function sortClients(list, how) {
  const by = { attention: (a, b) => attention(a) - attention(b), arr: (a, b) => Number(BigInt(b.arrKobo || 0) - BigInt(a.arrKobo || 0)), renewal: (a, b) => (a.daysToRenewal ?? 99999) - (b.daysToRenewal ?? 99999), health: (a, b) => ['at risk', 'neutral', 'healthy'].indexOf((a.health || '').toLowerCase()) - ['at risk', 'neutral', 'healthy'].indexOf((b.health || '').toLowerCase()), name: (a, b) => a.name.localeCompare(b.name) };
  return [...list].sort(by[how] || by.attention);
}
async function loadDashboard() {
  const who = $('db-who');
  if (!who.dataset.wired) {
    who.dataset.wired = '1';
    who.addEventListener('change', () => loadDashboard().catch((e) => notice(e.message, true)));
    $('db-sort').addEventListener('change', drawClients);
    $('db-search').addEventListener('input', drawClients);
  }
  const keep = who.value;
  const q = keep ? '?csm=' + encodeURIComponent(keep) : '';
  const d = await api('/portfolio' + q);
  dbState.data = d; $('db-detail').hidden = true;
  $('db-title').textContent = state.me.role === 'csm' && d.people.length <= 1 ? 'My portfolio' : (state.me.isAdmin || state.me.role === 'viewer' ? 'Portfolio dashboard' : 'Team dashboard');
  $('db-who-wrap').hidden = d.people.length <= 1;
  who.replaceChildren(el('option', { value: '' }, d.people.length > 1 && state.me.role !== 'csm' ? 'Everyone' : 'All my clients'), ...d.people.map((p) => el('option', { value: p.email, selected: p.email === keep }, (p.name || p.email) + (p.email === state.me.email ? ' (me)' : ''))));
  who.value = keep;
  $('db-asof').textContent = 'Data as of ' + fmtDate(d.asOf) + '. Sorted by what needs attention first.';
  const s = d.summary;
  const tile = (label, value, note, cls) => el('div', { class: 'card stat' }, el('b', { class: cls || '' }, value), el('span', {}, label), note ? el('span', { class: 'small muted' }, note) : null);
  $('db-kpis').replaceChildren(
    tile('Total ARR', money(s.arrKobo), s.clients + ' clients'),
    tile('At Risk', String(s.atRisk.count), money(s.atRisk.arrKobo) + ' ARR'),
    tile('Renewals in 90 days', String(s.renewals90.count), money(s.renewals90.arrKobo) + ' ARR'),
    tile('Open alerts', String(s.openAlerts), s.urgentAlerts + (s.urgentAlerts === 1 ? ' client' : ' clients') + ' with an urgent or high alert'),
    tile('No contact in 30 days', String(s.noContact30), 'Calls, meetings or emails logged in HubSpot'),
    tile('Seat use', s.avgUtilisationPct == null ? '–' : s.avgUtilisationPct + '%', 'Average of active users against paid seats'),
  );
  $('db-team-wrap').hidden = !(d.team.length > 1 && !keep);
  $('db-team').replaceChildren(...d.team.map((t) => el('tr', { onclick: () => { if (t.csmEmail) { $('db-who').value = t.csmEmail; loadDashboard().catch((e) => notice(e.message, true)); } } },
    el('td', {}, el('strong', {}, t.csmName || t.csmEmail || 'Unassigned')), el('td', {}, t.clients), el('td', {}, money(t.arrKobo)), el('td', {}, t.atRisk), el('td', {}, t.renewals90), el('td', {}, t.openAlerts))));
  drawClients();
}
function drawClients() {
  const d = dbState.data; if (!d) return;
  const term = $('db-search').value.trim().toLowerCase();
  const list = sortClients(d.clients.filter((c) => !term || c.name.toLowerCase().includes(term) || (c.industry || '').toLowerCase().includes(term)), $('db-sort').value);
  const showCsm = $('db-who').value === '' && d.team.length > 1;
  $('db-clients').replaceChildren(...(list.length ? list.map((c) => el('tr', { onclick: () => openClient(c.hubspotId) },
    el('td', {}, el('strong', {}, c.name), el('div', { class: 'small muted' }, [c.industry, showCsm ? (c.csmName || c.csmEmail || 'Unassigned') : null].filter(Boolean).join(' · ')), c.onboarding === 'stalled' ? el('span', { class: 'chip high' }, 'onboarding stalled') : c.onboarding === 'in_progress' ? el('span', { class: 'chip low' }, 'onboarding') : null),
    el('td', {}, el('span', { class: 'chip ' + (HEALTH[(c.health || '').toLowerCase()] || 'low') }, c.health || 'Not set')),
    el('td', {}, c.arrKobo == null ? '–' : money(c.arrKobo)),
    el('td', {}, renewalChip(c.daysToRenewal, c.contractEnd)),
    el('td', {}, seatBar(c)),
    el('td', { class: c.daysSinceContact == null || c.daysSinceContact > 30 ? '' : 'muted' }, c.daysSinceContact != null && c.daysSinceContact > 30 ? el('b', { style: 'color:var(--high)' }, ago(c.daysSinceContact)) : ago(c.daysSinceContact)),
    el('td', {}, payrollChip(c.payroll)),
    el('td', {}, c.openAlerts ? el('span', { class: 'chip ' + (c.topSeverity || 'low'), title: 'Most serious: ' + c.topSeverity }, c.openAlerts + (c.openAlerts === 1 ? ' alert' : ' alerts')) : el('span', { class: 'muted small' }, 'None')),
    el('td', {}, c.openTickets ? String(c.openTickets) : el('span', { class: 'muted small' }, '0')))) : [el('tr', {}, el('td', { colspan: '9', class: 'muted' }, d.clients.length ? 'No clients match your search.' : 'No clients are assigned yet.'))]));
}
function sparkline(points) {
  const v = points.filter((p) => p.seats != null);
  if (v.length < 2) return el('p', { class: 'muted small' }, 'Not enough history yet to draw a trend.');
  const W = 300, H = 60, P = 6; const min = Math.min(...v.map((p) => p.seats)), max = Math.max(...v.map((p) => p.seats)); const span = Math.max(max - min, 1);
  const xy = v.map((p, i) => [P + (i * (W - 2 * P)) / (v.length - 1), H - P - ((p.seats - min) * (H - 2 * P)) / span]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('style', 'max-width:320px'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Active users over the last 90 days, from ' + v[0].seats + ' to ' + v[v.length - 1].seats);
  const line = document.createElementNS(ns, 'polyline'); line.setAttribute('points', xy.map((p) => p.join(',')).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#004af5'); line.setAttribute('stroke-width', '2');
  const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', xy[xy.length - 1][0]); dot.setAttribute('cy', xy[xy.length - 1][1]); dot.setAttribute('r', '4'); dot.setAttribute('fill', '#004af5');
  svg.append(line, dot);
  return el('div', {}, svg, el('div', { class: 'small muted' }, v[0].seats + ' active users on ' + fmtDate(v[0].date) + ', ' + v[v.length - 1].seats + ' on ' + fmtDate(v[v.length - 1].date)));
}
const CAT = { UPSELL: 'Upsell', CROSS_SELL_EWA: 'EWA', CROSS_SELL_STATUTORY: 'Statutory', CROSS_SELL_OTHER: 'Other add-ons' };
async function openClient(id) {
  const box = $('db-detail'); box.hidden = false; box.replaceChildren(el('p', { class: 'muted' }, 'Loading...'));
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await api('/portfolio/clients/' + encodeURIComponent(id)); const c = r.client;
    const fact = (k, v) => el('div', {}, el('div', { class: 'small muted' }, k), el('div', {}, v));
    const canQbr = ['csm', 'cs_director', 'cs_team_lead'].includes(state.me.role);
    box.replaceChildren(...[
      el('div', { class: 'bar' }, el('strong', { style: 'color:var(--navy);font-size:20px;margin-right:auto' }, c.name), el('span', { class: 'chip ' + (HEALTH[(c.health || '').toLowerCase()] || 'low') }, c.health || 'Not set'),
        canQbr ? el('button', { class: 'btn', onclick: () => openQbr({ hubspotId: c.hubspotId, name: c.name }, 'db-qbr') }, 'Draft QBR') : null, el('button', { class: 'btn', onclick: () => (box.hidden = true) }, 'Close')),
      el('div', { class: 'grid2' },
        el('div', { style: 'display:grid;gap:10px' }, el('strong', {}, 'Account'),
          fact('CSM', c.csmName || c.csmEmail || 'Unassigned'), fact('Industry', c.industry || '–'), fact('ARR', c.arrKobo == null ? '–' : money(c.arrKobo)),
          fact('Contract', c.contractEnd ? fmtDate(c.contractEnd) + (c.daysToRenewal != null ? ' (' + (c.daysToRenewal < 0 ? 'ended ' + (-c.daysToRenewal) + ' days ago' : 'in ' + c.daysToRenewal + ' days') + ')' : '') : 'No date'),
          fact('Last contact', c.lastContact ? fmtDate(c.lastContact) + ' (' + ago(c.daysSinceContact) + ')' : 'Never logged')),
        el('div', { style: 'display:grid;gap:10px' }, el('strong', {}, 'Usage and adoption'),
          fact('Seats', c.activeSeats == null ? 'Not linked to the Control Panel' : c.activeSeats + ' active of ' + (c.paidSeats ?? '?') + ' paid' + (c.utilisationPct != null ? ' (' + c.utilisationPct + '%)' : '') + (c.contractorSeats ? ', ' + c.contractorSeats + ' contractors' : '')),
          fact('Payroll', el('span', {}, payrollChip(c.payroll), ' ', (c.payroll.frequency ? c.payroll.frequency.toLowerCase().replace('_', '-') + ', ' : '') + (c.payroll.lastPayDate ? 'last paid ' + fmtDate(c.payroll.lastPayDate) : 'no payroll run yet'))),
          fact('Earned Wage Access', c.ewa.lastUsed ? 'Used ' + fmtDate(c.ewa.lastUsed) + (c.ewa.volume30dKobo && c.ewa.volume30dKobo !== '0' ? ', ' + money(c.ewa.volume30dKobo) + ' in 30 days' : '') : 'Not used'),
          fact('Statutory remittance', c.statutoryLastUsed ? 'Used ' + fmtDate(c.statutoryLastUsed) : 'Not used'),
          fact('Seats, last 90 days', sparkline(r.seatHistory)))),
      c.signals.length ? el('div', {}, el('strong', {}, 'Growth signals'), el('ul', { style: 'margin:6px 0' }, c.signals.map((x) => el('li', {}, x)))) : null,
      el('div', {}, el('strong', {}, 'Open alerts'), r.alerts.length ? el('div', { style: 'display:grid;gap:8px;margin-top:8px' }, r.alerts.map((a) => el('div', {}, el('span', { class: 'chip ' + a.severity }, a.severity), ' ', el('b', {}, a.title), el('span', { class: 'chip low', style: 'margin-left:6px' }, a.state), el('div', { class: 'small muted' }, a.summary)))) : el('p', { class: 'muted small' }, 'No open alerts.')),
      el('div', {}, el('strong', {}, 'Support tickets'), r.tickets.length ? el('ul', { style: 'margin:6px 0' }, r.tickets.map((t) => el('li', {}, (t.open ? 'Open ' + t.ageDays + 'd: ' : 'Closed: ') + t.subject + (t.reopenCount ? ' (reopened ' + t.reopenCount + 'x)' : '') + (t.sentiment != null && t.sentiment <= -1 ? ' (frustrated)' : '')))) : el('p', { class: 'muted small' }, 'No open or recently closed tickets.')),
      r.expansionRevenue12m.length ? el('div', {}, el('strong', {}, 'Expansion revenue, last 12 months'), el('ul', { style: 'margin:6px 0' }, r.expansionRevenue12m.map((x) => el('li', {}, (CAT[x.category] || x.category) + ': ' + money(x.amountKobo))))) : null,
      el('div', { id: 'db-qbr', class: 'detail', hidden: true })].filter(Boolean));
  } catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.message)); }
}

/* ---------- Adoption ---------- */
const adState = { data: null };
const ADMIN_CHIP = { active: ['ok', 'active'], quiet: ['medium', 'quiet'], dormant: ['high', 'dormant'], never: ['low', 'never logged in'] };
function loginCell(last, days, status) {
  const [cls, label] = ADMIN_CHIP[status];
  return el('div', {}, last ? el('div', {}, fmtDate(last), el('span', { class: 'small muted' }, ' · ' + (days === 0 ? 'today' : days + 'd ago'))) : el('div', { class: 'muted small' }, 'Never'), el('span', { class: 'chip ' + cls }, label));
}
const SLA_CHIP = { met: ['ok', 'met'], ok: ['low', 'on track'], at_risk: ['medium', 'at risk'], breached: ['urgent', 'breached'] };
const slaChip = (c, closed) => { const [cls, label] = SLA_CHIP[c.state]; return el('span', {}, el('span', { class: 'chip ' + cls }, label), el('div', { class: 'small muted' }, (Math.round(c.elapsedHours * 10) / 10) + 'h of ' + c.targetHours + 'h')); };
const chg = (n) => n == null ? '' : (n > 0 ? '+' : '') + n + '%';
const bar = (pct, color) => el('div', { style: 'height:6px;background:var(--blue-faint);border-radius:3px;width:120px;margin-top:4px' }, el('div', { style: 'height:6px;border-radius:3px;width:' + Math.min(pct || 0, 100) + '%;background:' + color }));
async function loadAdoption() {
  const who = $('ad-who');
  if (!who.dataset.wired) { who.dataset.wired = '1'; who.addEventListener('change', () => loadAdoption().catch((e) => notice(e.message, true))); $('ad-search').addEventListener('input', drawAdClients); }
  const keep = who.value;
  const d = await api('/adoption' + (keep ? '?csm=' + encodeURIComponent(keep) : ''));
  adState.data = d; $('ad-detail').hidden = true;
  $('ad-who-wrap').hidden = d.people.length <= 1;
  who.replaceChildren(el('option', { value: '' }, d.people.length > 1 && state.me.role !== 'csm' ? 'Everyone' : 'All my clients'), ...d.people.map((p) => el('option', { value: p.email, selected: p.email === keep }, (p.name || p.email))));
  who.value = keep;
  $('ad-asof').textContent = 'Data as of ' + fmtDate(d.asOf) + '. Employee activity covers the last 30 days against the 30 before.';
  $('ad-mod-note').textContent = d.modulesKnown ? 'Upsell means the client has not bought it, has no urgent or high alerts, and either already uses a related module or most customers have it.' : 'Modules bought are not available yet: the Control Panel view v_client_modules is not connected.';
  $('ad-matrix').replaceChildren(...(d.matrix.some((m) => m.purchased > 0 || m.upsellClients.length) ? d.matrix.map((m) => el('tr', { style: 'cursor:default' },
    el('td', {}, el('strong', {}, m.label)),
    el('td', {}, el('div', {}, m.purchased + (m.purchased === 1 ? ' client' : ' clients') + ' (' + m.purchasedPct + '%)'), bar(m.purchasedPct, 'var(--blue)')),
    el('td', {}, m.inUsePct == null ? el('span', { class: 'muted small' }, '–') : el('div', {}, m.inUse + ' of ' + m.purchased + ' (' + m.inUsePct + '%)', bar(m.inUsePct, m.inUsePct < 60 ? 'var(--high)' : 'var(--ok)'))),
    el('td', {}, m.unusedClients.length ? m.unusedClients.map((n) => el('span', { class: 'chip high', style: 'margin:0 4px 4px 0' }, n)) : el('span', { class: 'muted small' }, 'None')),
    el('td', {}, m.upsellClients.length ? m.upsellClients.map((x) => el('button', { class: 'chip low', style: 'margin:0 4px 4px 0;border:0;cursor:pointer', onclick: () => openAdoption(x.hubspotId) }, x.name)) : el('span', { class: 'muted small' }, 'None right now')))) : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No module data yet.'))]));
  drawAdClients();
}
function drawAdClients() {
  const d = adState.data; if (!d) return;
  const term = $('ad-search').value.trim().toLowerCase();
  const list = d.clients.filter((c) => !term || c.name.toLowerCase().includes(term)).sort((a, b) => (b.slaBreaches - a.slaBreaches) || ((b.primaryDaysSinceLogin ?? 9999) - (a.primaryDaysSinceLogin ?? 9999)));
  $('ad-clients').replaceChildren(...(list.length ? list.map((c) => el('tr', { onclick: () => openAdoption(c.hubspotId) },
    el('td', {}, el('strong', {}, c.name), d.clients.length > 1 && c.csmName ? el('div', { class: 'small muted' }, c.csmName) : null),
    el('td', {}, loginCell(c.primaryLastLoginAt, c.primaryDaysSinceLogin, c.primaryStatus)),
    el('td', {}, c.secondaryLastLoginAt || c.secondaryStatus !== 'never' ? loginCell(c.secondaryLastLoginAt, c.secondaryLastLoginAt ? Math.max(0, Math.round((Date.now() - Date.parse(c.secondaryLastLoginAt)) / 86400000)) : null, c.secondaryStatus) : el('span', { class: 'muted small' }, 'None on record')),
    el('td', {}, c.dailyActiveEmployees == null ? el('span', { class: 'muted small' }, '–') : el('div', {}, c.dailyActiveEmployees + ' a day', el('span', { class: 'small muted' }, c.engagementPct != null ? ' (' + c.engagementPct + '% of seats)' : ''), c.engagementPct != null ? bar(c.engagementPct, c.engagementPct < 30 ? 'var(--high)' : 'var(--blue)') : null)),
    el('td', {}, el('div', {}, c.activityLast30.toLocaleString('en-NG')), c.activityChangePct == null ? null : el('span', { class: 'small', style: 'font-weight:600;color:' + (c.activityChangePct < -20 ? 'var(--urgent)' : c.activityChangePct < 0 ? 'var(--high)' : 'var(--ok)') }, chg(c.activityChangePct))),
    el('td', {}, c.openTickets === 0 ? el('span', { class: 'muted small' }, 'No open tickets') : el('div', {}, c.slaBreaches ? el('span', { class: 'chip urgent' }, c.slaBreaches + ' past SLA') : null, c.slaAtRisk ? el('span', { class: 'chip medium', style: 'margin-left:4px' }, c.slaAtRisk + ' at risk') : null, !c.slaBreaches && !c.slaAtRisk ? el('span', { class: 'chip ok' }, c.openTickets + ' on track') : null)),
    el('td', {}, c.modules.known ? el('div', {}, c.modules.inUse + ' of ' + c.modules.purchased, c.modules.unused ? el('div', { class: 'small', style: 'color:var(--high)' }, c.modules.unused + ' unused') : null) : el('span', { class: 'muted small' }, '–')),
    el('td', {}, c.upsellReady ? el('span', { class: 'chip ok' }, c.upsellReady + ' ideas') : el('span', { class: 'muted small' }, '–')))) : [el('tr', {}, el('td', { colspan: '8', class: 'muted' }, 'No clients match.'))]));
}
async function openAdoption(id) {
  const box = $('ad-detail'); box.hidden = false; box.replaceChildren(el('p', { class: 'muted' }, 'Loading...')); box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await api('/adoption/clients/' + encodeURIComponent(id));
    const sec = (title, ...kids) => el('div', { style: 'display:grid;gap:10px' }, el('h3', { style: 'margin:8px 0 0;font-size:17px' }, title), ...kids);
    const tile = (label, value, note, cls) => el('div', { class: 'card stat' }, el('b', { style: cls ? 'color:var(--' + cls + ')' : '' }, value), el('span', {}, label), note ? el('span', { class: 'small muted' }, note) : null);
    // 1. administrators
    const admins = r.admins.length ? el('div', { class: 'grid2' }, r.admins.map((a) => el('div', { class: 'card detail' },
      el('div', { class: 'bar' }, el('strong', {}, a.name || a.email), el('span', { class: 'chip low' }, a.level === 'PRIMARY' ? 'Primary admin' : 'Secondary admin'), el('span', { class: 'chip ' + ADMIN_CHIP[a.status][0] }, ADMIN_CHIP[a.status][1])),
      el('div', { class: 'small muted' }, a.email),
      el('div', {}, a.lastLoginAt ? 'Last login ' + new Date(a.lastLoginAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }) + ' (' + (a.daysSinceLogin === 0 ? 'today' : a.daysSinceLogin + ' days ago') + ')' : 'Has never logged in'),
      el('div', { class: 'small muted' }, 'What they did in the last 30 days'),
      a.recentActions.length ? el('ul', { style: 'margin:0;padding-left:18px' }, a.recentActions.map((x) => el('li', {}, fmtDate(x.at) + ': ' + x.action))) : el('p', { class: 'muted small', style: 'margin:0' }, 'Nothing recorded.')))) : el('p', { class: 'muted' }, 'No administrators on record (the Control Panel view v_client_admins has nothing for this client).');
    // 2. employees
    const e = r.employees; const head = e.lines.filter((l) => ['SIGN_IN', 'LEAVE_REQUEST', 'LOAN_REQUEST', 'PROFILE_UPDATE'].includes(l.eventType));
    const have = new Set(head.map((l) => l.eventType));
    const tiles = ['SIGN_IN', 'LEAVE_REQUEST', 'LOAN_REQUEST', 'PROFILE_UPDATE'].map((t) => { const l = head.find((x) => x.eventType === t); return tile(({ SIGN_IN: 'Sign-ins', LEAVE_REQUEST: 'Leave requests', LOAN_REQUEST: 'Loan requests', PROFILE_UPDATE: 'Profile updates' })[t], l ? l.last30.toLocaleString('en-NG') : '0', l && l.changePct != null ? chg(l.changePct) + ' on the 30 days before' : (have.has(t) ? '' : 'No activity recorded')); });
    const maxW = Math.max(1, ...e.weekly.map((w) => Object.values(w.counts).reduce((a, b) => a + b, 0)));
    const chart = e.weekly.length ? el('div', {}, el('div', { class: 'small muted' }, 'Employee activity per week (sign-ins, leave, loans and profile updates)'), el('div', { style: 'display:flex;gap:6px;align-items:flex-end;height:84px;margin-top:6px' }, e.weekly.map((w) => { const t = Object.values(w.counts).reduce((a, b) => a + b, 0); return el('div', { style: 'flex:1;display:grid;gap:2px;justify-items:center', title: fmtDate(w.from) + ' to ' + fmtDate(w.to) + ': ' + t }, el('div', { class: 'small muted' }, String(t)), el('div', { style: 'width:100%;border-radius:3px 3px 0 0;background:var(--blue);height:' + Math.max(2, Math.round((t * 56) / maxW)) + 'px' })); })), el('div', { style: 'display:flex;gap:6px' }, e.weekly.map((w) => el('div', { class: 'small muted', style: 'flex:1;text-align:center;font-size:11px' }, fmtDate(w.from))))) : null;
    const others = e.lines.filter((l) => !['SIGN_IN', 'LEAVE_REQUEST', 'LOAN_REQUEST', 'PROFILE_UPDATE'].includes(l.eventType));
    // 3. support
    const sp = r.support; const ss = sp.summary;
    const support = [el('div', { class: 'grid2' }, tile('Open tickets', String(ss.open), ''), tile('Past SLA', String(ss.breached), 'Step in on these', ss.breached ? 'urgent' : null), tile('At risk of breaching', String(ss.atRisk), ''), tile('Average first reply', ss.avgFirstResponseHours == null ? '–' : ss.avgFirstResponseHours + 'h', ss.resolvedWithinSlaPct == null ? '' : ss.resolvedWithinSlaPct + '% of closed tickets resolved within target')),
      el('p', { class: 'small muted', style: 'margin:0' }, 'Targets: first reply ' + sp.targets.firstResponseHigh + 'h for high or urgent tickets, ' + sp.targets.firstResponseNormal + 'h for the rest. Resolution ' + sp.targets.resolutionHigh + 'h and ' + sp.targets.resolutionNormal + 'h. Counted in elapsed hours, including weekends.'),
      sp.tickets.length ? el('div', { class: 'card table-wrap' }, el('table', { style: 'min-width:820px' }, el('thead', {}, el('tr', {}, ['Ticket', 'Status', 'Raised by', 'Priority', 'Age', 'First reply', 'Resolution'].map((h) => el('th', {}, h)))), el('tbody', {}, sp.tickets.map((t) => el('tr', { style: 'cursor:default' },
        el('td', {}, el('strong', {}, t.subject), t.reopenCount ? el('div', { class: 'small', style: 'color:var(--high)' }, 'Reopened ' + t.reopenCount + 'x') : null), el('td', {}, el('span', { class: 'chip ' + (t.open ? 'low' : 'ok') }, t.status)),
        el('td', { class: 'small' }, t.raisedBy || '–'), el('td', { class: 'small' }, t.priority ? t.priority.toLowerCase() : '–'), el('td', { class: 'small' }, t.ageHours >= 48 ? Math.round(t.ageHours / 24) + ' days' : t.ageHours + 'h'),
        el('td', {}, slaChip(t.sla.firstResponse)), el('td', {}, slaChip(t.sla.resolution))))))) : el('p', { class: 'muted' }, 'No tickets in the last 90 days.')];
    // 4. modules
    const inUse = r.modules.filter((m) => m.status === 'in_use'); const unused = r.modules.filter((m) => m.status === 'unused');
    const modules = el('div', { class: 'grid2' },
      el('div', { class: 'card detail' }, el('strong', {}, 'In use (' + inUse.length + ')'), inUse.length ? el('ul', { style: 'margin:0;padding-left:18px' }, inUse.map((m) => el('li', {}, el('b', {}, m.label), el('span', { class: 'small muted' }, ' · ' + (m.events30 ? m.events30.toLocaleString('en-NG') + ' actions in 30 days' : 'active') + (m.lastActive ? ', last ' + fmtDate(m.lastActive) : '')))) ) : el('p', { class: 'muted small', style: 'margin:0' }, 'Nothing in use.')),
      el('div', { class: 'card detail' }, el('strong', {}, 'Bought but not used (' + unused.length + ')'), unused.length ? el('ul', { style: 'margin:0;padding-left:18px' }, unused.map((m) => el('li', {}, el('b', {}, m.label), el('span', { class: 'small muted' }, m.lastActive ? ' · last used ' + fmtDate(m.lastActive) : ' · never used')))) : el('p', { class: 'muted small', style: 'margin:0' }, 'Everything bought is being used.'), unused.length ? el('p', { class: 'small', style: 'margin:0;color:var(--high)' }, 'Bought but idle is a churn risk. Book a training call.') : null),
      el('div', { class: 'card detail', style: 'grid-column:1/-1' }, el('strong', {}, 'Possible upsell'), r.upsell.length ? el('div', { style: 'display:grid;gap:8px' }, r.upsell.filter((u) => u.reasons.length).slice(0, 5).map((u) => el('div', {}, el('b', {}, u.label), u.ready ? el('span', { class: 'chip ok', style: 'margin-left:6px' }, 'ready') : el('span', { class: 'chip high', style: 'margin-left:6px' }, 'hold: ' + u.holdReason), el('div', { class: 'small muted' }, u.reasons.join('. ') + '.')))) : el('p', { class: 'muted small', style: 'margin:0' }, r.modules.some((m) => m.status !== 'not_purchased') ? 'They already have every module.' : 'Modules bought are not available for this client.')));
    box.replaceChildren(
      el('div', { class: 'bar' }, el('strong', { style: 'color:var(--navy);font-size:20px;margin-right:auto' }, r.client.name), el('span', { class: 'small muted' }, 'CSM: ' + (r.client.csmName || r.client.csmEmail || 'Unassigned')), el('button', { class: 'btn', onclick: () => (box.hidden = true) }, 'Close')),
      sec('1. Administrators', admins),
      sec('2. Employee activity, last 30 days', el('div', { class: 'grid2' }, tiles), e.dailyActive != null ? el('p', { class: 'small muted', style: 'margin:0' }, 'About ' + e.dailyActive + ' employees sign in on a typical day' + (e.activeSeats ? ' (' + Math.min(100, Math.round(e.dailyActive * 100 / e.activeSeats)) + '% of ' + e.activeSeats + ' active seats).' : '.')) : null, chart, others.length ? el('p', { class: 'small', style: 'margin:0' }, 'Other activity: ' + others.map((l) => l.label.toLowerCase() + ' ' + l.last30.toLocaleString('en-NG') + (l.changePct != null ? ' (' + chg(l.changePct) + ')' : '')).join(', ') + '.') : null),
      sec('3. Support tickets and SLA', ...support),
      sec('4. Modules: in use, idle and open for upsell', modules));
  } catch (err) { box.replaceChildren(el('p', { class: 'muted' }, err.message)); }
}
`;
