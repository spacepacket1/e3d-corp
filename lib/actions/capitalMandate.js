import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import {
  CAPITAL_MANDATE_PROPOSAL_TYPE,
  validateCapitalMandatePayload,
  validateCapitalMandateTransition
} from '../proposals/capitalMandateSchema.js';
import { createE3dTradeClient } from '../trade/client.js';

function existingSubmissionEvent(dataDir, mandateId) {
  const events = queryEvents(dataDir, { type: 'capital-mandate.submitted' });
  return events.find((event) => event.payload?.mandateId === mandateId) ?? null;
}

function validateApprovedMandate(mandate, proposalId) {
  const { valid, errors } = validateCapitalMandatePayload(mandate);
  if (!valid) {
    throw new Error(`Action refused: invalid capital_mandate payload\n- ${errors.join('\n- ')}`);
  }
  if (mandate.status !== 'approved') {
    throw new Error(`Action refused: capital_mandate ${mandate.mandate_id} must be approved before submission (status: ${mandate.status})`);
  }
  if (mandate.proposal_id !== proposalId) {
    throw new Error(`Action refused: capital_mandate proposal_id ${mandate.proposal_id} does not match proposal ${proposalId}`);
  }
  if (!mandate.decision_id) {
    throw new Error(`Action refused: capital_mandate ${mandate.mandate_id} has no approving decision_id`);
  }
}

function buildActiveMandate(mandate, activatedAt) {
  const transition = validateCapitalMandateTransition(mandate.status, 'active');
  if (!transition.valid) {
    throw new Error(`Action refused: ${transition.errors.join('; ')}`);
  }
  return {
    ...mandate,
    status: 'active',
    effective_at: mandate.effective_at ?? activatedAt
  };
}

function normalizeAckStatus(ack) {
  return ack?.status ?? ack?.mandate?.status ?? ack?.current_status ?? null;
}

function validateAcknowledgement(ack, mandateId) {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    throw new Error('e3d-trade returned an empty or malformed capital_mandate acknowledgement');
  }
  const accepted = ack.accepted === true || ack.ok === true;
  const status = normalizeAckStatus(ack);
  const ackMandateId = ack.mandate_id ?? ack.mandate?.mandate_id ?? mandateId;

  if (ackMandateId !== mandateId) {
    throw new Error(`e3d-trade acknowledged mandate_id ${ackMandateId}, expected ${mandateId}`);
  }
  if (!accepted) {
    throw new Error(`e3d-trade rejected capital_mandate ${mandateId}: ${ack.reason ?? ack.message ?? 'no reason provided'}`);
  }
  if (status !== 'active') {
    throw new Error(`e3d-trade acknowledged capital_mandate ${mandateId} with status "${status}", expected "active"`);
  }

  return { accepted, status };
}

// Financial action for approved `capital_mandate` proposals. It uses the
// same authority guard as every other consequential action, sends the mandate
// over the service boundary, and only records activation after a synchronous
// accepted/active acknowledgement from e3d-trade.
export async function submitCapitalMandate(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, CAPITAL_MANDATE_PROPOSAL_TYPE);

  const { dataDir, causationId = null, correlationId, instanceConfig } = ctx;
  if (!dataDir) {
    throw new Error('submitCapitalMandate requires a dataDir');
  }

  const mandate = proposal.payload;
  const mandateId = typeof mandate?.mandate_id === 'string' ? mandate.mandate_id : null;
  const priorEvent = mandateId ? existingSubmissionEvent(dataDir, mandateId) : null;
  if (priorEvent) {
    return {
      submitted: false,
      idempotent: true,
      mandateId,
      status: priorEvent.payload?.tradeStatus ?? priorEvent.payload?.submittedStatus ?? 'active',
      event: priorEvent
    };
  }

  validateApprovedMandate(mandate, proposal.id);

  const submittedAt = new Date().toISOString();
  const activeMandate = buildActiveMandate(mandate, submittedAt);
  const client = ctx.tradeClient ?? createE3dTradeClient(instanceConfig?.e3dTrade ?? {});
  const ack = await client.submitCapitalMandate(activeMandate);
  const acknowledgement = validateAcknowledgement(ack, activeMandate.mandate_id);

  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const event = append({
    type: 'capital-mandate.submitted',
    source: 'action:capital_mandate',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      mandateId: activeMandate.mandate_id,
      owner: activeMandate.owner,
      previousStatus: mandate.status,
      submittedStatus: activeMandate.status,
      tradeStatus: acknowledgement.status,
      submittedAt,
      endpoint: ack.endpoint ?? null,
      tradeAcknowledgementId: ack.ack_id ?? ack.id ?? null
    },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });

  return {
    submitted: true,
    idempotent: false,
    mandateId: activeMandate.mandate_id,
    status: acknowledgement.status,
    acknowledgement: ack,
    event
  };
}
