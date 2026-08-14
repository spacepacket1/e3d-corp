import { queryEvents } from '../events/store.js';
import { createProposal } from './create.js';

function latestEventForOpportunity(dataDir, opportunityId) {
  const events = queryEvents(dataDir, { subject: { type: 'opportunity', id: opportunityId } });
  return events[events.length - 1] ?? null;
}

// Unlike Phase 7's outreach (LLM-drafted content, so it needs a role), a
// pilot-handoff decision - "send this specific opportunity to e3d-pilot
// against this repo" - is a structured human judgment call, not something an
// LLM drafts. The spec defines no dedicated role for Phase 8, so this is a
// plain, deterministic proposal creator called directly from the CLI/web
// layer, same as any other human-initiated proposal.
export function proposePilotHandoff(dataDir, { opportunity, targetRepo, reason, proposedBy, instanceConfig } = {}) {
  if (!opportunity || !opportunity.id || !opportunity.correlationId) {
    throw new Error('proposePilotHandoff requires an opportunity with an id and correlationId');
  }
  if (opportunity.status !== 'pursuing') {
    throw new Error(
      `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status}); refusing to propose a pilot handoff`
    );
  }
  if (typeof targetRepo !== 'string' || targetRepo.trim() === '') {
    throw new Error('proposePilotHandoff requires a non-empty targetRepo path');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('proposePilotHandoff requires a non-empty reason');
  }

  const causationEvent = latestEventForOpportunity(dataDir, opportunity.id);

  return createProposal(dataDir, {
    type: 'pilot-handoff',
    payload: {
      opportunityId: opportunity.id,
      opportunityTitle: opportunity.title,
      targetRepo: targetRepo.trim(),
      reason: reason.trim(),
      score: opportunity.score ?? null
    },
    proposedBy: proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    causationId: causationEvent ? causationEvent.id : null,
    correlationId: opportunity.correlationId,
    instanceConfig
  });
}
