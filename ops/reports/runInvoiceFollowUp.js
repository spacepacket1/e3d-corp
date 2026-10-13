#!/usr/bin/env node
// HVAC vertical prototype: finds overdue QuickBooks invoices and drafts a
// payment reminder for a human to review and send - never sends anything
// itself. Same draft-and-queue safety pattern as runXEngagement.js, applied
// to collections instead of social replies.
//
// Standalone script, not yet wired through lib/config.js's full instance.json
// schema - this is a prototype for a vertical with no real client yet, and
// that schema requires committing to real business details (outreach domain,
// calendar, web auth) that don't make sense to invent before one exists.
// Still fully event-sourced: events land in the same dataDir a future real
// instance for this vertical would use, so nothing here is throwaway.

import crypto from 'node:crypto';
import { fetchQuickbooksInvoices } from '../../lib/research/quickbooksInvoices.js';
import { draftInvoiceReminder } from '../../lib/roles/invoiceReminder.js';
import { appendEvent, queryEvents } from '../../lib/events/store.js';

const DATA_DIR = '.e3d-corp/instance/hvac-sandbox';

const PROTOTYPE_INSTANCE_CONFIG = {
  llm: {
    providers: {
      claude: { kind: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY' }
    }
  },
  roles: {
    'finance.invoiceReminder': { provider: 'claude' }
  }
};

function daysOverdueFrom(dueDateStr, nowMs) {
  const dueMs = Date.parse(dueDateStr);
  if (!Number.isFinite(dueMs)) return null;
  return Math.floor((nowMs - dueMs) / (24 * 60 * 60 * 1000));
}

function alreadyQueuedInvoiceIds(dataDir) {
  return new Set(queryEvents(dataDir, { type: 'invoiceReminder.drafted' }).map((event) => event.subject.id));
}

async function main() {
  const clientId = process.env.QBO_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.QBO_SANDBOX_CLIENT_SECRET;
  const refreshToken = process.env.QBO_SANDBOX_REFRESH_TOKEN;
  const realmId = process.env.QBO_SANDBOX_REALM_ID;

  const result = await fetchQuickbooksInvoices({
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    sandbox: true,
    lookbackDays: 365,
    limit: 100
  });

  if (result.status !== 'ok') {
    process.stderr.write(`QuickBooks invoice pull degraded: ${result.reason ?? result.summary}\n`);
    process.exitCode = 1;
    return;
  }

  const nowMs = Date.now();
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const queuedIds = alreadyQueuedInvoiceIds(DATA_DIR);
  let queuedCount = 0;

  for (const invoice of result.rows) {
    if (invoice.paid || !(invoice.balance > 0) || !invoice.dueDate || invoice.dueDate >= todayStr) continue;
    if (queuedIds.has(invoice.id)) continue;

    const daysOverdue = daysOverdueFrom(invoice.dueDate, nowMs);
    const { draft, provider, model } = await draftInvoiceReminder({
      instanceConfig: PROTOTYPE_INSTANCE_CONFIG,
      invoice,
      daysOverdue
    });
    if (!draft) continue;

    appendEvent(DATA_DIR, {
      type: 'invoiceReminder.drafted',
      source: 'ops.runInvoiceFollowUp',
      subject: { type: 'qboInvoice', id: invoice.id },
      payload: {
        invoiceId: invoice.id,
        docNumber: invoice.docNumber,
        customerName: invoice.customerName,
        balance: invoice.balance,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        daysOverdue,
        draftSubject: draft.subject,
        draftBody: draft.body,
        provider,
        model
      },
      correlationId: crypto.randomUUID()
    });
    queuedCount += 1;
    process.stdout.write(
      `Queued reminder for invoice ${invoice.docNumber} (${invoice.customerName}, ${invoice.balance} ${invoice.currency}, ${daysOverdue}d overdue)\n`
    );
  }

  process.stdout.write(`Invoice follow-up run complete: ${result.rowCount} invoice(s) checked, ${queuedCount} reminder(s) queued.\n`);
}

main().catch((error) => {
  process.stderr.write(`Invoice follow-up run failed: ${error.message}\n`);
  process.exitCode = 1;
});
