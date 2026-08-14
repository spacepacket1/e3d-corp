import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';
import { validateProposalInput } from './schema.js';
import { getRequiredAuthorityLevel, AUTHORITY_LEVELS } from '../authority/policy.js';
import { authorityNotify } from '../authority/notify.js';

// Creating a Proposal is itself an authority-level-1 (internal, reversible)
// write - autonomous, no approval needed, exactly like creating an
// Opportunity in Phase 4. What the Proposal proposes to *do* is what carries
// authorityLevel 2-4 and requires a Decision before it fires.
export function createProposal(
  dataDir,
  { type, payload, proposedBy, causationId = null, correlationId, instanceConfig } = {}
) {
  const { valid, errors } = validateProposalInput({ type, payload, proposedBy, causationId, correlationId });
  if (!valid) {
    throw new Error(`Invalid proposal:\n- ${errors.join('\n- ')}`);
  }

  // authorityLevel always comes from the versioned policy table, never from
  // the caller - this is what makes the table a single source of truth
  // instead of something a role could accidentally under-declare.
  const authorityLevel = getRequiredAuthorityLevel(type);
  if (authorityLevel < AUTHORITY_LEVELS.EXTERNAL_ACTION) {
    throw new Error(
      `Action type "${type}" is authority level ${authorityLevel}; levels 0-1 are autonomous writes and never generate a Proposal`
    );
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const record = {
    id,
    type,
    payload,
    proposedBy,
    authorityLevel,
    causationId,
    correlationId,
    status: 'pending',
    createdAt
  };

  const event = appendEvent(dataDir, {
    type: 'proposal.created',
    source: `role:${proposedBy.role}`,
    subject: { type: 'proposal', id },
    payload: record,
    causationId,
    correlationId
  });

  // Best-effort: every newly pending level-2+ proposal (all of them, by
  // construction) triggers optional notification. Failure never blocks
  // approvability - authorityNotify never throws.
  if (instanceConfig) {
    authorityNotify(instanceConfig, record);
  }

  return { proposal: record, event };
}
