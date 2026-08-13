// Non-exhaustive: `type` is an open string, not a fixed enum. These are documented
// examples the opportunity.prospect prompt suggests, and what instance config's
// `scoring.typeWeights` can key off of.
export const OPPORTUNITY_TYPE_EXAMPLES = [
  'consulting-engagement',
  'product-opportunity',
  'feature-signal',
  'partnership',
  'distribution',
  'technology-to-investigate',
  'market-trend',
  'competitor-development',
  'event-to-attend',
  'integration-opportunity',
  'operational-improvement',
  'cost-saving',
  'other'
];

export const OPPORTUNITY_STATUSES = [
  'candidate',
  'scored',
  'reviewed',
  'pursuing',
  'won',
  'lost',
  'no-value'
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

// Validates the structured JSON the opportunity.prospect role must return —
// never free text the pipeline guess-parses.
export function validateOpportunityCandidate(candidate) {
  const errors = [];

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: ['candidate: must be an object'] };
  }

  if (!isNonEmptyString(candidate.type)) {
    errors.push('type: must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.title)) {
    errors.push('title: must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.description)) {
    errors.push('description: must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.rationale)) {
    errors.push('rationale: must be a non-empty string');
  }
  if (typeof candidate.confidence !== 'number' || Number.isNaN(candidate.confidence)) {
    errors.push('confidence: must be a number');
  } else if (candidate.confidence < 0 || candidate.confidence > 1) {
    errors.push('confidence: must be between 0 and 1');
  }
  if (candidate.evidenceEventIds !== undefined && !isStringArray(candidate.evidenceEventIds)) {
    errors.push('evidenceEventIds: must be an array of non-empty strings');
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeOpportunityCandidate(candidate) {
  const { valid, errors } = validateOpportunityCandidate(candidate);
  if (!valid) {
    throw new Error(`Invalid opportunity candidate:\n- ${errors.join('\n- ')}`);
  }

  return {
    type: candidate.type.trim(),
    title: candidate.title.trim(),
    description: candidate.description.trim(),
    rationale: candidate.rationale.trim(),
    confidence: candidate.confidence,
    evidenceEventIds: candidate.evidenceEventIds ?? []
  };
}
