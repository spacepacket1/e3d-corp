import crypto from 'node:crypto';
import { createProposal } from './create.js';

const VALID_STATUSES = new Set(['ACTIVE', 'PAUSED']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Unlike commission-creative/pilot-handoff, this is not gated behind a
// "pursuing" Opportunity - the ops/backfill/2026-10-02-meta-campaign-ledger-backfill.js
// precedent already shows a real campaign change being proposed directly by
// a human ("human-direct" proposedBy, no Opportunity), and pausing a
// campaign in response to a just-reviewed cost spike is exactly that kind of
// direct operational decision. An opportunityId/correlationId can still be
// threaded through (causationId/correlationId params) to keep the causal
// chain connected when one exists.
export function proposeMetaCampaignChange(dataDir, {
  campaignId,
  campaignLabel,
  toStatus,
  reason,
  proposedBy,
  causationId = null,
  correlationId,
  instanceConfig
} = {}) {
  if (!isNonEmptyString(campaignId)) {
    throw new Error('proposeMetaCampaignChange requires a non-empty campaignId');
  }
  if (!VALID_STATUSES.has(toStatus)) {
    throw new Error(`proposeMetaCampaignChange: toStatus must be one of ${[...VALID_STATUSES].join(', ')}, got "${toStatus}"`);
  }
  if (!isNonEmptyString(reason)) {
    throw new Error('proposeMetaCampaignChange requires a non-empty reason');
  }

  return createProposal(dataDir, {
    type: 'meta-campaign-change',
    payload: {
      campaignId: campaignId.trim(),
      campaignLabel: isNonEmptyString(campaignLabel) ? campaignLabel.trim() : null,
      toStatus,
      reason: reason.trim()
    },
    proposedBy: proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    causationId,
    correlationId: isNonEmptyString(correlationId) ? correlationId : crypto.randomUUID(),
    instanceConfig
  });
}
