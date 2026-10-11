import { reconstructChain } from '../events/chain.js';
import { appendEvent } from '../events/store.js';
import { resolveProvider } from '../llm/registry.js';

const ROLE_NAME = 'creative.brief';

// The internal LLM-output contract is richer than e3d-creative's own brief
// schema (lib/schema.js's validateBriefInput in the e3d-creative repo) on
// purpose: rationale/evidenceEventIds are this role's own grounding
// discipline, mirroring lib/roles/riskAssess.js's evidenceEventIds
// mechanism, and are stripped out (toE3dCreativeBrief) before the brief ever
// reaches e3d-creative, which would otherwise see unexpected extra fields.
const BRIEF_DRAFT_KEYS = [
  'product',
  'audience',
  'objective',
  'constraints',
  'spendCeiling',
  'metric',
  'threshold',
  'rationale',
  'evidenceEventIds'
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stripMarkdownFence(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function truncate(text, maxLength) {
  if (typeof text !== 'string') return text;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function buildSystemPrompt(companyName) {
  return [
    `You are the ${ROLE_NAME} role inside e3d-corp, drafting a creative brief for ${companyName}'s ad-creative ` +
      'engine (e3d-creative) from one "pursuing" Opportunity and its full causal chain of evidence.',
    'You never produce ad copy, scripts, or storyboards yourself - only the brief that e3d-creative will use as its own input.',
    'Ground every claim in the evidence supplied below. Never invent an audience, metric, or performance figure that the evidence does not support.',
    'Respond with ONLY a single JSON object - no prose, no markdown code fences - matching exactly this shape:',
    '{"product":string,"audience":string,"objective":string,"constraints":string[],"spendCeiling":number|null,"metric":string,"threshold":string,"rationale":string,"evidenceEventIds":string[]}',
    '"constraints" is a flat list of concrete limits or requirements (e.g. "no testimonials", "30 seconds or under") - an empty array is fine if the evidence suggests none.',
    '"spendCeiling" is a dollar ceiling for the ad spend this creative will be tested against, taken only from evidence that states one; use null if the evidence gives no spend figure.',
    '"metric" and "threshold" name the specific signal and target that will decide if this creative direction worked (e.g. metric "cost per landing page view", threshold "below $4.50") - always grounded in the evidence, never invented.',
    '"rationale" briefly explains why this brief addresses the diagnosed problem.',
    '"evidenceEventIds" must be non-empty and list every event id the brief\'s claims actually came from - it must only contain ids from the allowed list given to you below.',
    'If the evidence does not support a confident audience, metric, or objective, write a narrower, more modest brief rather than inventing detail.',
    'Never respond with free text instead of JSON, in any case.'
  ].join('\n');
}

function summarizeChainEvent(event) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: truncate(JSON.stringify(event.payload), 1200)
  };
}

export function buildPrompt({ opportunity, chain, instanceConfig }) {
  const allowedEvidenceEventIds = chain.map((event) => event.id);
  const userPrompt = JSON.stringify(
    {
      opportunity: {
        id: opportunity.id,
        type: opportunity.type,
        title: opportunity.title,
        description: opportunity.description,
        score: opportunity.score
      },
      causalChain: chain.map(summarizeChainEvent),
      allowedEvidenceEventIds
    },
    null,
    2
  );

  return {
    systemPrompt: buildSystemPrompt(instanceConfig?.name || 'the company'),
    userPrompt,
    allowedEvidenceEventIds
  };
}

export function parseBriefDraftJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error(`${ROLE_NAME} returned empty output`);
  }

  const stripped = stripMarkdownFence(rawText);
  if (stripped === '') {
    throw new Error(`${ROLE_NAME} returned empty output`);
  }

  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw new Error(`${ROLE_NAME} returned invalid JSON: ${error.message}`);
  }
}

function normalizeAllowedEvidenceIds(allowedEvidenceIds) {
  const normalized = new Set();
  for (const value of allowedEvidenceIds) {
    if (typeof value === 'string' && value.trim() !== '') {
      normalized.add(value.trim());
    }
  }
  return normalized;
}

// Fails closed exactly the way lib/roles/riskAssess.js's normalizeAssessment
// does for evidenceEventIds (membership in the allowed list), plus one
// addition specific to a brief: evidenceEventIds must be non-empty. A risk
// assessment can legitimately cite zero extra evidence beyond the request
// itself; a creative brief drafted from zero grounding evidence is exactly
// the failure mode this role exists to prevent.
export function normalizeBriefDraft(parsed, allowedEvidenceIds) {
  if (!isPlainObject(parsed)) {
    throw new Error(`${ROLE_NAME} draft must be a plain object`);
  }

  const keys = Object.keys(parsed);
  const missingKeys = BRIEF_DRAFT_KEYS.filter((key) => !Object.hasOwn(parsed, key));
  const extraKeys = keys.filter((key) => !BRIEF_DRAFT_KEYS.includes(key));
  if (missingKeys.length > 0 || extraKeys.length > 0 || keys.length !== BRIEF_DRAFT_KEYS.length) {
    throw new Error(`${ROLE_NAME} draft must contain exactly these keys: ${BRIEF_DRAFT_KEYS.join(', ')}`);
  }

  for (const field of ['product', 'audience', 'objective', 'metric', 'threshold', 'rationale']) {
    if (!isNonEmptyString(parsed[field])) {
      throw new Error(`${ROLE_NAME} draft "${field}" must be a non-empty string`);
    }
  }

  if (!Array.isArray(parsed.constraints)) {
    throw new Error(`${ROLE_NAME} draft "constraints" must be an array of non-empty strings`);
  }
  const constraints = parsed.constraints.map((constraint) => {
    if (typeof constraint !== 'string' || constraint.trim() === '') {
      throw new Error(`${ROLE_NAME} draft "constraints" must be an array of non-empty strings`);
    }
    return constraint.trim();
  });

  let spendCeiling = null;
  if (parsed.spendCeiling !== null) {
    if (typeof parsed.spendCeiling !== 'number' || !Number.isFinite(parsed.spendCeiling) || parsed.spendCeiling < 0) {
      throw new Error(`${ROLE_NAME} draft "spendCeiling" must be null or a finite number >= 0`);
    }
    spendCeiling = parsed.spendCeiling;
  }

  if (!Array.isArray(parsed.evidenceEventIds) || parsed.evidenceEventIds.length === 0) {
    throw new Error(`${ROLE_NAME} draft "evidenceEventIds" must be a non-empty array - a brief must be grounded in at least one real event`);
  }
  const allowedSet = normalizeAllowedEvidenceIds(allowedEvidenceIds);
  const seenEvidenceIds = new Set();
  const evidenceEventIds = parsed.evidenceEventIds.map((id) => {
    if (typeof id !== 'string') {
      throw new Error(`${ROLE_NAME} draft "evidenceEventIds" must contain only strings`);
    }
    const trimmed = id.trim();
    if (trimmed === '') {
      throw new Error(`${ROLE_NAME} draft "evidenceEventIds" must not contain blank ids`);
    }
    if (seenEvidenceIds.has(trimmed)) {
      throw new Error(`${ROLE_NAME} draft "evidenceEventIds" must not contain duplicates`);
    }
    if (!allowedSet.has(trimmed)) {
      throw new Error(`${ROLE_NAME} draft "evidenceEventIds" must only cite supplied event ids`);
    }
    seenEvidenceIds.add(trimmed);
    return trimmed;
  });

  return {
    product: parsed.product.trim(),
    audience: parsed.audience.trim(),
    objective: parsed.objective.trim(),
    constraints,
    spendCeiling,
    metric: parsed.metric.trim(),
    threshold: parsed.threshold.trim(),
    rationale: parsed.rationale.trim(),
    evidenceEventIds
  };
}

// Reduces a normalized draft down to exactly the 8 fields e3d-creative's own
// validateBriefInput (../e3d-creative/lib/schema.js) requires - the source
// of truth for this shape lives in that repo, not here; keep the two in sync
// by hand if it ever changes. baselineRef is always null: this role only
// ever drafts a brief for a brand-new commission, never one that points back
// at prior creative output.
export function toE3dCreativeBrief(draft) {
  return {
    product: draft.product,
    audience: draft.audience,
    objective: draft.objective,
    baselineRef: null,
    constraints: draft.constraints,
    spendCeiling: draft.spendCeiling,
    metric: draft.metric,
    threshold: draft.threshold
  };
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) {
    return providerConfig.trim();
  }
  if (Array.isArray(providerConfig)) {
    const [first] = providerConfig;
    if (isNonEmptyString(first)) {
      return first.trim();
    }
  }
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

function latestEventForOpportunity(chain, opportunityId) {
  const related = chain.filter((event) => event.subject?.type === 'opportunity' && event.subject.id === opportunityId);
  return related[related.length - 1] ?? chain[chain.length - 1] ?? null;
}

// Authority level 0/1 only: this appends a plain record of a drafted brief,
// never a Proposal (createProposal itself refuses anything below authority
// level 2 - lib/proposals/create.js) and never commissions e3d-creative.
// Turning a drafted brief into a real commission-creative Proposal is a
// separate, deliberate step done elsewhere.
export async function runCreativeBrief({ instanceConfig, dataDir, opportunity, llmClient } = {}) {
  if (!opportunity || !opportunity.id || !opportunity.correlationId) {
    throw new Error(`${ROLE_NAME} requires an opportunity with an id and correlationId`);
  }
  if (opportunity.status !== 'pursuing') {
    throw new Error(
      `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status}); refusing to draft a creative brief`
    );
  }
  if (!dataDir) {
    throw new Error(`${ROLE_NAME} requires a dataDir`);
  }

  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }

  const chain = reconstructChain(dataDir, opportunity.correlationId);
  if (chain.length === 0) {
    throw new Error(`Cannot draft a creative brief for opportunity ${opportunity.id}: no evidence chain found for its correlationId`);
  }

  const causationEvent = latestEventForOpportunity(chain, opportunity.id);
  const { systemPrompt, userPrompt, allowedEvidenceEventIds } = buildPrompt({ opportunity, chain, instanceConfig });

  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const draft = normalizeBriefDraft(parseBriefDraftJson(response?.text), allowedEvidenceEventIds);
  const brief = toE3dCreativeBrief(draft);

  const event = appendEvent(dataDir, {
    type: 'creative-brief.drafted',
    source: `role:${ROLE_NAME}`,
    subject: { type: 'opportunity', id: opportunity.id },
    payload: {
      opportunityId: opportunity.id,
      opportunityTitle: opportunity.title,
      brief,
      rationale: draft.rationale,
      evidenceEventIds: draft.evidenceEventIds,
      role: ROLE_NAME,
      provider,
      model
    },
    causationId: causationEvent ? causationEvent.id : null,
    correlationId: opportunity.correlationId
  });

  return { brief, rationale: draft.rationale, evidenceEventIds: draft.evidenceEventIds, event };
}
