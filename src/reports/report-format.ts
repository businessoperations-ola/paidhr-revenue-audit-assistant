import { BRAND, escapeHtml } from '../alerts/message-format.js';
import type { ReportData, Section, Tone } from './report-types.js';

const TONE: Record<Tone, string> = { good: '#027A48', warn: '#B54708', bad: '#C4320A' };
const SEV: Record<string, { fg: string; bg: string }> = {
  urgent: { fg: '#C4320A', bg: '#FDEEE8' },
  high: { fg: '#B54708', bg: '#FEF3E2' },
  medium: { fg: '#8A6100', bg: '#FFF6D6' },
  low: { fg: '#485266', bg: '#EEF0F5' },
};

const h = escapeHtml;

function sectionHtml(s: Section): string {
  const heading = (t?: string) => (t ? `<div style="font-size:16px;font-weight:700;color:${BRAND.navy};margin:24px 0 10px">${h(t)}</div>` : '');
  switch (s.kind) {
    case 'kpis': {
      const rows: string[] = [];
      for (let i = 0; i < s.items.length; i += 3) {
        const cells = s.items.slice(i, i + 3).map(
          (k) => `<td width="33%" valign="top" style="padding:0 6px 12px 0"><div style="background:${BRAND.page};border-radius:8px;padding:12px 14px">
<div style="font-size:12px;color:${BRAND.muted}">${h(k.label)}</div>
<div style="font-size:20px;font-weight:700;color:${k.tone ? TONE[k.tone] : BRAND.navy};margin:2px 0">${h(k.value)}</div>
${k.note ? `<div style="font-size:12px;color:${BRAND.muted}">${h(k.note)}</div>` : ''}</div></td>`,
        );
        while (cells.length < 3) cells.push('<td width="33%"></td>');
        rows.push(`<tr>${cells.join('')}</tr>`);
      }
      return `${heading(s.heading)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
    }
    case 'table': {
      if (s.rows.length === 0) return `${heading(s.heading)}<div style="font-size:14px;color:${BRAND.muted}">${h(s.empty ?? 'Nothing to show.')}</div>`;
      const head = s.columns.map((c) => `<th align="left" style="padding:8px 10px;font-size:12px;color:${BRAND.muted};background:${BRAND.page};border-bottom:1px solid ${BRAND.line}">${h(c)}</th>`).join('');
      const body = s.rows
        .map((r) => `<tr>${r.map((cell, i) => {
          const chip = s.columns[i] === 'Level' ? SEV[cell] : undefined;
          const content = chip ? `<span style="display:inline-block;font-size:12px;font-weight:600;color:${chip.fg};background:${chip.bg};border-radius:999px;padding:2px 9px;text-transform:capitalize">${h(cell)}</span>` : h(cell);
          return `<td valign="top" style="padding:8px 10px;font-size:13px;color:${BRAND.midnight};border-bottom:1px solid ${BRAND.line}">${content}</td>`;
        }).join('')}</tr>`)
        .join('');
      return `${heading(s.heading)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-radius:8px"><tr>${head}</tr>${body}</table>`;
    }
    case 'bridge': {
      const rows = s.steps
        .map((st) => {
          const color = st.type === 'up' ? '#027A48' : st.type === 'down' ? '#C4320A' : BRAND.navy;
          const weight = st.type === 'start' || st.type === 'end' ? 700 : 500;
          return `<tr><td style="padding:7px 10px;font-size:14px;color:${BRAND.midnight};font-weight:${weight};border-bottom:1px solid ${BRAND.line}">${h(st.label)}</td><td align="right" style="padding:7px 10px;font-size:14px;color:${color};font-weight:${weight};border-bottom:1px solid ${BRAND.line}">${h(st.value)}</td></tr>`;
        })
        .join('');
      return `${heading(s.heading)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-radius:8px">${rows}</table>`;
    }
    case 'list':
      return `${heading(s.heading)}${s.items.length === 0 ? `<div style="font-size:14px;color:${BRAND.muted}">${h(s.empty ?? 'Nothing to show.')}</div>` : `<ul style="margin:0;padding-left:20px;font-size:14px;color:${BRAND.midnight};line-height:1.6">${s.items.map((i) => `<li>${h(i)}</li>`).join('')}</ul>`}`;
    case 'text':
      return `${heading(s.heading)}<p style="margin:0;font-size:14px;color:${BRAND.midnight}">${h(s.text)}</p>`;
    case 'notice':
      return `<div style="margin:16px 0;padding:10px 14px;background:#FFF6D6;border-radius:8px;font-size:13px;color:#8A6100">${h(s.text)}</div>`;
  }
}

/** Branded HTML email for a report, in the same layout as the alert emails. */
export function reportHtml(r: ReportData, logoUrl: string | null, appUrl: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};font-family:${BRAND.font}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.line}">
  <tr><td style="background:${BRAND.blue};padding:20px 28px">${logoUrl ? `<img src="${h(logoUrl)}" alt="PaidHR" height="28" style="display:block;height:28px;width:auto;border:0">` : `<span style="color:#ffffff;font-size:20px;font-weight:700">PaidHR</span>`}</td></tr>
  <tr><td style="height:4px;background:${BRAND.yellow};line-height:4px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:24px 28px 8px">
    <div style="font-size:24px;font-weight:700;color:${BRAND.navy}">${h(r.title)}</div>
    <div style="font-size:14px;color:${BRAND.muted};margin-top:4px">${h(r.subtitle)}</div>
    ${r.sections.map(sectionHtml).join('\n')}
    <div style="margin:28px 0 20px"><a href="${h(appUrl)}" style="display:inline-block;background:${BRAND.blue};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px">Open in the Audit Assistant</a></div>
  </td></tr>
  <tr><td style="background:${BRAND.midnight};padding:14px 28px;font-size:12px;color:#ffffff">PaidHR <span style="color:${BRAND.yellow};font-weight:600">Revenue &amp; Data Audit Assistant</span></td></tr>
</table></td></tr></table></body></html>`;
}

/** Plain-text version of the same report. */
export function reportText(r: ReportData, appUrl: string): string {
  const out: string[] = [r.title, r.subtitle, ''];
  for (const s of r.sections) {
    switch (s.kind) {
      case 'kpis':
        if (s.heading) out.push(s.heading.toUpperCase());
        for (const k of s.items) out.push(`${k.label}: ${k.value}${k.note ? ` (${k.note})` : ''}`);
        break;
      case 'table':
        out.push(s.heading.toUpperCase());
        if (s.rows.length === 0) out.push(s.empty ?? 'Nothing to show.');
        else {
          out.push(s.columns.join(' | '));
          for (const row of s.rows) out.push(row.join(' | '));
        }
        break;
      case 'bridge':
        out.push(s.heading.toUpperCase());
        for (const st of s.steps) out.push(`${st.label}: ${st.value}`);
        break;
      case 'list':
        out.push(s.heading.toUpperCase());
        if (s.items.length === 0) out.push(s.empty ?? 'Nothing to show.');
        for (const i of s.items) out.push(`- ${i}`);
        break;
      case 'text':
        if (s.heading) out.push(s.heading.toUpperCase());
        out.push(s.text);
        break;
      case 'notice':
        out.push(`Note: ${s.text}`);
        break;
    }
    out.push('');
  }
  out.push(`Open in the Audit Assistant: ${appUrl}`);
  return out.join('\n');
}

const chatSafe = (s: string) => s.replace(/[<>]/g, '');

/** A short Google Chat summary: the headline numbers, the top rows of the first table, and a link. */
export function reportChat(r: ReportData, appUrl: string): string {
  const lines = [`📊 *${chatSafe(r.title)}*`, chatSafe(r.subtitle)];
  const kpis = r.sections.find((s): s is Extract<Section, { kind: 'kpis' }> => s.kind === 'kpis');
  if (kpis) lines.push('', ...kpis.items.map((k) => `*${chatSafe(k.label)}:* ${chatSafe(k.value)}${k.note ? ` (${chatSafe(k.note)})` : ''}`));
  const table = r.sections.find((s): s is Extract<Section, { kind: 'table' }> => s.kind === 'table' && s.rows.length > 0 && s.columns[0] === 'Level');
  if (table) {
    lines.push('', `*${chatSafe(table.heading)}*`, ...table.rows.slice(0, 3).map((row) => `• ${chatSafe(row[0]!)}: ${chatSafe(row[1]!)}: ${chatSafe(row[2]!.slice(0, 140))}`));
    if (table.rows.length > 3) lines.push(`…and ${table.rows.length - 3} more`);
  }
  lines.push('', `<${appUrl}|Open the full report>`);
  return lines.join('\n');
}
