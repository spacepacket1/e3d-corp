import { appendEvent } from '../events/store.js';
import { getProposalCreatedEvent } from './store.js';

const STRESS_PROPOSAL_TYPE = 'publish-stress-change';

function blankToNull(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeFinalScore(value) {
  const normalized = blankToNull(value);
  if (normalized === null) {
    return null;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) {
    throw new Error('finalScore must be a finite number');
  }
  return number;
}

export function submitFinancialStressCorrection(dataDir, proposal, correction, { via = 'web' } = {}) {
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('Proposal is required for financial stress correction');
  }
  if (proposal.type !== STRESS_PROPOSAL_TYPE) {
    throw new Error(`Financial stress correction only applies to ${STRESS_PROPOSAL_TYPE} proposals`);
  }

  const createdEvent = getProposalCreatedEvent(dataDir, proposal.id);
  if (!createdEvent) {
    throw new Error(`Proposal created event not found for ${proposal.id}`);
  }

  return appendEvent(dataDir, {
    type: 'financial-stress-correction.submitted',
    source: `review:${via}`,
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      finalScore: normalizeFinalScore(correction?.finalScore),
      finalLiquidityResponse: blankToNull(correction?.finalLiquidityResponse),
      finalRegime: blankToNull(correction?.finalRegime),
      note: blankToNull(correction?.note)
    },
    causationId: createdEvent.id,
    correlationId: proposal.correlationId
  });
}
