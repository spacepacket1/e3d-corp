import { appendEvent, queryEvents } from '../events/store.js';
import { getOpportunity } from '../opportunities/store.js';
import { listProposals } from '../proposals/store.js';
import { createProposal } from '../proposals/create.js';
import { PILOT_NUDGE_PROPOSAL_TYPE } from '../proposals/pilotRetentionNudgeSchema.js';
import { PILOT_RETENTION_TYPE } from '../opportunities/pilotOpportunities.js';
import { draftRetentionCopy, ROLE_NAME } from '../roles/pilotRetentionCopy.js';

// Turns one pilot-retention-recommendation Opportunity into a pending pilot-retention-nudge Proposal. The cohort and
// its head-count come from the cited evidence event (never from a person-level source). One model call per Opportunity:
// an Opportunity that already has a nudge proposal is returned as-is.
export async function proposeRetentionNudge(dataDir, opportunityId, { instanceConfig, llmClient, now = new Date() } = {}) {
  const opportunity = getOpportunity(dataDir, opportunityId);
  if (!opportunity) throw new Error(`Opportunity not found: ${opportunityId}`);
  if (opportunity.type !== PILOT_RETENTION_TYPE || !opportunity.signal?.cohort) {
    throw new Error(`Opportunity ${opportunityId} is not a Pilot retention recommendation (type: ${opportunity.type})`);
  }
  const existing = listProposals(dataDir, { type: PILOT_NUDGE_PROPOSAL_TYPE }).find((p) => p.payload?.opportunityId === opportunityId);
  if (existing) return { alreadyProposed: true, proposal: existing };

  const evidence = queryEvents(dataDir, { type: 'evidence.gathered' }).find((e) => opportunity.evidence.includes(e.id) && e.payload?.kind === 'pilot-metrics-signal');
  const count = evidence?.payload?.result?.metrics?.count;
  if (!Number.isInteger(count) || count < 1) throw new Error(`Opportunity ${opportunityId} cites no cohort head-count`);
  const cohort = opportunity.signal.cohort;
  const chain = opportunity.correlationId;
  const stamp = now.toISOString();

  let result;
  try {
    result = await draftRetentionCopy({ instanceConfig, cohort, count, llmClient });
  } catch (error) {
    appendEvent(dataDir, { type: 'role.provider.failed', source: `role:${ROLE_NAME}`, subject: { type: 'role', id: ROLE_NAME }, payload: { role: ROLE_NAME, reason: error.message, opportunityId }, causationId: null, correlationId: chain, occurredAt: stamp });
    return { failed: true, reason: error.message };
  }
  const providerEvent = appendEvent(dataDir, {
    type: 'role.provider.completed', source: `role:${ROLE_NAME}`, subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider: result.provider, model: result.model, usage: result.usage, costUsd: result.costUsd, latencyMs: result.latencyMs, opportunityId },
    causationId: null, correlationId: chain, occurredAt: stamp
  });
  if (!result.ok) return { failed: true, reason: result.reason, providerEvent };

  const { proposal } = createProposal(dataDir, {
    type: PILOT_NUDGE_PROPOSAL_TYPE,
    payload: { cohort, count, copy: result.copy, opportunityId, sampleEventId: evidence.payload.result.sampleEventIds?.[0] ?? null, rationale: opportunity.title },
    proposedBy: { role: ROLE_NAME, provider: result.provider, model: result.model },
    causationId: providerEvent.id,
    correlationId: chain,
    instanceConfig
  });
  return { proposal, providerEvent };
}
