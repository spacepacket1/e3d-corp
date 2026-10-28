const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const TABLE = `width:100%;border-collapse:collapse;margin:6px 0 18px;${FONT}font-size:14px;`;
const TH = 'text-align:left;padding:8px 10px;background:#f4f4f6;border-bottom:2px solid #d8d8dc;font-weight:600;color:#333;white-space:nowrap;';
const TD = 'padding:8px 10px;border-bottom:1px solid #ececee;color:#222;vertical-align:top;';
const NUM = `${TD}text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;`;
const EMPTY = `${FONT}color:#888;font-size:13px;padding:6px 2px 14px;`;
const show = (v) => (v === null || v === undefined ? 'n/a' : v);
const delta = (d) => (d === null ? '' : ` <span style="color:${d < 0 ? '#b42318' : '#1a7f37'};">(${d >= 0 ? '+' : ''}${esc(d)})</span>`);

function table(headers, rows) {
  return `<table role="presentation" style="${TABLE}"><thead><tr>${headers.map((h) => `<th style="${TH}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.join('')}</tr>`).join('')}</tbody></table>`;
}

// The Pilot block of the email digest. `summary` is lib/pilot/summary.js buildPilotSummary().
export function renderPilotDigestHtml(s) {
  if (!s.available) {
    return `<p style="${EMPTY}">No Pilot metrics sampled yet.${s.lastDegradedAt ? ` Last attempt failed at ${esc(s.lastDegradedAt)}: ${esc(s.lastDegradedReason ?? 'unavailable')}.` : ''}</p>`;
  }
  const r = s.revenue, h = s.health, u = s.usage;
  const alarms = Array.isArray(h.billingAlarms) ? h.billingAlarms : [];
  const funnel = table(['Funnel', 'Now', s.hasYesterday ? 'vs ~24h ago' : 'vs yesterday'],
    s.funnel.map((f) => [`<td style="${TD}">${esc(f.key)}</td>`, `<td style="${NUM}"><strong>${esc(show(f.value))}</strong></td>`, `<td style="${NUM}">${f.yesterday === null ? 'n/a' : esc(f.yesterday)}${delta(f.delta)}</td>`]));
  const facts = table(['Metric', 'Value'], [
    ['Debates (24h / 7d)', `${show(u.debatesWindow)} / ${show(u.debates7d)}`],
    ['Errors (window)', show(u.errorsWindow)],
    ['Packs sold (window)', `${show(r.packsSoldWindow)} = $${show(r.packsRevenueUsdWindow)} (7d $${show(r.packsRevenueUsd7d)})`],
    ['MRR', `$${show(r.mrrUsd)}`],
    ['Refunds / open disputes / frozen subs', `${show(r.refundsWindow)} / ${show(r.disputesOpen)} / ${show(r.frozenSubscriptions)}`],
    ['Billing alarms', alarms.length === 0 ? '0' : `${alarms.length}: ${alarms.slice(0, 3).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('; ')}`],
    ['Last webhook / last debate', `${show(h.lastWebhookAgeMinutes)} / ${show(h.lastDebateAgeMinutes)} min ago`]
  ].map(([k, v]) => [`<td style="${TD}"><strong>${esc(k)}</strong></td>`, `<td style="${TD}">${esc(v)}</td>`]));
  const opps = s.opportunities.length === 0
    ? `<p style="${EMPTY}">No open Pilot opportunities.</p>`
    : table(['Score', 'Open Pilot opportunities', 'ID'], s.opportunities.map((o) => [
      `<td style="${NUM}"><strong>${esc(o.score?.value !== undefined ? o.score.value.toFixed(2) : '?.??')}</strong></td>`,
      `<td style="${TD}">${esc(o.title)}</td>`,
      `<td style="${TD}">${esc(o.id.slice(0, 8))}</td>`]));
  const stale = s.stale ? `<p style="${FONT}color:#b42318;font-size:13px;">Latest sample is ${esc(s.sampleAgeMinutes)} minutes old: the monitor may be failing.</p>` : '';
  return `<p style="${FONT}font-size:13px;color:#666;margin:4px 0;">Sampled ${esc(s.sampledAt)}</p>${stale}${funnel}${facts}${opps}`;
}
