import { reconstructChain } from '../events/chain.js';
import { OUTCOME_TYPES } from '../outcomes/schema.js';
import { ACTION_FIRED_EVENT_TYPES } from '../actions/log.js';

const DECISION_EVENT_TYPES = ['opportunity.reviewed', 'proposal.approved', 'proposal.rejected'];

function lastOfTypes(chain, types) {
  const matches = chain.filter((event) => types.includes(event.type));
  return matches[matches.length - 1] ?? null;
}

function firstOfType(chain, type) {
  return chain.find((event) => event.type === type) ?? null;
}

function summarizeEvidence(event) {
  return {
    id: event.id,
    kind: event.payload?.kind ?? null,
    query: event.payload?.query ?? null,
    resultSummary: event.payload?.resultSummary ?? null
  };
}

// Role/model come only from what the event log actually recorded - never
// fabricated. A proposal's proposedBy is the most specific source available;
// short of that, the opportunity.created event's `source` field
// ("role:<name>") is the only role attribution earlier events carry, and no
// event records a model at that stage, so model stays null rather than
// guessed.
function deriveRoleAndModel(proposalEvent, opportunityEvent) {
  const proposedBy = proposalEvent?.payload?.proposedBy;
  if (proposedBy) {
    return {
      role: proposedBy.role ?? null,
      model: proposedBy.model ? `${proposedBy.provider ?? ''}:${proposedBy.model}` : null
    };
  }
  if (opportunityEvent) {
    const match = /^role:(.+)$/.exec(opportunityEvent.source ?? '');
    return { role: match ? match[1] : opportunityEvent.source ?? null, model: null };
  }
  return { role: null, model: null };
}

function deriveContext(opportunityEvent, originatingEvent) {
  if (opportunityEvent) {
    const title = opportunityEvent.payload?.title ?? '';
    const description = opportunityEvent.payload?.description ?? '';
    return `${title}: ${description}`.trim();
  }
  return `${originatingEvent.type} from ${originatingEvent.source}`;
}

function computeLatencyMs(originatingEvent, endEvent) {
  if (!endEvent) return null;
  return new Date(endEvent.occurredAt).getTime() - new Date(originatingEvent.occurredAt).getTime();
}

// Walks reconstructChain(correlationId) and pulls the relevant fields out of
// each event type - a pure fold over the event log, same pattern
// Opportunities/Proposals (Phase 4/5) already use, never a second store of
// truth. costEstimate is always null: no LLM call anywhere in this codebase
// currently records token usage or cost, so there is nothing real to report
// here rather than a fabricated number - a future phase would need to add
// that instrumentation before this field could be populated honestly.
export function assembleExperience(dataDir, correlationId) {
  const chain = reconstructChain(dataDir, correlationId);
  if (chain.length === 0) {
    throw new Error(`No events found for correlationId "${correlationId}"`);
  }

  const originatingEvent = chain[0];
  const opportunityEvent = firstOfType(chain, 'opportunity.created');
  const proposalEvent = firstOfType(chain, 'proposal.created');
  const decisionEvent = lastOfTypes(chain, DECISION_EVENT_TYPES);
  const actionEvent = lastOfTypes(chain, ACTION_FIRED_EVENT_TYPES);
  const outcomeEvent = lastOfTypes(chain, OUTCOME_TYPES);

  const evidence = chain.filter((event) => event.type === 'evidence.gathered').map(summarizeEvidence);
  const { role, model } = deriveRoleAndModel(proposalEvent, opportunityEvent);
  const endEvent = outcomeEvent ?? actionEvent ?? null;

  return {
    correlationId,
    context: deriveContext(opportunityEvent, originatingEvent),
    originatingEvent: {
      id: originatingEvent.id,
      type: originatingEvent.type,
      occurredAt: originatingEvent.occurredAt,
      source: originatingEvent.source,
      payload: originatingEvent.payload
    },
    evidence,
    role,
    model,
    proposal: proposalEvent ? proposalEvent.payload : null,
    decision: decisionEvent ? decisionEvent.payload : null,
    action: actionEvent ? { type: actionEvent.type, ...actionEvent.payload } : null,
    outcome: outcomeEvent ? { type: outcomeEvent.type, ...outcomeEvent.payload } : null,
    latencyMs: computeLatencyMs(originatingEvent, endEvent),
    costEstimate: null
  };
}
