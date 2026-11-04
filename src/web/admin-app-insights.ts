/**
 * Screens for phases 3 and 4: Reports, Growth & onboarding (radar, scorecard), Support themes,
 * Broadcasts. Plain JS added to the admin app. Everything from the API is written with
 * textContent (via el()), never innerHTML. No backticks in here: this is embedded in a template.
 */
export const INSIGHTS_HTML = /* html */ `
  <section id="view-reports" hidden>
    <div class="bar" style="margin-bottom:12px">
      <h2 style="margin-right:auto">Reports</h2>
      <label class="small">Report <select id="rp-audience"></select></label>
      <label class="small">Period <select id="rp-cadence"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="monthly">Monthly</option></select></label>
      <input id="rp-csm" type="email" placeholder="CSM email" aria-label="CSM email" hidden>
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
const NAV_EXTRA = [['reports', 'Reports'], ['cx', 'Growth'], ['support', 'Support'], ['broadcasts', 'Broadcasts']];
const ALL_VIEWS = ['alerts', 'rules', 'teams', 'recon', 'reports', 'cx', 'support', 'broadcasts'];
const AUDIENCE_LABELS = { executive: 'Leadership', csm: 'CSM portfolio', implementation: 'Implementation', support: 'Support' };
const ROLE_AUDIENCES = { csm: ['csm'], implementation_manager: ['implementation'], support_specialist: ['support'] };
for (const [v, label] of NAV_EXTRA) $('nav').append(el('button', { 'data-view': v }, label));
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
  if (!sel.options.length) {
    const allowed = ROLE_AUDIENCES[state.me.role] || Object.keys(AUDIENCE_LABELS);
    for (const a of allowed) sel.append(el('option', { value: a }, AUDIENCE_LABELS[a]));
    sel.addEventListener('change', () => { $('rp-csm').hidden = !(sel.value === 'csm' && state.me.role !== 'csm'); });
    $('rp-go').addEventListener('click', () => showReport().catch((e) => notice(e.message, true)));
    $('rp-csm').hidden = !(sel.value === 'csm' && state.me.role !== 'csm');
  }
  await showReport();
  if (['csm', 'implementation_manager', 'support_specialist'].includes(state.me.role)) { $('rp-sched').closest('div').hidden = true; return; }
  const rows = await api('/reports/schedules');
  const names = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  $('rp-sched').replaceChildren(...rows.map((r) => el('tr', { style: 'cursor:default' }, el('td', {}, AUDIENCE_LABELS[r.audience]), el('td', {}, names[r.cadence]), el('td', { class: 'small muted' }, r.channels.join(', ')),
    el('td', {}, el('input', { type: 'checkbox', checked: r.enabled, disabled: state.me.role !== 'cs_director', 'aria-label': 'Send ' + r.key, onchange: async (e) => { try { await api('/reports/schedules/' + r.key, { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) }); notice('Saved'); } catch (err) { e.target.checked = !e.target.checked; notice(err.message, true); } } })))));
}
async function showReport() {
  const q = new URLSearchParams({ audience: $('rp-audience').value, cadence: $('rp-cadence').value });
  if ($('rp-audience').value === 'csm' && state.me.role !== 'csm') { if (!$('rp-csm').value) { $('rp-body').replaceChildren(el('p', { class: 'muted' }, 'Enter a CSM email to see their report.')); return; } q.set('csm', $('rp-csm').value.trim()); }
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
async function openQbr(entry) {
  const box = $('cx-qbr'); box.hidden = false; box.replaceChildren(el('p', { class: 'muted' }, 'Drafting the QBR for ' + entry.name + '...'));
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
`;
