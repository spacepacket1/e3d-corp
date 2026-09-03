import {
  appendEventWithinLock,
  queryEvents,
  withEventsLock
} from '../events/store.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function existingStressEvaluationEvent(dataDir, runId) {
  if (!isNonEmptyString(runId)) {
    return null;
  }
  return (
    queryEvents(dataDir, {
      type: 'financial-stress-evaluation.received',
      subject: { type: 'financial-stress-run', id: runId.trim() }
    })[0] ?? null
  );
}

export function recordStressEvaluationReceived(
  dataDir,
  submission,
  { causationId = null, correlationId } = {}
) {
  if (!isPlainObject(submission)) {
    throw new Error('Stress evaluation submission must be an object');
  }
  if (!isNonEmptyString(submission.run_id)) {
    throw new Error('run_id is required');
  }
  if (!isNonEmptyString(correlationId)) {
    throw new Error('correlationId is required');
  }

  return withEventsLock(dataDir, () => {
    const existing = existingStressEvaluationEvent(dataDir, submission.run_id);
    if (existing) {
      return { event: existing, idempotent: true };
    }

    const event = appendEventWithinLock(dataDir, {
      type: 'financial-stress-evaluation.received',
      source: 'e3d.financial-stress-pipeline',
      subject: { type: 'financial-stress-run', id: submission.run_id.trim() },
      payload: submission,
      causationId,
      correlationId
    });

    return { event, idempotent: false };
  });
}
