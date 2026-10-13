#!/usr/bin/env node
// Review queue for runInvoiceFollowUp.js's drafted payment reminders: emails
// every invoiceReminder.drafted event since the last digest, ready to edit
// and send by hand. Mirrors xEngagementDigest.js's structure exactly - same
// human-in-the-loop reasoning: finds and drafts, a person decides and sends.

import crypto from 'node:crypto';
import { queryEvents, appendEvent } from '../../lib/events/store.js';
import { sendEmailViaSes } from '../../lib/outreach/sesTransport.js';

const DATA_DIR = '.e3d-corp/instance/hvac-sandbox';
const DIGEST_TO_ENV_VAR = 'FUTCO_DIGEST_TO_EMAIL';

// Reuses FutCo's own SES sender/region rather than inventing a separate
// outreach identity for a prototype with no real client yet.
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
  const sent = queryEvents(dataDir, { type: 'invoiceReminderDigest.sent' });
  if (sent.length === 0) return null;
  return sent[sent.length - 1].occurredAt;
}

function buildTextBody(drafts) {
  const lines = [`HVAC prototype - invoice follow-up: ${drafts.length} reminder(s) awaiting review`, ''];
  drafts.forEach((draft, index) => {
    const { docNumber, customerName, balance, currency, dueDate, daysOverdue, draftSubject, draftBody } = draft.payload;
    lines.push(
      `${index + 1}. Invoice ${docNumber} — ${customerName}`,
      `   Amount due: ${balance} ${currency} | Due: ${dueDate} | ${daysOverdue} day(s) overdue`,
      `   Subject: ${draftSubject}`,
      `   DRAFT: ${draftBody}`,
      ''
    );
  });
  return lines.join('\n');
}

function buildHtmlBody(drafts) {
  const items = drafts
    .map((draft) => {
      const { docNumber, customerName, balance, currency, dueDate, daysOverdue, draftSubject, draftBody } = draft.payload;
      return `
    <div style="margin:0 0 22px;padding:14px 16px;border:1px solid #e0e0e4;border-radius:8px;">
      <p style="margin:0 0 6px;font-weight:600;">Invoice ${escapeHtml(docNumber)} &mdash; ${escapeHtml(customerName)}</p>
      <p style="margin:0 0 6px;color:#666;font-size:13px;">Amount due: ${escapeHtml(balance)} ${escapeHtml(currency)} | Due: ${escapeHtml(dueDate)} | ${escapeHtml(daysOverdue)} day(s) overdue</p>
      <p style="margin:0 0 6px;color:#444;font-size:13px;">Subject: ${escapeHtml(draftSubject)}</p>
      <p style="margin:0;padding:10px 12px;background:#f4f4f6;border-radius:6px;white-space:pre-wrap;">${escapeHtml(draftBody)}</p>
    </div>`;
    })
    .join('');

  return `
<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">
  <h1 style="font-size:19px;margin:0 0 18px;">HVAC prototype &mdash; ${drafts.length} invoice reminder(s) awaiting review</h1>
  ${items}
  <p style="font-size:13px;color:#666;border-top:1px solid #e0e0e4;padding-top:14px;">Edit and send whichever ones are worth it. Skip the rest - there's no obligation to use every draft.</p>
</div>`.trim();
}

async function main() {
  const to = process.env[DIGEST_TO_ENV_VAR];
  if (!to) {
    throw new Error(`Env var "${DIGEST_TO_ENV_VAR}" is not set`);
  }

  const since = lastDigestSentAt(DATA_DIR);
  const drafts = queryEvents(DATA_DIR, { type: 'invoiceReminder.drafted', since: since ?? undefined });

  if (drafts.length === 0) {
    process.stdout.write('No new invoice reminders since the last digest - nothing sent.\n');
    return;
  }

  const subject = `HVAC prototype — ${drafts.length} invoice reminder(s) to review`;
  const result = await sendEmailViaSes({
    instanceConfig: OUTREACH_CONFIG,
    to,
    subject,
    body: buildTextBody(drafts),
    htmlBody: buildHtmlBody(drafts)
  });

  appendEvent(DATA_DIR, {
    type: 'invoiceReminderDigest.sent',
    source: 'ops.invoiceFollowUpDigest',
    subject: { type: 'invoiceReminderDigest', id: result.messageId ?? crypto.randomUUID() },
    payload: { to, draftCount: drafts.length, draftIds: drafts.map((d) => d.subject.id) },
    correlationId: crypto.randomUUID()
  });

  process.stdout.write(`Sent invoice follow-up digest (${drafts.length} reminder(s)) to ${to} (messageId=${result.messageId})\n`);
}

main().catch((error) => {
  process.stderr.write(`Invoice follow-up digest failed: ${error.message}\n`);
  process.exitCode = 1;
});
