import { queryEvents } from '../events/store.js';

// Opportunities have no separate on-disk store — they are folded from the
// event log (opportunity.created, opportunity.scored, and, from Phase 5 on,
// opportunity.reviewed), the same pattern reconstructChain already uses for
// causal chains. This keeps a single source of truth (events.jsonl) rather
// than a second file that could drift out of sync.
function assembleOpportunities(dataDir) {
  const byId = new Map();

  for (const event of queryEvents(dataDir, { type: 'opportunity.created' })) {
    byId.set(event.subject.id, { ...event.payload });
  }

  for (const event of queryEvents(dataDir, { type: 'opportunity.scored' })) {
    const existing = byId.get(event.subject.id);
    if (!existing) continue;
    byId.set(event.subject.id, {
      ...existing,
      score: event.payload.score,
      status: event.payload.status
    });
  }

  for (const event of queryEvents(dataDir, { type: 'opportunity.reviewed' })) {
    const existing = byId.get(event.subject.id);
    if (!existing || !event.payload?.status) continue;
    byId.set(event.subject.id, { ...existing, status: event.payload.status });
  }

  return [...byId.values()];
}

function isPursuable(opportunity) {
  return opportunity?.pursuable === true;
}

function compareOpportunities(a, b) {
  const pursuableDelta = Number(isPursuable(b)) - Number(isPursuable(a));
  if (pursuableDelta !== 0) {
    return pursuableDelta;
  }
  return (b.score?.value ?? -Infinity) - (a.score?.value ?? -Infinity);
}

export function listOpportunities(dataDir, { status, minScore, pursuableOnly } = {}) {
  let opportunities = assembleOpportunities(dataDir);

  if (status) {
    opportunities = opportunities.filter((opportunity) => opportunity.status === status);
  }
  if (minScore !== undefined) {
    opportunities = opportunities.filter((opportunity) => (opportunity.score?.value ?? -Infinity) >= minScore);
  }
  if (pursuableOnly) {
    opportunities = opportunities.filter((opportunity) => isPursuable(opportunity));
  }

  return opportunities.sort(compareOpportunities);
}

export function getOpportunity(dataDir, id) {
  return assembleOpportunities(dataDir).find((opportunity) => opportunity.id === id) ?? null;
}
