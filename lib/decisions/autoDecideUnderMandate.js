import crypto from 'node:crypto';
import { appendEventWithinLock, withEventsLockAsync } from '../events/store.js';
import { getProposal, getProposalCreatedEvent } from '../proposals/store.js';
import { getActionExecutor } from '../actions/registry.js';
import { AUTHORITY_LEVELS } from '../authority/policy.js';
import { AD_MANDATE_PROPOSAL_TYPE, currentAdMandateStatus } from '../proposals/adMandateSchema.js';

// Phase 2 of docs/futco-ad-mandate-spec.md (e3d-pilot) is the one decision
// this codebase currently allows to run with no human click at all:
// commission-creative never spends money or publishes anything (authority
// level 2, same as pilot-handoff - e3d-creative's own QA gate is the real
// quality check). A human still proposes and approves the ad_mandate itself;
// this only automates "does this routine creative variant fall within an
// already-approved mandate" - re-checked live on every call, never cached,
// the same discipline e3d-trade's currentMandateStatus already enforces.
const AUTO_DECIDABLE_PROPOSAL_TYPES = new Set(['commission-creative']);

// A pure, non-throwing predicate so ops/reports/autoDecideCommissionCreative.js
// can scan many (proposal, mandate) pairs without using exceptions for
// control flow; autoDecideUnderMandate itself throws using this same check.
export function evaluateMandateCoverage(mandate, proposal) {
  if (!mandate || currentAdMandateStatus(mandate) !== 'active') {
    return { covered: false, reason: `ad_mandate ${mandate?.mandate_id ?? '(unknown)'} is not active (status: ${currentAdMandateStatus(mandate)})` };
  }
  if (mandate.constraints?.paper_only_creative !== true) {
    return { covered: false, reason: `ad_mandate ${mandate.mandate_id} does not have paper_only_creative:true` };
  }
  if (mandate.constraints?.allowed_campaign_ids !== null) {
    // commission-creative proposals carry no campaignId today, so a mandate
    // scoped to specific campaigns can never be verified against one - fail
    // closed rather than guess which campaign a creative variant belongs to.
    return {
      covered: false,
      reason: `ad_mandate ${mandate.mandate_id} is scoped to allowed_campaign_ids, but commission-creative proposals carry no campaignId to check against`
    };
  }
  const product = proposal?.payload?.brief?.product;
  const allowedProducts = mandate.constraints?.allowed_products ?? [];
  if (typeof product !== 'string' || product.trim() === '' || !allowedProducts.includes(product)) {
    return {
      covered: false,
      reason: `proposal ${proposal?.id}'s brief.product "${product}" is not in ad_mandate ${mandate.mandate_id}'s allowed_products`
    };
  }
  return { covered: true, reason: null };
}

function assertMandateCoversProposal(mandate, proposal) {
  const { covered, reason } = evaluateMandateCoverage(mandate, proposal);
  if (!covered) {
    throw new Error(`Autonomous decision refused: ${reason}`);
  }
}

// dataDir/instanceConfig mirror decideProposal's signature; proposalId is the
// pending commission-creative Proposal's id, mandateProposalId is the
// *ad_mandate Proposal's* id (not its internal mandate_id) whose activated
// mandate should cover it. Returns the same decision/event/executed/
// executionResult shape as decideProposal so callers (CLI, the scheduled
// scan, tests) can treat it uniformly.
export async function autoDecideUnderMandate(dataDir, proposalId, mandateProposalId, instanceConfig) {
  if (typeof proposalId !== 'string' || proposalId.trim() === '') {
    throw new Error('autoDecideUnderMandate requires a proposalId');
  }
  if (typeof mandateProposalId !== 'string' || mandateProposalId.trim() === '') {
    throw new Error('autoDecideUnderMandate requires a mandateProposalId');
  }

  const proposal = getProposal(dataDir, proposalId);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }
  if (!AUTO_DECIDABLE_PROPOSAL_TYPES.has(proposal.type)) {
    throw new Error(`Autonomous decision refused: proposal type "${proposal.type}" is not eligible for autonomous mandate decisions`);
  }
  if (proposal.status !== 'pending') {
    throw new Error(`Autonomous decision refused: proposal ${proposalId} is already ${proposal.status}`);
  }

  const mandateProposal = getProposal(dataDir, mandateProposalId);
  if (!mandateProposal || mandateProposal.type !== AD_MANDATE_PROPOSAL_TYPE) {
    throw new Error(`Autonomous decision refused: ${mandateProposalId} is not a known ad_mandate proposal`);
  }
  assertMandateCoversProposal(mandateProposal.payload, proposal);

  const createdEvent = getProposalCreatedEvent(dataDir, proposalId);
  const decisionId = crypto.randomUUID();
  const decidedAt = new Date().toISOString();
  const mandateIdValue = mandateProposal.payload.mandate_id;

  const result = {
    decision: {
      id: decisionId,
      subjectType: 'proposal',
      subjectId: proposalId,
      decision: 'approved',
      decidedBy: `ad_mandate:${mandateIdValue}`,
      decidedAt,
      via: 'autonomous-mandate'
    },
    event: null,
    executed: false,
    executionResult: undefined,
    mandateId: mandateIdValue
  };

  await withEventsLockAsync(dataDir, async () => {
    // Re-fetch everything inside the lock and re-check from scratch - the
    // mandate or proposal could have been revoked/decided between the checks
    // above and now, and this must never execute on a stale read.
    const currentProposal = getProposal(dataDir, proposalId);
    if (!currentProposal || currentProposal.status !== 'pending') {
      throw new Error(`Autonomous decision refused: proposal ${proposalId} is no longer pending`);
    }
    const currentMandateProposal = getProposal(dataDir, mandateProposalId);
    if (!currentMandateProposal || currentMandateProposal.type !== AD_MANDATE_PROPOSAL_TYPE) {
      throw new Error(`Autonomous decision refused: ${mandateProposalId} is no longer a known ad_mandate proposal`);
    }
    assertMandateCoversProposal(currentMandateProposal.payload, currentProposal);

    const event = appendEventWithinLock(dataDir, {
      type: 'proposal.approved',
      source: 'decision:autonomous-mandate',
      subject: { type: 'proposal', id: proposalId },
      payload: {
        decisionId,
        subjectType: 'proposal',
        subjectId: proposalId,
        decision: 'approved',
        reason: `Auto-approved under active ad_mandate ${currentMandateProposal.payload.mandate_id}`,
        decidedBy: `ad_mandate:${currentMandateProposal.payload.mandate_id}`,
        decidedAt,
        via: 'autonomous-mandate',
        mandateId: currentMandateProposal.payload.mandate_id
      },
      causationId: createdEvent ? createdEvent.id : null,
      correlationId: currentProposal.correlationId
    });
    result.event = event;

    if (currentProposal.authorityLevel === AUTHORITY_LEVELS.EXTERNAL_ACTION) {
      const executor = getActionExecutor(currentProposal.type);
      if (executor) {
        const approvedProposal = { ...currentProposal, status: 'approved' };
        result.executionResult = await executor(approvedProposal, {
          dataDir,
          causationId: event.id,
          correlationId: currentProposal.correlationId,
          instanceConfig,
          appendEvent: (actionEvent) => appendEventWithinLock(dataDir, actionEvent)
        });
        result.executed = true;
      }
    }
  });

  return result;
}
