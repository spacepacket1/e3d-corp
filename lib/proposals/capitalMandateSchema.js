import crypto from 'node:crypto';

export const CAPITAL_MANDATE_PROPOSAL_TYPE = 'capital_mandate';
export const CAPITAL_MANDATE_VERSION = '1.0';
export const CAPITAL_MANDATE_STATUSES = [
  'proposed',
  'approved',
  'active',
  'completed',
  'expired',
  'revoked',
  'suspended'
];

const CAPITAL_MANDATE_TRANSITIONS = Object.freeze({
  proposed: ['approved'],
  approved: ['active'],
  active: ['completed', 'expired', 'revoked', 'suspended'],
  completed: [],
  expired: [],
  revoked: [],
  suspended: []
});

const RELAXATION_KEY_PATTERN =
  /(^|_|\b)(relax|relaxed|relaxation|loosen|weaken|override|bypass|ignore|disable|waive)(_|$|\b)|increase_.*limit|raise_.*limit|allow_.*risk/i;
const RELAXATION_TEXT_PATTERN = /\b(relax|loosen|weaken|override|bypass|ignore|disable|waive)\b/i;
const RELAXING_OPERATORS = new Set(['>', '>=', 'min', 'increase', 'raise', 'allow', 'relax', 'loosen', 'override']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isObjectOrNonEmptyString(value) {
  return isNonEmptyString(value) || isPlainObject(value);
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function isNullableIsoTimestamp(value) {
  return value === null || isIsoTimestamp(value);
}

function uniqueTrimmedStrings(values) {
  return [...new Set(values.map((value) => value.trim()))];
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deterministicMandateId(payload) {
  const stablePayload = {
    version: payload.version,
    owner: payload.owner,
    thesis_refs: payload.thesis_refs,
    story_refs: payload.story_refs,
    objective: payload.objective,
    constraints: payload.constraints,
    preferences: payload.preferences,
    horizon: payload.horizon,
    confidence: payload.confidence,
    invalidation: payload.invalidation,
    effective_at: payload.effective_at,
    expires_at: payload.expires_at
  };
  return `mandate_${crypto.createHash('sha256').update(canonicalJson(stablePayload)).digest('hex').slice(0, 24)}`;
}

function collectRelaxationSignals(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRelaxationSignals(entry, `${path}[${index}]`, errors));
    return;
  }

  if (!isPlainObject(value)) {
    if (typeof value === 'string' && RELAXATION_TEXT_PATTERN.test(value)) {
      errors.push(`${path}: must not signal relaxing, weakening, overriding, or bypassing risk constraints`);
    }
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (RELAXATION_KEY_PATTERN.test(key)) {
      errors.push(`${nestedPath}: constraints may only tighten and must not use relaxation/override/bypass keys`);
    }
    if (key === 'operator' && typeof nestedValue === 'string' && RELAXING_OPERATORS.has(nestedValue.trim().toLowerCase())) {
      errors.push(`${nestedPath}: operator "${nestedValue}" can signal loosening; use a tightening operator instead`);
    }
    if (key === 'live_execution_allowed' && nestedValue !== false) {
      errors.push(`${nestedPath}: capital mandates cannot enable live execution`);
    }
    if (key === 'paper_only' && nestedValue !== true) {
      errors.push(`${nestedPath}: capital mandates cannot disable paper-only execution`);
    }
    if (key === 'risk_sovereign' && nestedValue !== true) {
      errors.push(`${nestedPath}: capital mandates must preserve risk sovereignty`);
    }
    collectRelaxationSignals(nestedValue, nestedPath, errors);
  }
}

export function validateCapitalMandateTransition(fromStatus, toStatus) {
  if (!CAPITAL_MANDATE_STATUSES.includes(fromStatus)) {
    return { valid: false, errors: [`fromStatus: unknown capital_mandate status "${fromStatus}"`] };
  }
  if (!CAPITAL_MANDATE_STATUSES.includes(toStatus)) {
    return { valid: false, errors: [`toStatus: unknown capital_mandate status "${toStatus}"`] };
  }
  const allowed = CAPITAL_MANDATE_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    return {
      valid: false,
      errors: [`capital_mandate lifecycle cannot transition from "${fromStatus}" to "${toStatus}"`]
    };
  }
  return { valid: true, errors: [] };
}

export function validateCapitalMandatePayload(payload, { requireProposed = false } = {}) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return { valid: false, errors: ['capital_mandate: payload must be an object'] };
  }

  if (!isNonEmptyString(payload.mandate_id)) errors.push('mandate_id: must be a non-empty string');
  if (payload.version !== CAPITAL_MANDATE_VERSION) errors.push(`version: must be ${CAPITAL_MANDATE_VERSION}`);
  if (!isNonEmptyString(payload.owner)) errors.push('owner: must be a non-empty string');
  if (!CAPITAL_MANDATE_STATUSES.includes(payload.status)) {
    errors.push(`status: must be one of ${CAPITAL_MANDATE_STATUSES.join(', ')}`);
  } else if (requireProposed && payload.status !== 'proposed') {
    errors.push('status: new capital_mandate proposals must start as proposed');
  }
  if (!isIsoTimestamp(payload.created_at)) errors.push('created_at: must be an ISO timestamp');
  if (!isNullableIsoTimestamp(payload.approved_at)) errors.push('approved_at: must be null or an ISO timestamp');
  if (!isNullableIsoTimestamp(payload.effective_at)) errors.push('effective_at: must be null or an ISO timestamp');
  if (!isIsoTimestamp(payload.expires_at)) errors.push('expires_at: must be an ISO timestamp');
  if (!isNullableIsoTimestamp(payload.revoked_at)) errors.push('revoked_at: must be null or an ISO timestamp');
  if (!isNonEmptyString(payload.correlation_id)) errors.push('correlation_id: must be a non-empty string');
  if (!isNonEmptyString(payload.proposal_id)) errors.push('proposal_id: must be a non-empty string');
  if (payload.decision_id !== null && !isNonEmptyString(payload.decision_id)) {
    errors.push('decision_id: must be null or a non-empty string');
  }
  if (!Array.isArray(payload.thesis_refs) || !payload.thesis_refs.every(isNonEmptyString)) {
    errors.push('thesis_refs: must be an array of non-empty strings');
  }
  if (!Array.isArray(payload.story_refs) || !payload.story_refs.every(isNonEmptyString)) {
    errors.push('story_refs: must be an array of non-empty strings');
  }
  if (!isObjectOrNonEmptyString(payload.objective)) errors.push('objective: must be a non-empty string or object');
  if (!isPlainObject(payload.constraints)) {
    errors.push('constraints: must be an object');
  } else {
    collectRelaxationSignals(payload.constraints, 'constraints', errors);
  }
  if (!isPlainObject(payload.preferences)) errors.push('preferences: must be an object');
  if (!isObjectOrNonEmptyString(payload.horizon)) errors.push('horizon: must be a non-empty string or object');
  if (typeof payload.confidence !== 'number' || Number.isNaN(payload.confidence)) {
    errors.push('confidence: must be a number');
  } else if (payload.confidence < 0 || payload.confidence > 1) {
    errors.push('confidence: must be between 0 and 1');
  }
  if (!isObjectOrNonEmptyString(payload.invalidation)) {
    errors.push('invalidation: must be a non-empty string or object');
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeCapitalMandatePayload(payload, { proposalId, correlationId, createdAt } = {}) {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid capital_mandate:\n- capital_mandate: payload must be an object');
  }

  const normalized = {
    mandate_id: isNonEmptyString(payload.mandate_id) ? payload.mandate_id.trim() : undefined,
    version: payload.version ?? CAPITAL_MANDATE_VERSION,
    owner: typeof payload.owner === 'string' ? payload.owner.trim() : payload.owner,
    status: payload.status ?? 'proposed',
    created_at: payload.created_at ?? createdAt ?? new Date().toISOString(),
    approved_at: payload.approved_at ?? null,
    effective_at: payload.effective_at ?? null,
    expires_at: payload.expires_at,
    revoked_at: payload.revoked_at ?? null,
    correlation_id: payload.correlation_id ?? correlationId,
    proposal_id: payload.proposal_id ?? proposalId,
    decision_id: payload.decision_id ?? null,
    thesis_refs: Array.isArray(payload.thesis_refs) ? uniqueTrimmedStrings(payload.thesis_refs) : payload.thesis_refs,
    story_refs: Array.isArray(payload.story_refs) ? uniqueTrimmedStrings(payload.story_refs) : payload.story_refs,
    objective: typeof payload.objective === 'string' ? payload.objective.trim() : payload.objective,
    constraints: payload.constraints,
    preferences: payload.preferences ?? {},
    horizon: typeof payload.horizon === 'string' ? payload.horizon.trim() : payload.horizon,
    confidence: payload.confidence,
    invalidation: typeof payload.invalidation === 'string' ? payload.invalidation.trim() : payload.invalidation
  };

  if (!isNonEmptyString(normalized.mandate_id)) {
    normalized.mandate_id = deterministicMandateId(normalized);
  }

  const { valid, errors } = validateCapitalMandatePayload(normalized, { requireProposed: true });
  if (!valid) {
    throw new Error(`Invalid capital_mandate:\n- ${errors.join('\n- ')}`);
  }

  return normalized;
}
