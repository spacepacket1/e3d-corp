import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';
import { runOpportunityProspect } from '../roles/opportunityProspect.js';
import { scoreOpportunity } from './scoring.js';

// Authority level 1: creating/scoring an Opportunity from the role's already-
// validated output is an internal, reversible write — autonomous, no approval
// needed. The role (runOpportunityProspect) never writes state itself; this is
// the one place a candidate becomes a real Opportunity record.
export async function runOpportunityEngine({
  instanceConfig,
  dataDir,
  triggerEvent,
  researchAdapter,
  researchQuery,
  llmClient
} = {}) {
  if (!triggerEvent) {
    throw new Error('runOpportunityEngine requires a triggerEvent');
  }

  const candidates = await runOpportunityProspect({
    instanceConfig,
    dataDir,
    triggerEvent,
    researchAdapter,
    researchQuery,
    llmClient
  });

  const opportunities = [];
  const createdEvents = [];
  const scoredEvents = [];

  for (const candidate of candidates) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const pursuable = candidate.counterparty.kind !== 'none';
    const record = {
      id,
      type: candidate.type,
      title: candidate.title,
      description: candidate.description,
      evidence: candidate.evidenceEventIds,
      score: null,
      status: 'candidate',
      counterparty: candidate.counterparty,
      pursuable,
      sourceEventIds: candidate.sourceEventIds,
      correlationId: candidate.correlationId,
      proposedBy: candidate.proposedBy,
      createdAt
    };

    // Validation (normalizeOpportunityCandidate, inside runOpportunityProspect)
    // already ran before any event was appended, so a malformed role output never
    // reaches this point — nothing here can leave a half-written Opportunity.
    const createdEvent = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id },
      payload: { ...record, roleConfidence: candidate.confidence, roleRationale: candidate.rationale },
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

    opportunities.push({ ...record, score, status: 'scored' });
    createdEvents.push(createdEvent);
    scoredEvents.push(scoredEvent);
  }

  return {
    opportunities,
    createdEvents,
    scoredEvents
  };
}

// The scheduled-discovery trigger: for each free-text research-topic hint in
// instance config, raise a fresh market.signal.detected event, gather broad
// evidence for it through the research layer, and feed it into the same
// opportunity.prospect role a lead.received event would go through.
export async function runDiscoveryPass({ instanceConfig, dataDir, researchAdapter, llmClient } = {}) {
  const topics = instanceConfig?.researchTopics ?? [];
  const results = [];

  for (const topic of topics) {
    try {
      const signalEvent = appendEvent(dataDir, {
        type: 'market.signal.detected',
        source: 'discovery.scheduled',
        subject: { type: 'research-topic', id: topic },
        payload: { topic },
        causationId: null,
        correlationId: crypto.randomUUID()
      });

      if (researchAdapter) {
        await researchAdapter.webSearch(topic, {
          causationId: signalEvent.id,
          correlationId: signalEvent.correlationId
        });
        await researchAdapter.searchKnowledgeBase(topic, {
          causationId: signalEvent.id,
          correlationId: signalEvent.correlationId
        });
      }

      const { opportunities } = await runOpportunityEngine({
        instanceConfig,
        dataDir,
        triggerEvent: signalEvent,
        researchAdapter,
        researchQuery: topic,
        llmClient
      });

      results.push({ topic, signalEvent, opportunities });
    } catch (error) {
      results.push({ topic, error: error.message });
    }
  }

  return results;
}
