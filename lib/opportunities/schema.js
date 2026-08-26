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

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
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
  if (candidate.counterparty === null || typeof candidate.counterparty !== 'object' || Array.isArray(candidate.counterparty)) {
    errors.push('counterparty: must be an object');
  } else {
    const { kind, name, contactHint } = candidate.counterparty;
    if (!['company', 'person', 'none'].includes(kind)) {
      errors.push('counterparty.kind: must be one of "company", "person", or "none"');
    }
    if (!isNullableString(contactHint)) {
      errors.push('counterparty.contactHint: must be null or a non-empty string');
    }
    if (kind === 'none') {
      if (name !== null) {
        errors.push('counterparty.name: must be null when counterparty.kind is "none"');
      }
      if (contactHint !== null) {
        errors.push('counterparty.contactHint: must be null when counterparty.kind is "none"');
      }
    }
    if ((kind === 'company' || kind === 'person') && !isNonEmptyString(name)) {
      errors.push('counterparty.name: must be a non-empty string when counterparty.kind is "company" or "person"');
    }
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
    evidenceEventIds: candidate.evidenceEventIds ?? [],
    counterparty: {
      kind: candidate.counterparty.kind,
      name: candidate.counterparty.name === null ? null : candidate.counterparty.name.trim(),
      contactHint: candidate.counterparty.contactHint === null ? null : candidate.counterparty.contactHint.trim()
    }
  };
}
