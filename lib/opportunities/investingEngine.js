import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';
import { runInvestingOpportunityScorer } from '../roles/investingOpportunity.js';
import { scoreOpportunity } from './scoring.js';

// Authority level 1, same as runOpportunityEngine: persisting the role's
// already-validated candidate as an Opportunity record is an internal,
// reversible write. Deciding what to do about it (pursuing/reviewed/no-value)
// stays a separate, explicit human Decision via decideOpportunity — this
// function never marks anything "pursuing" itself.
export async function runInvestingOpportunityEngine({
  instanceConfig,
  dataDir,
  triggerEvent,
  researchAdapter,
  researchQuery,
  marketState,
  llmClient
} = {}) {
  if (!triggerEvent) {
    throw new Error('runInvestingOpportunityEngine requires a triggerEvent');
  }

  const candidates = await runInvestingOpportunityScorer({
    instanceConfig,
    dataDir,
    triggerEvent,
    researchAdapter,
    researchQuery,
    marketState,
    llmClient
  });

  const opportunities = [];
  const createdEvents = [];
  const scoredEvents = [];

  for (const candidate of candidates) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const record = {
      id,
      type: candidate.type,
      title: candidate.title,
      description: candidate.description,
      view: candidate.view,
      confidence: candidate.confidence,
      rationale: candidate.rationale,
      invalidationCondition: candidate.invalidationCondition,
      thesisRefs: candidate.thesisRefs,
      storyRefs: candidate.storyRefs,
      evidence: candidate.evidenceEventIds,
      score: null,
      status: 'candidate',
      sourceEventIds: candidate.sourceEventIds,
      correlationId: candidate.correlationId,
      proposedBy: candidate.proposedBy,
      createdAt
    };

    // Validation (normalizeInvestingOpportunityCandidate, inside
    // runInvestingOpportunityScorer) already ran before any event was
    // appended, so a malformed role output never reaches this point.
    const createdEvent = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.investing',
      subject: { type: 'opportunity', id },
      payload: { ...record, roleConfidence: candidate.confidence },
      causationId: triggerEvent.id,
      correlationId: candidate.correlationId
    });

    const score = scoreOpportunity({
      confidence: candidate.confidence,
      evidenceCount: candidate.evidenceEventIds.length,
      triggerOccurredAt: triggerEvent.occurredAt,
      type: candidate.type,
      weights: instanceConfig?.scoring?.weights,
      typeWeights: instanceConfig?.scoring?.typeWeights
    });

    const scoredEvent = appendEvent(dataDir, {
      type: 'opportunity.scored',
      source: 'opportunity.engine',
      subject: { type: 'opportunity', id },
      payload: { id, score, status: 'scored' },
      causationId: createdEvent.id,
      correlationId: candidate.correlationId
    });

    opportunities.push({ ...record, confidence: candidate.confidence, score, status: 'scored' });
    createdEvents.push(createdEvent);
    scoredEvents.push(scoredEvent);
  }

  return { opportunities, createdEvents, scoredEvents };
}
