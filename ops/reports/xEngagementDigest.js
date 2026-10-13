#!/usr/bin/env node
// Review queue for ops/reports/runXEngagement.js's drafts: emails every
// x.draftQueued event since the last digest, each with the tweet link, the
// matched topic, the real e3d.ai finding it's grounded in, and the draft
// text - ready to edit and post by hand in well under a minute each. This
// human-in-the-loop step is the whole reason the engagement pipeline is safe
// to run unattended: it finds and drafts, a person decides and posts.

import crypto from 'node:crypto';
import { loadInstance } from '../../lib/config.js';
import { queryEvents, appendEvent } from '../../lib/events/store.js';
import { sendEmailViaSes } from '../../lib/outreach/sesTransport.js';

const FALLBACK_RECIPIENT_ENV_VAR = 'FUTCO_DIGEST_TO_EMAIL';

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
  const sent = queryEvents(dataDir, { type: 'x.digestSent' });
  if (sent.length === 0) return null;
  return sent[sent.length - 1].occurredAt;
}

function buildTextBody(drafts) {
  const lines = [`FutCo X engagement — ${drafts.length} draft(s) awaiting review`, ''];
  drafts.forEach((draft, index) => {
    const { tweetUrl, postText, matchedTopic, finding, draftReply } = draft.payload;
    lines.push(
      `${index + 1}. ${tweetUrl}`,
      `   Topic: ${matchedTopic ?? 'unknown'}`,
      `   Finding (${finding?.source ?? 'e3d.ai'}): ${finding?.text ?? 'n/a'}`,
      ...(finding?.url ? [`   Finding link: ${finding.url}`] : []),
      `   Original: "${postText}"`,
      `   DRAFT: ${draftReply}`,
      ''
    );
  });
  return lines.join('\n');
}

function buildHtmlBody(drafts) {
  const items = drafts
    .map(
      (draft) => `
    <div style="margin:0 0 22px;padding:14px 16px;border:1px solid #e0e0e4;border-radius:8px;">
      <p style="margin:0 0 6px;"><a href="${escapeHtml(draft.payload.tweetUrl)}" style="color:#2952cc;">${escapeHtml(draft.payload.tweetUrl)}</a></p>
      <p style="margin:0 0 6px;color:#666;font-size:13px;">Topic: ${escapeHtml(draft.payload.matchedTopic ?? 'unknown')}</p>
      <p style="margin:0 0 6px;color:#666;font-size:13px;">Finding (${escapeHtml(draft.payload.finding?.source ?? 'e3d.ai')}): ${escapeHtml(draft.payload.finding?.text ?? 'n/a')}${draft.payload.finding?.url ? ` &mdash; <a href="${escapeHtml(draft.payload.finding.url)}" style="color:#2952cc;">${escapeHtml(draft.payload.finding.url)}</a>` : ''}</p>
      <p style="margin:0 0 10px;color:#444;font-size:13px;">Original: &ldquo;${escapeHtml(draft.payload.postText)}&rdquo;</p>
      <p style="margin:0;padding:10px 12px;background:#f4f4f6;border-radius:6px;font-weight:600;">${escapeHtml(draft.payload.draftReply)}</p>
    </div>`
    )
    .join('');

  return `
<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">
  <h1 style="font-size:19px;margin:0 0 18px;">FutCo X engagement &mdash; ${drafts.length} draft(s) awaiting review</h1>
  ${items}
  <p style="font-size:13px;color:#666;border-top:1px solid #e0e0e4;padding-top:14px;">Edit and post whichever ones are worth it. Skip the rest - there's no obligation to use every draft.</p>
</div>`.trim();
}

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const to = process.env[config.research?.x?.digestToEmailEnvVar ?? FALLBACK_RECIPIENT_ENV_VAR];
  if (!to) {
    throw new Error('No digest recipient configured (research.x.digestToEmailEnvVar or FUTCO_DIGEST_TO_EMAIL)');
  }

  const since = lastDigestSentAt(dataDir);
  const drafts = queryEvents(dataDir, { type: 'x.draftQueued', since: since ?? undefined });

  if (drafts.length === 0) {
    process.stdout.write('No new X engagement drafts since the last digest - nothing sent.\n');
    return;
  }

  const subject = `FutCo X engagement — ${drafts.length} draft(s) to review`;
  const result = await sendEmailViaSes({
    instanceConfig: config,
    to,
    subject,
    body: buildTextBody(drafts),
    htmlBody: buildHtmlBody(drafts)
  });

  appendEvent(dataDir, {
    type: 'x.digestSent',
    source: 'ops.xEngagementDigest',
    subject: { type: 'xDigest', id: result.messageId ?? crypto.randomUUID() },
    payload: { to, draftCount: drafts.length, draftIds: drafts.map((d) => d.subject.id) },
    correlationId: crypto.randomUUID()
  });

  process.stdout.write(`Sent X engagement digest (${drafts.length} draft(s)) to ${to} (messageId=${result.messageId})\n`);
}

main().catch((error) => {
  process.stderr.write(`X engagement digest failed: ${error.message}\n`);
  process.exitCode = 1;
});
