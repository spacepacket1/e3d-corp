import { queryEvents } from '../events/store.js';
import { createProposal } from './create.js';
import { AD_MANDATE_PROPOSAL_TYPE } from './adMandateSchema.js';

function latestEventForOpportunity(dataDir, opportunityId) {
  const events = queryEvents(dataDir, { subject: { type: 'opportunity', id: opportunityId } });
  return events[events.length - 1] ?? null;
}

// Same shape as proposeCapitalMandate - a human (or, later, an automated
// health check per docs/futco-ad-mandate-spec.md Phase 3) proposes a set of
// spend limits for a product, tied to the Opportunity that justified it.
export function proposeAdMandate(dataDir, { opportunity, mandate, proposedBy, instanceConfig } = {}) {
  if (!opportunity || !opportunity.id || !opportunity.correlationId) {
    throw new Error('proposeAdMandate requires an opportunity with an id and correlationId');
  }
  if (opportunity.status !== 'pursuing') {
    throw new Error(
      `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status}); refusing to propose an ad mandate`
    );
  }
  if (!mandate || typeof mandate !== 'object' || Array.isArray(mandate)) {
    throw new Error('proposeAdMandate requires a mandate payload object');
  }

  const causationEvent = latestEventForOpportunity(dataDir, opportunity.id);

  return createProposal(dataDir, {
    type: AD_MANDATE_PROPOSAL_TYPE,
    payload: {
      thesis_refs: opportunity.thesisRefs ?? opportunity.thesis_refs ?? [],
      confidence: opportunity.confidence ?? null,
      invalidation: opportunity.invalidationCondition ?? opportunity.invalidation ?? null,
      ...mandate,
      source_opportunity_id: opportunity.id,
      source_opportunity_title: opportunity.title ?? null
    },
    proposedBy: proposedBy ?? opportunity.proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    causationId: causationEvent ? causationEvent.id : null,
    correlationId: opportunity.correlationId,
    instanceConfig
  });
}
