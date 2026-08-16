// External anchoring for the append-only log's hash chain.
//
// The chain alone catches partial edits - altering or removing a record
// invalidates everything after it. It cannot catch the two failures where the
// operator rewrites the file wholesale: recomputing every hash after a full
// rewrite produces a self-consistent chain, and truncating the tail leaves a
// valid prefix. Both are only detectable against a record of what the log
// looked like earlier, held somewhere the process cannot reach back into.
//
// An anchor is that record: the chain head plus the record count at a moment
// in time, published outward. Because it carries the count, a later log that
// is *shorter* is caught as truncation; because it carries the head, a later
// log whose prefix hashes differently is caught as a rewrite. Two numbers and
// a hash - no business content is ever published, which is what makes this
// compatible with the spec's rule that real client and revenue data never
// leaves the private instance directory.

import { appendEvent, queryEvents, readAllEventRecords } from '../events/store.js';
import { resolveNextPrevHash } from '../store/appendOnlyLog.js';

export const ANCHOR_EVENT_TYPE = 'anchor.published';

// The single value that commits to the entire log as it currently stands:
// for a chained log it is the last record's hash, and for a log still
// carrying an unchained prefix it is that prefix's seal. It is also exactly
// the prevHash the next appended record will carry, which is what lets an
// anchor be verified against the log without trusting anything else.
export function computeChainHead(dataDir) {
  const records = readAllEventRecords(dataDir);
  return { head: resolveNextPrevHash(records), count: records.length };
}

// Records the anchor in the log *before* handing it to a transport, so a
// failed send leaves a recorded, verifiable anchor rather than a silent gap.
// The appended event's own prevHash is the anchored head by construction -
// the anchor and the chain agree with each other or neither is trustworthy.
export function recordAnchor(dataDir, { head, count, publishedTo, transport }) {
  return appendEvent(dataDir, {
    type: ANCHOR_EVENT_TYPE,
    source: 'anchor',
    subject: { type: 'anchor', id: head },
    payload: { head, count, publishedTo, transport },
    causationId: null,
    correlationId: `anchor-${head.slice(0, 16)}`
  });
}

export function listAnchors(dataDir) {
  return queryEvents(dataDir, { type: ANCHOR_EVENT_TYPE })
    .map((event) => ({
      eventId: event.id,
      publishedAt: event.occurredAt,
      head: event.payload?.head ?? null,
      count: event.payload?.count ?? null,
      publishedTo: event.payload?.publishedTo ?? null,
      transport: event.payload?.transport ?? null,
      delivered: event.payload?.delivered ?? null
    }))
    .filter((anchor) => typeof anchor.head === 'string' && Number.isInteger(anchor.count));
}

// Re-derives one anchor's head from the log as it stands now.
export function checkAnchorAgainstRecords(records, { head, count }) {
  if (records.length < count) {
    return {
      valid: false,
      reason:
        `the log now holds ${records.length} records but this anchor covered ${count} — ` +
        `${count - records.length} record(s) were removed from the end`
    };
  }

  const recomputed = resolveNextPrevHash(records.slice(0, count));
  if (recomputed !== head) {
    return {
      valid: false,
      reason:
        `the first ${count} records now hash to ${recomputed}, but this anchor published ${head} — ` +
        'history at or before that point was rewritten'
    };
  }

  return { valid: true, reason: null };
}

// Checks the anchors recorded in the log itself. This catches a full rewrite:
// recomputing every hash after an edit produces a chain that verifies, but the
// prefix no longer hashes to what was published.
//
// It cannot catch truncation, and structurally never will - an anchor at index
// i covers the i records before it, so any log still containing that anchor is
// necessarily longer than the count it asserts. Cutting the tail cuts the
// anchors along with it. That check requires an anchor held outside the log,
// which is what the emailed copy is and what verifyExternalAnchor takes.
export function verifyAgainstAnchors(dataDir) {
  const records = readAllEventRecords(dataDir);
  const results = listAnchors(dataDir).map((anchor) => ({
    ...anchor,
    ...checkAnchorAgainstRecords(records, anchor)
  }));

  const valid = results.filter((result) => result.valid);
  return {
    valid: results.every((result) => result.valid),
    anchorCount: results.length,
    results,
    // How far into the log is pinned by something that was published outward.
    pinnedThrough: valid.length > 0 ? Math.max(...valid.map((result) => result.count)) : 0
  };
}

// Verifies the log against an anchor supplied from outside it - the head and
// count read off an anchor email. This is the only check that can catch a
// truncated tail or a rewrite that also deleted the in-log anchors, because
// it is the only one whose reference value never lived in the file it is
// checking.
export function verifyExternalAnchor(dataDir, { head, count }) {
  if (typeof head !== 'string' || head.trim() === '') {
    throw new Error('verifyExternalAnchor requires the anchor head hash');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('verifyExternalAnchor requires the anchor record count');
  }

  const records = readAllEventRecords(dataDir);
  return { head, count, currentCount: records.length, ...checkAnchorAgainstRecords(records, { head, count }) };
}

// Publishes the current head through an injected transport. The transport is
// a parameter rather than a hard-coded SES call so tests exercise the real
// recording and verification path without sending mail, matching how the
// research and outreach layers take their providers.
export async function publishAnchor(dataDir, { instanceConfig, transport }) {
  if (typeof transport?.send !== 'function') {
    throw new Error('publishAnchor requires a transport with a send(anchor) function');
  }

  const { head, count } = computeChainHead(dataDir);
  if (head === null) {
    throw new Error('Refusing to publish an anchor for an empty event log');
  }

  const event = recordAnchor(dataDir, {
    head,
    count,
    publishedTo: transport.destination ?? null,
    transport: transport.name ?? 'unknown'
  });

  const delivery = await transport.send({ head, count, instanceConfig, publishedAt: event.occurredAt });

  return { head, count, event, delivery };
}
