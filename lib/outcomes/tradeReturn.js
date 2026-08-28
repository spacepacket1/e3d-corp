import { queryEvents } from '../events/store.js';
import { recordOutcome } from './record.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function matchingMandateSubmissionEvent(dataDir, mandateId, correlationId) {
  const events = queryEvents(dataDir, { type: 'capital-mandate.submitted', correlationId });
  return events.find((event) => event.payload?.mandateId === mandateId) ?? null;
}

export function recordTradeOutcomeReturn(dataDir, payload = {}) {
  if (!isPlainObject(payload)) {
    throw new Error('trade outcome payload must be an object');
  }
  const outcomeId = payload.outcome_id;
  const mandateId = payload.mandate_id;
  const correlationId = payload.correlation_id;
  const type = payload.type;

  if (!isNonEmptyString(outcomeId)) throw new Error('outcome_id is required');
  if (!isNonEmptyString(mandateId)) throw new Error('mandate_id is required');
  if (!isNonEmptyString(correlationId)) throw new Error('correlation_id is required');
  if (!isNonEmptyString(type)) throw new Error('type is required');

  const submissionEvent = matchingMandateSubmissionEvent(dataDir, mandateId.trim(), correlationId.trim());
  if (!submissionEvent) {
    throw new Error(`No capital-mandate.submitted event found for mandate_id "${mandateId}" and correlation_id "${correlationId}"`);
  }

  const {
    outcome_id,
    mandate_id,
    correlation_id,
    type: outcomeType,
    occurred_at,
    ...outcomePayload
  } = payload;

  return recordOutcome(dataDir, {
    id: outcome_id,
    correlationId: correlation_id,
    type: outcomeType,
    payload: {
      mandate_id,
      ...outcomePayload
    },
    occurredAt: occurred_at,
    source: 'webhook:e3d-trade',
    subject: { type: 'outcome', id: outcome_id },
    causationId: submissionEvent.id
  });
}
