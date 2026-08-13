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

export function listOpportunities(dataDir, { status, minScore } = {}) {
  let opportunities = assembleOpportunities(dataDir);

  if (status) {
    opportunities = opportunities.filter((opportunity) => opportunity.status === status);
  }
  if (minScore !== undefined) {
    opportunities = opportunities.filter((opportunity) => (opportunity.score?.value ?? -Infinity) >= minScore);
  }

  return opportunities.sort((a, b) => (b.score?.value ?? -Infinity) - (a.score?.value ?? -Infinity));
}

export function getOpportunity(dataDir, id) {
  return assembleOpportunities(dataDir).find((opportunity) => opportunity.id === id) ?? null;
}
