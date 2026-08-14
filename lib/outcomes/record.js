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

// The single implementation both the CLI (`outcomes record`) and the web
// UI's outcome form call - a human recording a fact about what actually
// happened. Deliberately not gated behind Phase 5's authority/Decision
// framework: recording an Outcome isn't an action e3d-corp performs on the
// world, so there is nothing to approve, only something to note down
// accurately (the spec's own "treat human approval and real business outcome
// as distinct signals" - this is the outcome half, with no decision step of
// its own).
export function recordOutcome(dataDir, { correlationId, type, payload, occurredAt } = {}) {
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
  const id = crypto.randomUUID();

  const event = appendEvent(dataDir, {
    type,
    source: 'outcomes.record',
    subject: { type: 'outcome', id },
    payload: { id, correlationId, type, ...payload },
    causationId: latest ? latest.id : null,
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
    outcome: { id, subjectCorrelationId: correlationId, type, payload, occurredAt: event.occurredAt },
    event,
    experience
  };
}
