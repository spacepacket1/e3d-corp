import { queryEvents } from '../events/store.js';
import { CAPITAL_MANDATE_PROPOSAL_TYPE } from './capitalMandateSchema.js';
import { AD_MANDATE_PROPOSAL_TYPE } from './adMandateSchema.js';

const MANDATE_PROPOSAL_TYPES = new Set([CAPITAL_MANDATE_PROPOSAL_TYPE, AD_MANDATE_PROPOSAL_TYPE]);

function applyProposalDecision(existing, event, status) {
  const next = { ...existing, status };

  if (MANDATE_PROPOSAL_TYPES.has(existing.type) && status === 'approved') {
    next.payload = {
      ...existing.payload,
      status: 'approved',
      approved_at: event.payload?.decidedAt ?? event.occurredAt,
      decision_id: event.payload?.decisionId ?? existing.payload?.decision_id ?? null
    };
  }

  return next;
}

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
    byId.set(event.subject.id, applyProposalDecision(existing, event, 'approved'));
  }

  for (const event of queryEvents(dataDir, { type: 'proposal.rejected' })) {
    const existing = byId.get(event.subject.id);
    if (!existing) continue;
    byId.set(event.subject.id, applyProposalDecision(existing, event, 'rejected'));
  }

  for (const event of queryEvents(dataDir, { type: 'capital-mandate.submitted' })) {
    const existing = byId.get(event.subject.id);
    if (!existing || existing.type !== CAPITAL_MANDATE_PROPOSAL_TYPE) continue;
    byId.set(event.subject.id, {
      ...existing,
      payload: {
        ...existing.payload,
        status: event.payload?.tradeStatus ?? event.payload?.submittedStatus ?? 'active',
        effective_at: existing.payload?.effective_at ?? event.payload?.submittedAt ?? event.occurredAt
      }
    });
  }

  for (const event of queryEvents(dataDir, { type: 'ad-mandate.activated' })) {
    const existing = byId.get(event.subject.id);
    if (!existing || existing.type !== AD_MANDATE_PROPOSAL_TYPE) continue;
    byId.set(event.subject.id, {
      ...existing,
      payload: {
        ...existing.payload,
        status: event.payload?.activatedStatus ?? 'active',
        effective_at: existing.payload?.effective_at ?? event.payload?.activatedAt ?? event.occurredAt
      }
    });
  }

  // The kill switch (docs/futco-ad-mandate-spec.md section 6) and the
  // circuit breaker's auto-suspend both go through
  // lib/actions/adMandateLifecycle.js's transitionAdMandateLifecycle, which
  // can append any of these three event types - distinct types so the event
  // log always shows whether a transition was a human action or automatic,
  // but they fold into payload.status identically. Only ever applies once
  // per mandate in practice (revoked/suspended are terminal - see
  // AD_MANDATE_TRANSITIONS in adMandateSchema.js), so last-write-wins here is
  // safe the same way it already is for the activation loop above.
  for (const eventType of ['ad-mandate.suspended', 'ad-mandate.revoked', 'ad-mandate.auto-suspended']) {
    for (const event of queryEvents(dataDir, { type: eventType })) {
      const existing = byId.get(event.subject.id);
      if (!existing || existing.type !== AD_MANDATE_PROPOSAL_TYPE) continue;
      const toStatus = event.payload?.toStatus ?? (eventType === 'ad-mandate.revoked' ? 'revoked' : 'suspended');
      byId.set(event.subject.id, {
        ...existing,
        payload: {
          ...existing.payload,
          status: toStatus,
          revoked_at: toStatus === 'revoked' ? (event.payload?.transitionedAt ?? event.occurredAt) : existing.payload?.revoked_at ?? null
        }
      });
    }
  }

  return [...byId.values()];
}

function getProposalGroupKey(proposal) {
  if (proposal.type === 'send-outreach' && proposal.payload?.opportunityId && proposal.correlationId) {
    return `send-outreach:${proposal.payload.opportunityId}:${proposal.correlationId}`;
  }
  return `proposal:${proposal.id}`;
}

function getProposalGroupLabel(proposal) {
  if (proposal.type === 'send-outreach' && proposal.payload?.opportunityId) {
    return `Outreach alternatives for opportunity ${proposal.payload.opportunityId}`;
  }
  return `Proposal ${proposal.id}`;
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

export function groupProposals(proposals) {
  const groups = new Map();

  proposals.forEach((proposal) => {
    const key = getProposalGroupKey(proposal);
    const existing = groups.get(key);
    if (existing) {
      existing.proposals.push(proposal);
      return;
    }

    groups.set(key, {
      key,
      label: getProposalGroupLabel(proposal),
      type: proposal.type,
      opportunityId: proposal.payload?.opportunityId ?? null,
      correlationId: proposal.correlationId,
      proposals: [proposal]
    });
  });

  return [...groups.values()].map((group) => ({
    ...group,
    proposals: group.proposals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }));
}

export function getProposal(dataDir, id) {
  return assembleProposals(dataDir).find((proposal) => proposal.id === id) ?? null;
}

export function listSiblingProposals(dataDir, proposal) {
  const proposals = listProposals(dataDir, { type: proposal.type });
  const group = groupProposals(proposals).find((entry) => entry.key === getProposalGroupKey(proposal));
  return group ? group.proposals : [proposal];
}

// The originating proposal.created event, used by decide.js to set
// causationId on the resulting approval/rejection event.
export function getProposalCreatedEvent(dataDir, id) {
  const events = queryEvents(dataDir, { type: 'proposal.created', subject: { type: 'proposal', id } });
  return events[events.length - 1] ?? null;
}
