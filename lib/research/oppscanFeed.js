import { queryEvents } from '../events/store.js';

const EVIDENCE_SOURCE = 'research.oppscanFeed';

function unavailableResult(endpoint, cursor, limit, reason) {
  return {
    status: 'unavailable',
    provider: 'oppscan-feed',
    endpoint,
    query: { cursor: cursor ?? null, limit: limit ?? null },
    reason,
    summary: reason,
    schemaVersion: null,
    events: [],
    nextCursor: cursor ?? null,
    hasMore: false
  };
}

// Resumes from the cursor recorded on the last successful pull. No separate
// state file - the event log is the single source of truth, same convention
// lib/event-sources/googleCalendarBooking.js uses for dedup (every record
// already carries what's needed to resume; nothing lives beside the log).
export function lastOppscanCursor(dataDir) {
  const pulls = queryEvents(dataDir, { type: 'evidence.gathered' }).filter(
    (event) => event.source === EVIDENCE_SOURCE
  );
  if (pulls.length === 0) {
    return null;
  }
  const last = pulls[pulls.length - 1];
  return last.payload?.result?.nextCursor ?? null;
}

export async function fetchOppscanFeed({ feedUrl, token, cursor, limit } = {}) {
  if (!feedUrl) {
    return unavailableResult(feedUrl, cursor, limit, 'oppscan feed URL is not configured');
  }
  if (!token) {
    return unavailableResult(feedUrl, cursor, limit, 'oppscan feed token is not configured');
  }

  const url = new URL(feedUrl);
  if (limit) {
    url.searchParams.set('limit', String(limit));
  }
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
  } catch (error) {
    return unavailableResult(feedUrl, cursor, limit, `oppscan feed unreachable: ${error.message}`);
  }

  if (response.status === 401) {
    return unavailableResult(feedUrl, cursor, limit, 'oppscan feed rejected the token (401)');
  }
  if (response.status === 503) {
    return unavailableResult(feedUrl, cursor, limit, 'oppscan feed disabled server-side (503)');
  }
  if (!response.ok) {
    return unavailableResult(feedUrl, cursor, limit, `oppscan feed returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return unavailableResult(feedUrl, cursor, limit, `oppscan feed returned invalid JSON: ${error.message}`);
  }

  const events = Array.isArray(data.events) ? data.events : [];
  return {
    status: 'ok',
    provider: 'oppscan-feed',
    endpoint: feedUrl,
    query: { cursor: cursor ?? null, limit: limit ?? null },
    schemaVersion: data.schemaVersion ?? null,
    events,
    nextCursor: data.nextCursor ?? cursor ?? null,
    hasMore: Boolean(data.hasMore),
    summary: `${events.length} event(s)`
  };
}

export { EVIDENCE_SOURCE as OPPSCAN_EVIDENCE_SOURCE };
