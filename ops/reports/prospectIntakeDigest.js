#!/usr/bin/env node
// Review queue for runProspectIntake.js: emails every prospect scored (and
// any Day-1 outreach drafted) since the last digest, for a human to decide
// who's worth pursuing and to send/edit the Day-1 drafts by hand. Mirrors
// invoiceFollowUpDigest.js's structure exactly.

import crypto from 'node:crypto';
import { queryEvents, appendEvent } from '../../lib/events/store.js';
import { sendEmailViaSes } from '../../lib/outreach/sesTransport.js';

const DATA_DIR = '.e3d-corp/instance/hvac-sandbox';
const DIGEST_TO_ENV_VAR = 'FUTCO_DIGEST_TO_EMAIL';

const OUTREACH_CONFIG = {
  outreach: { provider: 'ses', region: 'us-east-2', fromEmail: 'outreach@e3d.ai' }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function lastDigestSentAt(dataDir) {
  const sent = queryEvents(dataDir, { type: 'prospectIntakeDigest.sent' });
  if (sent.length === 0) return null;
  return sent[sent.length - 1].occurredAt;
}

function draftsByProspectId(drafts) {
  const map = new Map();
  for (const draft of drafts) map.set(draft.subject.id, draft);
  return map;
}

function buildTextBody(scored, draftsById) {
  const lines = [`HVAC prospecting - ${scored.length} prospect(s) scored since last digest`, ''];
  scored.forEach((event, index) => {
    const { business, leakHypothesis, score, maxScore, tier } = event.payload;
    const draft = draftsById.get(event.subject.id);
    lines.push(
      `${index + 1}. ${business.name} (${business.location ?? 'location unknown'}) - Tier ${tier}, ${score}/${maxScore}`,
      `   Leak hypothesis: ${leakHypothesis}`
    );
    if (draft) {
      lines.push(`   Day-1 ${draft.payload.channel} draft - Subject: ${draft.payload.draftSubject ?? '(none)'}`, `   DRAFT: ${draft.payload.draftBody}`);
    } else if (tier !== 'archive') {
      lines.push('   No Day-1 draft (leak hypothesis was too vague).');
    }
    lines.push('');
  });
  return lines.join('\n');
}

function buildHtmlBody(scored, draftsById) {
  const items = scored
    .map((event) => {
      const { business, leakHypothesis, score, maxScore, tier } = event.payload;
      const draft = draftsById.get(event.subject.id);
      const draftBlock = draft
        ? `<p style="margin:6px 0 0;font-size:13px;">Day-1 ${escapeHtml(draft.payload.channel)} draft &mdash; <strong>${escapeHtml(draft.payload.draftSubject ?? '')}</strong></p>
      <p style="margin:4px 0 0;padding:10px 12px;background:#f4f4f6;border-radius:6px;white-space:pre-wrap;">${escapeHtml(draft.payload.draftBody)}</p>`
        : tier !== 'archive'
          ? '<p style="margin:6px 0 0;font-size:13px;color:#999;">No Day-1 draft (leak hypothesis was too vague).</p>'
          : '';
      return `
    <div style="margin:0 0 22px;padding:14px 16px;border:1px solid #e0e0e4;border-radius:8px;">
      <p style="margin:0 0 6px;font-weight:600;">${escapeHtml(business.name)} <span style="font-weight:400;color:#666;">(${escapeHtml(business.location ?? 'location unknown')})</span></p>
      <p style="margin:0 0 6px;color:#666;font-size:13px;">Tier ${escapeHtml(tier)} &mdash; ${escapeHtml(score)}/${escapeHtml(maxScore)}</p>
      <p style="margin:0;font-size:13px;">${escapeHtml(leakHypothesis)}</p>
      ${draftBlock}
    </div>`;
    })
    .join('');

  return `
<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">
  <h1 style="font-size:19px;margin:0 0 18px;">HVAC prospecting &mdash; ${scored.length} prospect(s) scored</h1>
  ${items}
  <p style="font-size:13px;color:#666;border-top:1px solid #e0e0e4;padding-top:14px;">Tier A/B have a Day-1 draft ready to edit and send by hand. Archive-tier prospects are logged, not pursued.</p>
</div>`.trim();
}

async function main() {
  const to = process.env[DIGEST_TO_ENV_VAR];
  if (!to) {
    throw new Error(`Env var "${DIGEST_TO_ENV_VAR}" is not set`);
  }

  const since = lastDigestSentAt(DATA_DIR);
  const scored = queryEvents(DATA_DIR, { type: 'prospect.scored', since: since ?? undefined });
  const drafts = queryEvents(DATA_DIR, { type: 'prospectOutreach.drafted', since: since ?? undefined });

  if (scored.length === 0) {
    process.stdout.write('No new prospects scored since the last digest - nothing sent.\n');
    return;
  }

  const draftsById = draftsByProspectId(drafts);
  const subject = `HVAC prospecting — ${scored.length} prospect(s) scored`;
  const result = await sendEmailViaSes({
    instanceConfig: OUTREACH_CONFIG,
    to,
    subject,
    body: buildTextBody(scored, draftsById),
    htmlBody: buildHtmlBody(scored, draftsById)
  });

  appendEvent(DATA_DIR, {
    type: 'prospectIntakeDigest.sent',
    source: 'ops.prospectIntakeDigest',
    subject: { type: 'prospectIntakeDigest', id: result.messageId ?? crypto.randomUUID() },
    payload: { to, scoredCount: scored.length, draftCount: drafts.length },
    correlationId: crypto.randomUUID()
  });

  process.stdout.write(`Sent prospecting digest (${scored.length} scored, ${drafts.length} draft(s)) to ${to} (messageId=${result.messageId})\n`);
}

main().catch((error) => {
  process.stderr.write(`Prospect intake digest failed: ${error.message}\n`);
  process.exitCode = 1;
});
