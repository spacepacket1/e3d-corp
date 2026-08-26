import { appendEvent } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { reconstructChain } from '../events/chain.js';
import { getOpportunity } from '../opportunities/store.js';
import { writeHandoffArtifact } from '../pilot/handoffArtifact.js';

// The real action-execution function for `pilot-handoff` proposals. Refuses
// anything but an approved proposal (assertProposalAuthorized, same as
// Phase 7's sendOutreach) and, on success, writes the handoff artifact
// (lib/pilot/handoffArtifact.js) and appends `pilot-handoff.created` with the
// originating correlationId preserved. Never invokes `e3d-pilot` itself - a
// human runs it separately, pointed at the target repo, exactly as they
// would today.
export async function pilotHandoff(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, 'pilot-handoff');

  const { dataDir, causationId = null, correlationId } = ctx;
  if (!dataDir) {
    throw new Error('pilotHandoff requires a dataDir');
  }
  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));

  const { opportunityId, targetRepo, reason } = proposal.payload ?? {};
  if (typeof opportunityId !== 'string' || opportunityId.trim() === '' || typeof targetRepo !== 'string' || targetRepo.trim() === '') {
    throw new Error(`Proposal ${proposal.id} is missing opportunityId/targetRepo; refusing to hand off`);
  }

  const opportunity = getOpportunity(dataDir, opportunityId);
  if (!opportunity) {
    throw new Error(`Cannot hand off: opportunity ${opportunityId} not found`);
  }
  const chain = reconstructChain(dataDir, opportunity.correlationId);

  const { configPath, auditPath, researchTopicsUpdated } = writeHandoffArtifact({
    targetRepoPath: targetRepo,
    opportunity,
    chain,
    reason
  });

  const event = append({
    type: 'pilot-handoff.created',
    source: 'action:pilot-handoff',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      opportunityId,
      targetRepo,
      configPath,
      auditPath,
      researchTopicsUpdated,
      createdAt: new Date().toISOString()
    },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });

  return { handedOff: true, configPath, auditPath, event };
}
