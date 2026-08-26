import crypto from 'node:crypto';
import { appendEvent, appendEventWithinLock, queryEvents, withEventsLockAsync } from '../events/store.js';
import { getOpportunity } from '../opportunities/store.js';
import { getProposal, getProposalCreatedEvent } from '../proposals/store.js';
import { getActionExecutor } from '../actions/registry.js';
import { AUTHORITY_LEVELS } from '../authority/policy.js';

// The full set of "what should we do about this Opportunity" decisions
// exposed by Phase 6's decide form. Deciding what to pursue is always an
// explicit human Decision regardless of authority level (a product choice
// about where judgment belongs), even though the underlying write is
// itself authority level 1.
const OPPORTUNITY_DECISIONS = ['reviewed', 'pursuing', 'no-value'];
const PROPOSAL_DECISIONS = ['approved', 'rejected'];

function outreachAlreadySentForOpportunity(dataDir, correlationId) {
  return queryEvents(dataDir, { type: 'outreach.sent', correlationId }).length > 0;
}

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('A non-empty reason is required for this decision');
  }
}

function requireDecidedBy(decidedBy) {
  if (typeof decidedBy !== 'string' || decidedBy.trim() === '') {
    throw new Error('decidedBy is required');
  }
}

function requireVia(via) {
  if (via !== 'cli' && via !== 'web') {
    throw new Error(`via must be "cli" or "web", got "${via}"`);
  }
}

// This is the single implementation both the CLI and Phase 6's web UI call
// for deciding what to pursue on an Opportunity - persisted as an
// `opportunity.reviewed` event, never a second implementation per surface.
export function decideOpportunity(dataDir, id, decision, reason, decidedBy, via) {
  if (!OPPORTUNITY_DECISIONS.includes(decision)) {
    throw new Error(`Unknown opportunity decision "${decision}"; expected one of ${OPPORTUNITY_DECISIONS.join(', ')}`);
  }
  requireReason(reason);
  requireDecidedBy(decidedBy);
  requireVia(via);

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    throw new Error(`Opportunity not found: ${id}`);
  }

  const priorEvents = queryEvents(dataDir, { subject: { type: 'opportunity', id } });
  const latest = priorEvents[priorEvents.length - 1];

  const decisionId = crypto.randomUUID();
  const decidedAt = new Date().toISOString();

  const event = appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: `decision:${via}`,
    subject: { type: 'opportunity', id },
    payload: {
      decisionId,
      subjectType: 'opportunity',
      subjectId: id,
      decision,
      // `status` mirrors `decision` so lib/opportunities/store.js's fold
      // (which reads opportunity.reviewed.payload.status) picks it up.
      status: decision,
      reason,
      decidedBy,
      decidedAt,
      via
    },
    causationId: latest ? latest.id : null,
    correlationId: opportunity.correlationId
  });

  return {
    decision: { id: decisionId, subjectType: 'opportunity', subjectId: id, decision, reason, decidedBy, decidedAt, via },
    event
  };
}

// The single implementation both the CLI and Phase 6's web UI call for
// approving/rejecting a Proposal. For an authority-level-2 proposal,
// approval and execution are the same call: if an action-execution function
// is registered (lib/actions/registry.js) for the proposal's type, it fires
// immediately, in this same call. For level-3/4, approval only flips status
// to `approved` - execution requires the separate confirmAndExecute call
// below.
export async function decideProposal(dataDir, id, decision, reason, decidedBy, via, instanceConfig) {
  if (!PROPOSAL_DECISIONS.includes(decision)) {
    throw new Error(`Unknown proposal decision "${decision}"; expected one of ${PROPOSAL_DECISIONS.join(', ')}`);
  }
  requireReason(reason);
  requireDecidedBy(decidedBy);
  requireVia(via);

  const proposal = getProposal(dataDir, id);
  if (!proposal) {
    throw new Error(`Proposal not found: ${id}`);
  }
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal ${id} is already ${proposal.status}; only a pending proposal can be decided`);
  }

  const createdEvent = getProposalCreatedEvent(dataDir, id);
  const decisionId = crypto.randomUUID();
  const decidedAt = new Date().toISOString();
  const eventType = decision === 'approved' ? 'proposal.approved' : 'proposal.rejected';

  const result = {
    decision: { id: decisionId, subjectType: 'proposal', subjectId: id, decision, reason, decidedBy, decidedAt, via },
    event: null,
    executed: false,
    executionResult: undefined
  };

  await withEventsLockAsync(dataDir, async () => {
    const currentProposal = getProposal(dataDir, id);
    if (!currentProposal) {
      throw new Error(`Proposal not found: ${id}`);
    }
    if (currentProposal.status !== 'pending') {
      throw new Error(`Proposal ${id} is already ${currentProposal.status}; only a pending proposal can be decided`);
    }

    if (
      decision === 'approved' &&
      currentProposal.type === 'send-outreach' &&
      outreachAlreadySentForOpportunity(dataDir, currentProposal.correlationId)
    ) {
      throw new Error('Approval refused: outreach already sent for this opportunity');
    }

    const event = appendEventWithinLock(dataDir, {
      type: eventType,
      source: `decision:${via}`,
      subject: { type: 'proposal', id },
      payload: { decisionId, subjectType: 'proposal', subjectId: id, decision, reason, decidedBy, decidedAt, via },
      causationId: createdEvent ? createdEvent.id : null,
      correlationId: currentProposal.correlationId
    });
    result.event = event;

    if (decision === 'approved' && currentProposal.authorityLevel === AUTHORITY_LEVELS.EXTERNAL_ACTION) {
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

// The distinct, separate confirmation step required before a level-3/4
// action fires. Deliberately does not accept a `reason` - the deliberation
// already happened at approval; this step is the "yes, actually do it now"
// friction the spec asks for on financial/irreversible actions.
export async function confirmAndExecute(dataDir, proposalId, confirmedBy, via, instanceConfig) {
  requireDecidedBy(confirmedBy);
  requireVia(via);

  const proposal = getProposal(dataDir, proposalId);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }
  if (proposal.status !== 'approved') {
    throw new Error(`Proposal ${proposalId} must be approved before confirmAndExecute (status: ${proposal.status})`);
  }
  if (proposal.authorityLevel < AUTHORITY_LEVELS.FINANCIAL_ACTION) {
    throw new Error(
      `Proposal ${proposalId} is authority level ${proposal.authorityLevel}; level-2 actions already execute on approval and do not use confirmAndExecute`
    );
  }

  const executor = getActionExecutor(proposal.type);
  if (!executor) {
    throw new Error(`No action executor registered for proposal type "${proposal.type}"`);
  }

  const approvalEvents = queryEvents(dataDir, {
    type: 'proposal.approved',
    subject: { type: 'proposal', id: proposalId }
  });
  const approvalEvent = approvalEvents[approvalEvents.length - 1];

  const executionResult = await executor(proposal, {
    dataDir,
    causationId: approvalEvent ? approvalEvent.id : null,
    correlationId: proposal.correlationId,
    confirmedBy,
    via,
    instanceConfig
  });

  return { executionResult };
}
