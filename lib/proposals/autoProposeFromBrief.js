import { queryEvents } from '../events/store.js';
import { getOpportunity } from '../opportunities/store.js';
import { listProposals } from './store.js';
import { proposeCommissionCreative } from './commissionCreative.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function existingProposalEventIds(dataDir) {
  const commissionProposals = listProposals(dataDir, { type: 'commission-creative' });
  const proposed = new Set();
  for (const proposal of commissionProposals) {
    const id = proposal.payload?.sourceBriefEventId;
    if (isNonEmptyString(id)) {
      proposed.add(id);
    }
  }
  return proposed;
}

function buildReason(draftedEvent) {
  const rationale = draftedEvent.payload?.rationale;
  if (isNonEmptyString(rationale)) {
    return rationale.trim();
  }
  return `Auto-proposed from creative.brief draft ${draftedEvent.id}`;
}

function buildProposedBy(draftedEvent) {
  const provider = draftedEvent.payload?.provider;
  const model = draftedEvent.payload?.model;
  return {
    role: 'creative.brief',
    provider: isNonEmptyString(provider) ? provider : 'unknown',
    model: isNonEmptyString(model) ? model : 'unknown'
  };
}

// The autonomous hop docs/futco-ad-mandate-spec.md's Phase 2 still left
// manual: lib/roles/creativeBrief.js's runCreativeBrief only ever appends a
// creative-brief.drafted record (authority level 0/1, never a Proposal -
// createProposal itself refuses anything below level 2). Without this scan,
// every drafted brief sits inert until a human runs
// `opportunities propose-handoff`-style plumbing by hand. This is the
// deterministic, non-judgment-call part of that hop - "turn this already-
// drafted brief into a pending Proposal" - and is itself authority level 1
// by construction (creating a Proposal is always autonomous), so no human
// decision is skipped by automating it.
//
// Idempotency key: payload.sourceBriefEventId on the resulting
// commission-creative proposal must exactly equal the drafting
// creative-brief.drafted event's own id - nothing fuzzier (not
// opportunityId, not correlationId), so two distinct drafts for the same
// opportunity each get their own proposal and a drafted-but-not-yet-pursuing
// opportunity can be retried on a later scan without ever double-proposing.
export function autoProposeFromBriefs(dataDir, { instanceConfig } = {}) {
  const draftedEvents = queryEvents(dataDir, { type: 'creative-brief.drafted' });
  const alreadyProposed = existingProposalEventIds(dataDir);

  const results = [];

  for (const draftedEvent of draftedEvents) {
    if (alreadyProposed.has(draftedEvent.id)) {
      results.push({ draftedEventId: draftedEvent.id, status: 'already-proposed' });
      continue;
    }

    const opportunityId = draftedEvent.payload?.opportunityId;
    const opportunity = isNonEmptyString(opportunityId) ? getOpportunity(dataDir, opportunityId) : null;

    if (!opportunity) {
      results.push({
        draftedEventId: draftedEvent.id,
        status: 'skipped',
        reason: `Opportunity ${opportunityId ?? '(missing)'} not found`
      });
      continue;
    }
    if (opportunity.status !== 'pursuing') {
      results.push({
        draftedEventId: draftedEvent.id,
        status: 'skipped',
        reason: `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status})`
      });
      continue;
    }

    const { proposal, event } = proposeCommissionCreative(dataDir, {
      opportunity,
      brief: draftedEvent.payload?.brief,
      reason: buildReason(draftedEvent),
      proposedBy: buildProposedBy(draftedEvent),
      sourceBriefEventId: draftedEvent.id,
      instanceConfig
    });

    results.push({ draftedEventId: draftedEvent.id, status: 'proposed', proposalId: proposal.id, event });
  }

  return results;
}
