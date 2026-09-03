import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { createE3dClient } from '../e3d/client.js';

const STRESS_PROPOSAL_TYPE = 'publish-stress-change';

function latestCorrection(dataDir, proposalId) {
  const events = queryEvents(dataDir, {
    type: 'financial-stress-correction.submitted',
    subject: { type: 'proposal', id: proposalId }
  });
  return events[events.length - 1] ?? null;
}

function existingSuccessfulPublish(dataDir, proposal) {
  return (
    queryEvents(dataDir, {
      type: 'financial-stress-change.published',
      subject: { type: 'proposal', id: proposal.id }
    }).find((event) => event.payload?.success === true) ?? null
  );
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function buildReleasePayload(proposal, correctionEvent) {
  const draft = proposal.payload ?? {};
  const correction = correctionEvent?.payload ?? {};
  return {
    run_id: draft.run_id,
    event_id: draft.event_id,
    final_score: firstPresent(correction.finalScore, draft.score_after),
    final_liquidity_response: firstPresent(correction.finalLiquidityResponse, draft.liquidity_response_after),
    final_regime: firstPresent(correction.finalRegime, draft.regime_after),
    reviewer_correction_note: correction.note ?? null
  };
}

function requireReleasePayload(payload) {
  for (const key of ['run_id', 'event_id']) {
    if (typeof payload[key] !== 'string' || payload[key].trim() === '') {
      throw new Error(`publishStressChange requires proposal.payload.${key}`);
    }
  }
}

export async function publishStressChange(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, STRESS_PROPOSAL_TYPE);

  const { dataDir, causationId = null, correlationId, instanceConfig } = ctx;
  if (!dataDir) {
    throw new Error('publishStressChange requires a dataDir');
  }

  const priorEvent = existingSuccessfulPublish(dataDir, proposal);
  if (priorEvent) {
    return {
      published: false,
      idempotent: true,
      runId: priorEvent.payload?.request?.run_id ?? proposal.payload?.run_id ?? null,
      event: priorEvent
    };
  }

  const correctionEvent = latestCorrection(dataDir, proposal.id);
  const request = buildReleasePayload(proposal, correctionEvent);
  requireReleasePayload(request);

  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const client = ctx.e3dClient ?? createE3dClient(instanceConfig?.e3d ?? {});
  const publishedAt = new Date().toISOString();

  try {
    const response = await client.releaseFinancialStressChange(request);
    const event = append({
      type: 'financial-stress-change.published',
      source: 'action:publish-stress-change',
      subject: { type: 'proposal', id: proposal.id },
      payload: {
        proposalId: proposal.id,
        runId: request.run_id,
        eventId: request.event_id,
        request,
        response,
        success: true,
        publishedAt
      },
      causationId,
      correlationId: correlationId ?? proposal.correlationId
    });

    return { published: true, idempotent: false, runId: request.run_id, response, event };
  } catch (error) {
    const event = append({
      type: 'financial-stress-change.published',
      source: 'action:publish-stress-change',
      subject: { type: 'proposal', id: proposal.id },
      payload: {
        proposalId: proposal.id,
        runId: request.run_id,
        eventId: request.event_id,
        request,
        response: null,
        success: false,
        error: error.message,
        publishedAt
      },
      causationId,
      correlationId: correlationId ?? proposal.correlationId
    });
    error.event = event;
    throw error;
  }
}
