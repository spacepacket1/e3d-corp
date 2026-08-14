import { queryEvents } from '../events/store.js';

// Proposals have no separate on-disk store - like Opportunities (Phase 4),
// they are folded from the event log (proposal.created, proposal.approved,
// proposal.rejected), keeping events.jsonl the single source of truth.
function assembleProposals(dataDir) {
  const byId = new Map();

  for (const event of queryEvents(dataDir, { type: 'proposal.created' })) {
    byId.set(event.subject.id, { ...event.payload });
  }

  for (const event of queryEvents(dataDir, { type: 'proposal.approved' })) {
    const existing = byId.get(event.subject.id);
    if (!existing) continue;
    byId.set(event.subject.id, { ...existing, status: 'approved' });
  }

  for (const event of queryEvents(dataDir, { type: 'proposal.rejected' })) {
    const existing = byId.get(event.subject.id);
    if (!existing) continue;
    byId.set(event.subject.id, { ...existing, status: 'rejected' });
  }

  return [...byId.values()];
}

export function listProposals(dataDir, { status, type } = {}) {
  let proposals = assembleProposals(dataDir);

  if (status) {
    proposals = proposals.filter((proposal) => proposal.status === status);
  }
  if (type) {
    proposals = proposals.filter((proposal) => proposal.type === type);
  }

  return proposals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function getProposal(dataDir, id) {
  return assembleProposals(dataDir).find((proposal) => proposal.id === id) ?? null;
}

// The originating proposal.created event, used by decide.js to set
// causationId on the resulting approval/rejection event.
export function getProposalCreatedEvent(dataDir, id) {
  const events = queryEvents(dataDir, { type: 'proposal.created', subject: { type: 'proposal', id } });
  return events[events.length - 1] ?? null;
}
