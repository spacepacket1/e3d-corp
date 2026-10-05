import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';

const SIGNAL_EVENT_TYPE = 'oppscan.fit_signal.detected';

// Dedup source of truth is the event store itself, same convention as
// lib/event-sources/googleCalendarBooking.js - every signal already raised
// carries the oppscan report id it came from.
export function alreadySignaledReportIds(dataDir) {
  return new Set(queryEvents(dataDir, { type: SIGNAL_EVENT_TYPE }).map((event) => event.subject?.id).filter(Boolean));
}

// Every oppscan report row ever pulled lives inside some batch
// evidence.gathered event (lib/research/oppscanFeed.js) - this flattens all
// of them rather than tracking a separate "already scanned" position, so a
// crash partway through promoting one batch's candidates can never strand
// one: the next run re-derives the same candidate set and only acts on
// reports still missing a signal.
export function collectCandidateReports(dataDir, { fitTiers } = {}) {
  const tiers = new Set(fitTiers && fitTiers.length > 0 ? fitTiers : ['strong']);
  const alreadySignaled = alreadySignaledReportIds(dataDir);

  const batchEvents = queryEvents(dataDir, { type: 'evidence.gathered' }).filter(
    (event) => event.source === 'research.oppscanFeed' && Array.isArray(event.payload?.result?.events)
  );

  const seen = new Set();
  const candidates = [];
  for (const batchEvent of batchEvents) {
    for (const report of batchEvent.payload.result.events) {
      const reportId = report?.id;
      if (!reportId || seen.has(reportId) || alreadySignaled.has(reportId)) continue;
      if (report?.data?.revoked) continue;
      if (!tiers.has(report?.data?.fitTier)) continue;
      seen.add(reportId);
      candidates.push({ report, batchEventId: batchEvent.id });
    }
  }
  return candidates;
}

// The report itself becomes its own fresh evidence.gathered event (its own
// correlationId, not the shared batch's) so this signal's causal chain
// stays independent of every other report that happened to arrive in the
// same feed pull - one real-world opportunity, one chain, same invariant
// every other trigger in this instance follows.
export function recordFitSignal(dataDir, report, batchEventId) {
  const correlationId = crypto.randomUUID();

  const evidenceEvent = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.oppscanFeed',
    subject: { type: 'research', id: crypto.randomUUID() },
    payload: {
      kind: 'oppscan-feed-report',
      query: { reportId: report.id },
      resultSummary: `oppscan report ${report.id}: fitTier=${report.data?.fitTier ?? 'unknown'}`,
      result: { status: 'ok', provider: 'oppscan-feed', report },
      degraded: false
    },
    causationId: batchEventId,
    correlationId
  });

  const signalEvent = appendEvent(dataDir, {
    type: SIGNAL_EVENT_TYPE,
    source: 'oppscan.fitSignal',
    subject: { type: 'oppscan-report', id: report.id },
    payload: {
      reportId: report.id,
      product: report.data?.product ?? null,
      company: report.data?.company ?? null,
      fitTier: report.data?.fitTier ?? null,
      primaryPlatform: report.data?.primaryPlatform ?? null,
      detectedPlatform: report.data?.detectedPlatform ?? null,
      onlineBookingDetected: report.data?.onlineBookingDetected ?? null,
      chatWidgetDetected: report.data?.chatWidgetDetected ?? null,
      toolsReportedByOwner: report.data?.toolsReportedByOwner ?? [],
      reportOccurredAt: report.occurredAt ?? null
    },
    causationId: evidenceEvent.id,
    correlationId
  });

  return { evidenceEvent, signalEvent };
}
