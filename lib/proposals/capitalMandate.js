import { queryEvents } from '../events/store.js';
import { createProposal } from './create.js';
import { CAPITAL_MANDATE_PROPOSAL_TYPE } from './capitalMandateSchema.js';

function latestEventForOpportunity(dataDir, opportunityId) {
  const events = queryEvents(dataDir, { subject: { type: 'opportunity', id: opportunityId } });
  return events[events.length - 1] ?? null;
}

export function proposeCapitalMandate(dataDir, { opportunity, mandate, proposedBy, instanceConfig } = {}) {
  if (!opportunity || !opportunity.id || !opportunity.correlationId) {
    throw new Error('proposeCapitalMandate requires an opportunity with an id and correlationId');
  }
  if (opportunity.status !== 'pursuing') {
    throw new Error(
      `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status}); refusing to propose a capital mandate`
    );
  }
  if (!mandate || typeof mandate !== 'object' || Array.isArray(mandate)) {
    throw new Error('proposeCapitalMandate requires a mandate payload object');
  }

  const causationEvent = latestEventForOpportunity(dataDir, opportunity.id);

  return createProposal(dataDir, {
    type: CAPITAL_MANDATE_PROPOSAL_TYPE,
    payload: {
      thesis_refs: opportunity.thesisRefs ?? opportunity.thesis_refs ?? [],
      story_refs: opportunity.storyRefs ?? opportunity.story_refs ?? [],
      confidence: opportunity.confidence ?? null,
      invalidation: opportunity.invalidationCondition ?? opportunity.invalidation ?? null,
      ...mandate,
      source_opportunity_id: opportunity.id,
      source_opportunity_title: opportunity.title ?? null
    },
    proposedBy: proposedBy ?? opportunity.proposedBy ?? { role: 'opportunity.investing', provider: 'unknown', model: 'unknown' },
    causationId: causationEvent ? causationEvent.id : null,
    correlationId: opportunity.correlationId,
    instanceConfig
  });
}
