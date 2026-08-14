export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validates the input to createProposal. `authorityLevel` is deliberately not
// part of this input - it is derived from the versioned policy table
// (lib/authority/policy.js) by type, never trusted from a caller, so a role
// can never under-declare the authority an action actually needs.
export function validateProposalInput({ type, payload, proposedBy, causationId, correlationId }) {
  const errors = [];

  if (!isNonEmptyString(type)) {
    errors.push('type: must be a non-empty string');
  }
  if (payload === undefined) {
    errors.push('payload: is required');
  }
  if (!isPlainObject(proposedBy)) {
    errors.push('proposedBy: must be an object with { role, provider, model }');
  } else {
    if (!isNonEmptyString(proposedBy.role)) errors.push('proposedBy.role: must be a non-empty string');
    if (!isNonEmptyString(proposedBy.provider)) errors.push('proposedBy.provider: must be a non-empty string');
    if (!isNonEmptyString(proposedBy.model)) errors.push('proposedBy.model: must be a non-empty string');
  }
  if (causationId !== null && causationId !== undefined && !isNonEmptyString(causationId)) {
    errors.push('causationId: must be a non-empty string or null');
  }
  if (!isNonEmptyString(correlationId)) {
    errors.push('correlationId: must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}
