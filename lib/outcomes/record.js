import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { OUTCOME_TYPES } from './schema.js';
import { assembleExperience } from '../experience/assemble.js';
import { appendExperience } from '../experience/store.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function latestEventForCorrelation(dataDir, correlationId) {
  const events = queryEvents(dataDir, { correlationId });
  return events[events.length - 1] ?? null;
}

function existingOutcomeEvent(dataDir, id) {
  if (!isNonEmptyString(id)) return null;
  return queryEvents(dataDir, { subject: { type: 'outcome', id } })[0] ?? null;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeOutcomeInput({ id, type, payload, occurredAt, source, subject, causationId } = {}) {
  return stableStringify({
    id,
    type,
    payload,
    occurredAt: occurredAt ?? null,
    source: source ?? 'outcomes.record',
    subject: subject ?? null,
    causationId: causationId ?? null
  });
}

// The single implementation both the CLI (`outcomes record`) and the web
// UI's outcome form call - a human recording a fact about what actually
// happened. Deliberately not gated behind Phase 5's authority/Decision
// framework: recording an Outcome isn't an action e3d-corp performs on the
// world, so there is nothing to approve, only something to note down
// accurately (the spec's own "treat human approval and real business outcome
// as distinct signals" - this is the outcome half, with no decision step of
// its own).
export function recordOutcome(dataDir, { id, correlationId, type, payload, occurredAt, source, subject, causationId } = {}) {
  if (!isNonEmptyString(correlationId)) {
    throw new Error('recordOutcome requires a non-empty correlationId');
  }
  if (!OUTCOME_TYPES.includes(type)) {
    throw new Error(`Unknown outcome type "${type}"; expected one of ${OUTCOME_TYPES.join(', ')}`);
  }
  if (!isPlainObject(payload)) {
    throw new Error('recordOutcome requires a payload object');
  }

  const existing = queryEvents(dataDir, { correlationId });
  if (existing.length === 0) {
    throw new Error(`No events found for correlationId "${correlationId}"; cannot record an outcome for a chain that doesn't exist`);
  }

  const latest = latestEventForCorrelation(dataDir, correlationId);
  const outcomeId = isNonEmptyString(id) ? id.trim() : crypto.randomUUID();
  const prior = existingOutcomeEvent(dataDir, outcomeId);
  const normalizedInput = normalizeOutcomeInput({
    id: outcomeId,
    type,
    payload,
    occurredAt,
    source,
    subject,
    causationId
  });
  if (prior) {
    const priorInput = normalizeOutcomeInput({
      id: prior.payload?.id ?? prior.subject?.id ?? prior.id,
      type: prior.type,
      payload: prior.payload ? Object.fromEntries(Object.entries(prior.payload).filter(([key]) => key !== 'id' && key !== 'correlationId' && key !== 'type')) : {},
      occurredAt: prior.occurredAt,
      source: prior.source,
      subject: prior.subject,
      causationId: prior.causationId
    });
    if (prior.correlationId !== correlationId || priorInput !== normalizedInput) {
      throw new Error(`Outcome conflict for id "${outcomeId}"`);
    }

    return {
      outcome: {
        id: outcomeId,
        subjectCorrelationId: prior.correlationId,
        type: prior.type,
        payload: Object.fromEntries(Object.entries(prior.payload ?? {}).filter(([key]) => !['id', 'correlationId', 'type'].includes(key))),
        occurredAt: prior.occurredAt
      },
      event: prior,
      experience: assembleExperience(dataDir, correlationId),
      idempotent: true
    };
  }

  const event = appendEvent(dataDir, {
    type,
    source: source ?? 'outcomes.record',
    subject: subject ?? { type: 'outcome', id: outcomeId },
    payload: { id: outcomeId, correlationId, type, ...payload },
    causationId: causationId ?? (latest ? latest.id : null),
    correlationId,
    occurredAt
  });

  // Recording an Outcome is what makes a chain "meaningfully completed," so
  // this is the natural trigger point for a fresh Experience snapshot -
  // still a pure recompute from the event log (lib/experience/assemble.js),
  // just persisted for Phase 10's metrics to scan later.
  const experience = assembleExperience(dataDir, correlationId);
  appendExperience(dataDir, experience);

  return {
    outcome: { id: outcomeId, subjectCorrelationId: correlationId, type, payload, occurredAt: event.occurredAt },
    event,
    experience,
    idempotent: false
  };
}
