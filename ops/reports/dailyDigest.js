#!/usr/bin/env node
// Daily email digest for a single e3d-corp instance: what discovery found
// since yesterday, what's waiting on approval in /proposals, and the
// cumulative evaluation metrics. Run by cron shortly after the scheduled
// discovery pass; sends via the same SES transport Phase 7's outreach uses.
// Sends both an HTML (tables) and plain-text version of the same content.

import { loadInstance } from '../../lib/config.js';
import { listOpportunities } from '../../lib/opportunities/store.js';
import { listProposals } from '../../lib/proposals/store.js';
import { computeMetrics } from '../../lib/evaluation/metrics.js';
import { sendEmailViaSes } from '../../lib/outreach/sesTransport.js';

const DIGEST_RECIPIENT_ENV_VAR = 'FUTCO_DIGEST_TO_EMAIL';

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : 'unknown';
}

function formatScore(opportunity) {
  return opportunity.score?.value !== undefined ? opportunity.score.value.toFixed(2) : '?.??';
}

function formatRate(rate) {
  return rate === null || rate === undefined ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

// ---------- plain-text fallback ----------

const RULE = '-'.repeat(48);

function section(title, count) {
  return [`${title}${count !== undefined ? ` (${count})` : ''}`, RULE];
}

function formatOpportunityTextEntry(opportunity, index) {
  return [
    `${index + 1}. [${formatScore(opportunity)}] ${opportunity.title}`,
    `   ${opportunity.type} - ${opportunity.status ?? 'unknown'} - id ${shortId(opportunity.id)}`
  ].join('\n');
}

function formatProposalTextEntry(proposal, index) {
  const label = proposal.payload?.subject ?? proposal.payload?.opportunityTitle ?? '(untitled)';
  return [
    `${index + 1}. [level ${proposal.authorityLevel}] ${proposal.type}: ${label}`,
    `   proposed by ${proposal.proposedBy?.role ?? 'unknown'} - id ${shortId(proposal.id)}`
  ].join('\n');
}

function buildTextBody({ instanceName, dateLabel, newOpportunities, pendingProposals, metrics }) {
  const lines = [];
  lines.push(`FutCo daily digest - ${instanceName} - ${dateLabel}`);
  lines.push('');

  lines.push(...section('NEW OPPORTUNITIES', newOpportunities.length));
  lines.push(
    newOpportunities.length === 0
      ? '(none since yesterday)'
      : newOpportunities.map(formatOpportunityTextEntry).join('\n')
  );
  lines.push('');

  lines.push(...section('PENDING PROPOSALS - awaiting your decision', pendingProposals.length));
  lines.push(
    pendingProposals.length === 0 ? '(none pending)' : pendingProposals.map(formatProposalTextEntry).join('\n')
  );
  lines.push('');

  lines.push(...section('CUMULATIVE METRICS'));
  lines.push(`Opportunities discovered: ${metrics.opportunitiesDiscovered.total}`);
  for (const [type, count] of Object.entries(metrics.opportunitiesDiscovered.byType)) {
    lines.push(`  ${type}: ${count}`);
  }
  lines.push(
    `Opportunity acceptance: pursuing=${metrics.opportunityAcceptance.pursuing} no-value=${metrics.opportunityAcceptance.noValue} rate=${formatRate(metrics.opportunityAcceptance.rate)}`
  );
  lines.push(
    `Proposal rejection: approved=${metrics.proposalRejection.approved} rejected=${metrics.proposalRejection.rejected} rate=${formatRate(metrics.proposalRejection.rate)}`
  );
  lines.push(
    `Outreach funnel: sent=${metrics.outreach.sent} replied=${metrics.outreach.replied} (${formatRate(metrics.outreach.responseRate)}) meetingsBooked=${metrics.outreach.meetingsBooked} (${formatRate(metrics.outreach.meetingBookedRate)}) dealsWon=${metrics.outreach.dealsWon} (${formatRate(metrics.outreach.dealWinRate)})`
  );
  lines.push(`Revenue attributable: ${metrics.revenueAttributable}`);
  lines.push(`Useful opportunities: ${metrics.usefulOpportunityCount}`);
  lines.push(
    `Cost per useful opportunity: ${metrics.costPerUsefulOpportunity === null ? 'n/a' : metrics.costPerUsefulOpportunity}`
  );
  lines.push('');

  lines.push(RULE);
  lines.push('Review at http://localhost:3010, or:');
  lines.push('  e3d-corp opportunities list');
  lines.push('  e3d-corp proposals list --status pending');

  return lines.join('\n');
}

// ---------- HTML (tables) ----------

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const MONO = "font-family:SFMono-Regular,Consolas,'Liberation Mono',monospace;";
const TABLE = `width:100%;border-collapse:collapse;margin:6px 0 24px;${FONT}font-size:14px;`;
const TH = 'text-align:left;padding:8px 10px;background:#f4f4f6;border-bottom:2px solid #d8d8dc;font-weight:600;color:#333;white-space:nowrap;';
const TD = 'padding:8px 10px;border-bottom:1px solid #ececee;color:#222;vertical-align:top;';
const TD_ID = `${TD}${MONO}font-size:12px;color:#888;white-space:nowrap;`;
const TD_NUM = `${TD}text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;`;
const H2 = `${FONT}font-size:15px;font-weight:700;color:#1a1a1a;margin:28px 0 4px;`;
const EMPTY = `${FONT}color:#888;font-size:13px;padding:6px 2px 18px;`;

function table(headers, rows) {
  const head = `<tr>${headers.map((h) => `<th style="${TH}">${h}</th>`).join('')}</tr>`;
  const body = rows.map((cells) => `<tr>${cells.join('')}</tr>`).join('');
  return `<table role="presentation" style="${TABLE}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function opportunitiesTableHtml(newOpportunities) {
  if (newOpportunities.length === 0) {
    return `<p style="${EMPTY}">None since yesterday.</p>`;
  }
  const rows = newOpportunities.map((opportunity) => [
    `<td style="${TD_NUM}"><strong>${escapeHtml(formatScore(opportunity))}</strong></td>`,
    `<td style="${TD}">${escapeHtml(opportunity.title)}</td>`,
    `<td style="${TD}">${escapeHtml(opportunity.type)}</td>`,
    `<td style="${TD}">${escapeHtml(opportunity.status ?? 'unknown')}</td>`,
    `<td style="${TD_ID}">${escapeHtml(shortId(opportunity.id))}</td>`
  ]);
  return table(['Score', 'Title', 'Type', 'Status', 'ID'], rows);
}

function proposalsTableHtml(pendingProposals) {
  if (pendingProposals.length === 0) {
    return `<p style="${EMPTY}">None pending.</p>`;
  }
  const rows = pendingProposals.map((proposal) => [
    `<td style="${TD_NUM}">${escapeHtml(proposal.authorityLevel)}</td>`,
    `<td style="${TD}">${escapeHtml(proposal.payload?.subject ?? proposal.payload?.opportunityTitle ?? '(untitled)')}</td>`,
    `<td style="${TD}">${escapeHtml(proposal.type)}</td>`,
    `<td style="${TD}">${escapeHtml(proposal.proposedBy?.role ?? 'unknown')}</td>`,
    `<td style="${TD_ID}">${escapeHtml(shortId(proposal.id))}</td>`
  ]);
  return table(['Level', 'Title', 'Type', 'Proposed by', 'ID'], rows);
}

function metricsSummaryTableHtml(metrics) {
  const rows = [
    ['Opportunities discovered', metrics.opportunitiesDiscovered.total],
    [
      'Opportunity acceptance',
      `pursuing=${metrics.opportunityAcceptance.pursuing}, no-value=${metrics.opportunityAcceptance.noValue}, rate=${formatRate(metrics.opportunityAcceptance.rate)}`
    ],
    [
      'Proposal rejection',
      `approved=${metrics.proposalRejection.approved}, rejected=${metrics.proposalRejection.rejected}, rate=${formatRate(metrics.proposalRejection.rate)}`
    ],
    [
      'Outreach funnel',
      `sent=${metrics.outreach.sent}, replied=${metrics.outreach.replied} (${formatRate(metrics.outreach.responseRate)}), meetings=${metrics.outreach.meetingsBooked} (${formatRate(metrics.outreach.meetingBookedRate)}), won=${metrics.outreach.dealsWon} (${formatRate(metrics.outreach.dealWinRate)})`
    ],
    ['Revenue attributable', metrics.revenueAttributable],
    ['Useful opportunities', metrics.usefulOpportunityCount],
    [
      'Cost per useful opportunity',
      metrics.costPerUsefulOpportunity === null ? 'n/a' : metrics.costPerUsefulOpportunity
    ]
  ];
  return table(
    ['Metric', 'Value'],
    rows.map(([label, value]) => [
      `<td style="${TD}"><strong>${escapeHtml(label)}</strong></td>`,
      `<td style="${TD}">${escapeHtml(value)}</td>`
    ])
  );
}

function metricsByTypeTableHtml(metrics) {
  const entries = Object.entries(metrics.opportunitiesDiscovered.byType);
  if (entries.length === 0) {
    return `<p style="${EMPTY}">No opportunities discovered yet.</p>`;
  }
  return table(
    ['Type', 'Count'],
    entries.map(([type, count]) => [`<td style="${TD}">${escapeHtml(type)}</td>`, `<td style="${TD_NUM}">${escapeHtml(count)}</td>`])
  );
}

function buildHtmlBody({ instanceName, dateLabel, newOpportunities, pendingProposals, metrics }) {
  return `
<div style="${FONT}max-width:680px;margin:0 auto;color:#1a1a1a;">
  <h1 style="${FONT}font-size:19px;margin:0 0 20px;">FutCo daily digest &mdash; ${escapeHtml(instanceName)} &mdash; ${escapeHtml(dateLabel)}</h1>

  <h2 style="${H2}">New opportunities (${newOpportunities.length})</h2>
  ${opportunitiesTableHtml(newOpportunities)}

  <h2 style="${H2}">Pending proposals &mdash; awaiting your decision (${pendingProposals.length})</h2>
  ${proposalsTableHtml(pendingProposals)}

  <h2 style="${H2}">Cumulative metrics</h2>
  ${metricsSummaryTableHtml(metrics)}

  <h2 style="${H2}">Opportunities discovered by type</h2>
  ${metricsByTypeTableHtml(metrics)}

  <p style="${FONT}font-size:13px;color:#666;border-top:1px solid #e0e0e4;padding-top:14px;margin-top:8px;">
    Review at <a href="http://localhost:3010" style="color:#2952cc;">http://localhost:3010</a>, or run
    <code style="${MONO}background:#f4f4f6;padding:1px 5px;border-radius:3px;">e3d-corp opportunities list</code> /
    <code style="${MONO}background:#f4f4f6;padding:1px 5px;border-radius:3px;">e3d-corp proposals list --status pending</code>.
  </p>
</div>`.trim();
}

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const to = process.env[DIGEST_RECIPIENT_ENV_VAR];
  if (!to) {
    throw new Error(`Digest recipient env var "${DIGEST_RECIPIENT_ENV_VAR}" is not set`);
  }

  const { config, dataDir } = loadInstance(instanceName);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const newOpportunities = listOpportunities(dataDir)
    .filter((opportunity) => opportunity.createdAt && opportunity.createdAt >= since)
    .filter((opportunity) => opportunity.status !== 'no-value')
    .sort((a, b) => (b.score?.value ?? -Infinity) - (a.score?.value ?? -Infinity));
  const pendingProposals = listProposals(dataDir, { status: 'pending' });
  const metrics = computeMetrics(dataDir);

  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const context = { instanceName, dateLabel, newOpportunities, pendingProposals, metrics };
  const body = buildTextBody(context);
  const htmlBody = buildHtmlBody(context);
  const subject = `FutCo daily digest — ${newOpportunities.length} new, ${pendingProposals.length} pending — ${now.toISOString().slice(0, 10)}`;

  const result = await sendEmailViaSes({ instanceConfig: config, to, subject, body, htmlBody });
  process.stdout.write(`Sent daily digest to ${to} (messageId=${result.messageId})\n`);
}

main().catch((error) => {
  process.stderr.write(`Daily digest failed: ${error.message}\n`);
  process.exitCode = 1;
});
