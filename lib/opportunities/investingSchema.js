export const INVESTING_OPPORTUNITY_TYPE_EXAMPLES = [
  'long-idea',
  'short-idea',
  'watchlist',
  'hedge',
  'rotation',
  'risk-reduction',
  'capital-allocation-review',
  'other'
];

export const INVESTING_VIEWS = ['bullish', 'bearish', 'neutral'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

export function validateInvestingOpportunityCandidate(candidate) {
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
  if (!isNonEmptyString(candidate.invalidationCondition)) {
    errors.push('invalidationCondition: must be a non-empty string');
  }
  if (!isNonEmptyString(candidate.view)) {
    errors.push('view: must be a non-empty string');
  } else if (!INVESTING_VIEWS.includes(candidate.view.trim().toLowerCase())) {
    errors.push(`view: must be one of ${INVESTING_VIEWS.map((value) => `"${value}"`).join(', ')}`);
  }
  if (typeof candidate.confidence !== 'number' || Number.isNaN(candidate.confidence)) {
    errors.push('confidence: must be a number');
  } else if (candidate.confidence < 0 || candidate.confidence > 1) {
    errors.push('confidence: must be between 0 and 1');
  }
  if (candidate.evidenceEventIds !== undefined && !isStringArray(candidate.evidenceEventIds)) {
    errors.push('evidenceEventIds: must be an array of non-empty strings');
  }
  if (candidate.thesisRefs !== undefined && !isStringArray(candidate.thesisRefs)) {
    errors.push('thesisRefs: must be an array of non-empty strings');
  }
  if (candidate.storyRefs !== undefined && !isStringArray(candidate.storyRefs)) {
    errors.push('storyRefs: must be an array of non-empty strings');
  }

  return { valid: errors.length === 0, errors };
}

function uniqueTrimmedStrings(values = []) {
  return [...new Set(values.map((value) => value.trim()))];
}

export function normalizeInvestingOpportunityCandidate(candidate) {
  const { valid, errors } = validateInvestingOpportunityCandidate(candidate);
  if (!valid) {
    throw new Error(`Invalid investing opportunity candidate:\n- ${errors.join('\n- ')}`);
  }

  return {
    type: candidate.type.trim(),
    title: candidate.title.trim(),
    description: candidate.description.trim(),
    rationale: candidate.rationale.trim(),
    invalidationCondition: candidate.invalidationCondition.trim(),
    view: candidate.view.trim().toLowerCase(),
    confidence: candidate.confidence,
    evidenceEventIds: uniqueTrimmedStrings(candidate.evidenceEventIds ?? []),
    thesisRefs: uniqueTrimmedStrings(candidate.thesisRefs ?? []),
    storyRefs: uniqueTrimmedStrings(candidate.storyRefs ?? [])
  };
}
