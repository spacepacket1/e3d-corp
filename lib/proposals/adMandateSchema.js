import crypto from 'node:crypto';

// Mirrors lib/proposals/capitalMandateSchema.js's shape exactly (same
// lifecycle, same relaxation-rejection discipline) - see
// docs/futco-ad-mandate-spec.md in e3d-pilot for the full design. Ads have no
// equivalent of e3d-trade sitting behind them to enforce a numeric ceiling,
// so unlike capital_mandate (whose own schema only rejects relaxation
// keywords, leaving the real numeric check to e3d-trade's own
// validateMandateConstraintsAgainstPolicy), this module also owns the
// numeric hard-ceiling check (validateAdMandateConstraintsAgainstPolicy,
// below) - e3d-corp both proposes and enforces this one.
export const AD_MANDATE_PROPOSAL_TYPE = 'ad_mandate';
export const AD_MANDATE_VERSION = '1.0';
export const AD_MANDATE_STATUSES = [
  'proposed',
  'approved',
  'active',
  'completed',
  'expired',
  'revoked',
  'suspended'
];

const AD_MANDATE_TRANSITIONS = Object.freeze({
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isObjectOrNonEmptyString(value) {
  return isNonEmptyString(value) || isPlainObject(value);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNullOrPositiveNumber(value) {
  return value === null || isPositiveNumber(value);
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
    objective: payload.objective,
    constraints: payload.constraints,
    preferences: payload.preferences,
    confidence: payload.confidence,
    invalidation: payload.invalidation,
    effective_at: payload.effective_at,
    expires_at: payload.expires_at
  };
  return `ad-mandate_${crypto.createHash('sha256').update(canonicalJson(stablePayload)).digest('hex').slice(0, 24)}`;
}

// Same keyword/text scan as capitalMandateSchema.js's collectRelaxationSignals
// - deliberately duplicated rather than imported, so a change to one mandate
// type's relaxation rules can never silently loosen the other's.
function collectRelaxationSignals(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRelaxationSignals(entry, `${path}[${index}]`, errors));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string' && RELAXATION_TEXT_PATTERN.test(value)) {
      errors.push(`${path}: must not signal relaxing, weakening, overriding, or bypassing spend constraints`);
    }
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (RELAXATION_KEY_PATTERN.test(key)) {
      errors.push(`${nestedPath}: constraints may only tighten and must not use relaxation/override/bypass keys`);
    }
    if (key === 'paper_only_creative' && nestedValue !== true) {
      errors.push(`${nestedPath}: ad mandates cannot disable paper_only_creative (no autonomous spend/publish in this phase)`);
    }
    collectRelaxationSignals(nestedValue, nestedPath, errors);
  }
}

function validateDegradationRules(rules, errors) {
  if (!Array.isArray(rules)) {
    errors.push('constraints.pause_on_metric_degradation: must be an array');
    return;
  }
  rules.forEach((rule, index) => {
    const prefix = `constraints.pause_on_metric_degradation[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    if (!isNonEmptyString(rule.metric)) errors.push(`${prefix}.metric: must be a non-empty string`);
    if (!Number.isInteger(rule.window_days) || rule.window_days < 1) {
      errors.push(`${prefix}.window_days: must be a positive integer`);
    }
    if (typeof rule.degradation_pct !== 'number' || rule.degradation_pct <= 0 || rule.degradation_pct > 1) {
      errors.push(`${prefix}.degradation_pct: must be a number between 0 (exclusive) and 1 (inclusive)`);
    }
  });
}

function validateAdMandateConstraints(constraints, errors) {
  if (!isPlainObject(constraints)) {
    errors.push('constraints: must be an object');
    return;
  }
  if (!isPositiveNumber(constraints.max_daily_spend_usd)) {
    errors.push('constraints.max_daily_spend_usd: must be a positive number');
  }
  if (!isPositiveNumber(constraints.max_monthly_spend_usd)) {
    errors.push('constraints.max_monthly_spend_usd: must be a positive number');
  }
  if (!isNullOrPositiveNumber(constraints.max_cpl_usd ?? null)) {
    errors.push('constraints.max_cpl_usd: must be null or a positive number');
  }
  if (!isNullOrPositiveNumber(constraints.max_cac_usd ?? null)) {
    errors.push('constraints.max_cac_usd: must be null or a positive number');
  }
  if (!Array.isArray(constraints.allowed_products) || constraints.allowed_products.length === 0 || !constraints.allowed_products.every(isNonEmptyString)) {
    errors.push('constraints.allowed_products: must be a non-empty array of non-empty strings');
  }
  if (constraints.allowed_campaign_ids !== null && !(Array.isArray(constraints.allowed_campaign_ids) && constraints.allowed_campaign_ids.every(isNonEmptyString))) {
    errors.push('constraints.allowed_campaign_ids: must be null or an array of non-empty strings');
  }
  validateDegradationRules(constraints.pause_on_metric_degradation ?? [], errors);
  if (constraints.paper_only_creative !== true) {
    errors.push('constraints.paper_only_creative: must be true (no autonomous spend/publish in this phase)');
  }
  collectRelaxationSignals(constraints, 'constraints', errors);
}

const TERMINAL_OR_INACTIVE_AD_MANDATE_STATUSES = new Set(['completed', 'expired', 'revoked', 'suspended']);

// Mirrors e3d-trade's scripts/capitalMandates.js::currentMandateStatus -
// deliberately duplicated, not imported (same reasoning as
// collectRelaxationSignals above). A mandate's lifecycle field only moves
// forward via explicit events, but expiry is a function of wall-clock time,
// not an event - so callers that need to know whether a mandate can still
// autonomously decide anything (docs/futco-ad-mandate-spec.md Phase 2) must
// derive the *live* status every time, never trust a cached `status` field.
export function currentAdMandateStatus(mandate, now = new Date()) {
  if (!mandate || !AD_MANDATE_STATUSES.includes(mandate.status)) return null;
  if (TERMINAL_OR_INACTIVE_AD_MANDATE_STATUSES.has(mandate.status)) return mandate.status;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const effectiveMs = mandate.effective_at ? new Date(mandate.effective_at).getTime() : null;
  const expiresMs = mandate.expires_at ? new Date(mandate.expires_at).getTime() : null;
  if (Number.isFinite(expiresMs) && Number.isFinite(nowMs) && nowMs >= expiresMs) return 'expired';
  if (mandate.status === 'active' && Number.isFinite(effectiveMs) && Number.isFinite(nowMs) && nowMs < effectiveMs) return 'approved';
  return mandate.status;
}

export function validateAdMandateTransition(fromStatus, toStatus) {
  if (!AD_MANDATE_STATUSES.includes(fromStatus)) {
    return { valid: false, errors: [`fromStatus: unknown ad_mandate status "${fromStatus}"`] };
  }
  if (!AD_MANDATE_STATUSES.includes(toStatus)) {
    return { valid: false, errors: [`toStatus: unknown ad_mandate status "${toStatus}"`] };
  }
  const allowed = AD_MANDATE_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    return { valid: false, errors: [`ad_mandate lifecycle cannot transition from "${fromStatus}" to "${toStatus}"`] };
  }
  return { valid: true, errors: [] };
}

export function validateAdMandatePayload(payload, { requireProposed = false } = {}) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return { valid: false, errors: ['ad_mandate: payload must be an object'] };
  }

  if (!isNonEmptyString(payload.mandate_id)) errors.push('mandate_id: must be a non-empty string');
  if (payload.version !== AD_MANDATE_VERSION) errors.push(`version: must be ${AD_MANDATE_VERSION}`);
  if (!isNonEmptyString(payload.owner)) errors.push('owner: must be a non-empty string');
  if (!AD_MANDATE_STATUSES.includes(payload.status)) {
    errors.push(`status: must be one of ${AD_MANDATE_STATUSES.join(', ')}`);
  } else if (requireProposed && payload.status !== 'proposed') {
    errors.push('status: new ad_mandate proposals must start as proposed');
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
  if (!isObjectOrNonEmptyString(payload.objective)) errors.push('objective: must be a non-empty string or object');
  validateAdMandateConstraints(payload.constraints, errors);
  if (!isPlainObject(payload.preferences)) errors.push('preferences: must be an object');
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

// The hard-ceiling check docs/futco-ad-mandate-spec.md describes: adRiskPolicy
// is a human-set business decision (real ad-budget numbers), never a
// fabricated default baked into this code - callers must source it from
// instance config and this function fails closed when it's missing or
// malformed, rather than silently skipping the check.
export function validateAdMandateConstraintsAgainstPolicy(constraints, adRiskPolicy) {
  const errors = [];

  if (!isPlainObject(adRiskPolicy) || !isPositiveNumber(adRiskPolicy.max_daily_spend_usd) || !isPositiveNumber(adRiskPolicy.max_monthly_spend_usd)) {
    return {
      valid: false,
      errors: ['adRiskPolicy: missing or invalid - refusing to validate a mandate against no hard ceiling (set instanceConfig.adRiskPolicy)']
    };
  }
  if (!isPlainObject(constraints)) {
    return { valid: false, errors: ['constraints: must be an object'] };
  }

  if (typeof constraints.max_daily_spend_usd === 'number' && constraints.max_daily_spend_usd > adRiskPolicy.max_daily_spend_usd) {
    errors.push(`constraints.max_daily_spend_usd (${constraints.max_daily_spend_usd}) exceeds the hard ceiling (${adRiskPolicy.max_daily_spend_usd})`);
  }
  if (typeof constraints.max_monthly_spend_usd === 'number' && constraints.max_monthly_spend_usd > adRiskPolicy.max_monthly_spend_usd) {
    errors.push(`constraints.max_monthly_spend_usd (${constraints.max_monthly_spend_usd}) exceeds the hard ceiling (${adRiskPolicy.max_monthly_spend_usd})`);
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeAdMandatePayload(payload, { proposalId, correlationId, createdAt } = {}) {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid ad_mandate:\n- ad_mandate: payload must be an object');
  }

  const normalized = {
    mandate_id: isNonEmptyString(payload.mandate_id) ? payload.mandate_id.trim() : undefined,
    version: payload.version ?? AD_MANDATE_VERSION,
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
    objective: typeof payload.objective === 'string' ? payload.objective.trim() : payload.objective,
    constraints: payload.constraints,
    preferences: payload.preferences ?? {},
    confidence: payload.confidence,
    invalidation: typeof payload.invalidation === 'string' ? payload.invalidation.trim() : payload.invalidation
  };

  if (!isNonEmptyString(normalized.mandate_id)) {
    normalized.mandate_id = deterministicMandateId(normalized);
  }

  const { valid, errors } = validateAdMandatePayload(normalized, { requireProposed: true });
  if (!valid) {
    throw new Error(`Invalid ad_mandate:\n- ${errors.join('\n- ')}`);
  }

  return normalized;
}
