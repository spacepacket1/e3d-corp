import { appendEvent, queryEvents } from '../events/store.js';
import { reserveBudget, settleReservation } from '../llm/budget.js';
import { resolveProvider } from '../llm/registry.js';
import {
  normalizeInvestingOpportunityCandidate,
  INVESTING_OPPORTUNITY_TYPE_EXAMPLES
} from '../opportunities/investingSchema.js';

const ROLE_NAME = 'opportunity.investing';

function buildSystemPrompt(companyName) {
  return [
    `You are the ${ROLE_NAME} role inside e3d-corp, a system that helps ${companyName} form evidence-backed investment views.`,
    'You are given one triggering event, structured E3D thesis/story evidence, and a current market-state snapshot.',
    'Respond with ONLY a single JSON object — no prose, no markdown code fences — matching exactly this shape:',
    '{"type": string, "title": string, "description": string, "view": "bullish"|"bearish"|"neutral", ' +
      '"confidence": number, "rationale": string, "invalidationCondition": string, ' +
      '"thesisRefs": string[], "storyRefs": string[], "evidenceEventIds": string[], ' +
      '"wantsSecondOpinion"?: boolean, "secondOpinionReason"?: string}',
    `"type" should be a short kebab-case string. Common examples: ${INVESTING_OPPORTUNITY_TYPE_EXAMPLES.join(', ')}.`,
    '"view" is the directional investment stance implied by the evidence and market state.',
    '"confidence" is your own confidence in that investment view, from 0 to 1.',
    '"invalidationCondition" must name the concrete condition that would make this view no longer worth acting on.',
    '"thesisRefs" must only contain thesis ids from the E3D theses list below. "storyRefs" must only contain story ids from the E3D stories list below.',
    '"evidenceEventIds" must only contain ids taken from the evidence list you were given below — never invent one.',
    'If the evidence is mixed or weak, prefer "neutral" plus low confidence over forcing a tradeable view.',
    'Never invent a thesis, a story, a market datapoint, or a reference id that is not present in the provided inputs.',
    'Set "wantsSecondOpinion" to true only when another provider perspective would materially help; when you do, include "secondOpinionReason".',
    'Never respond with free text instead of JSON, in any case.'
  ].join('\n');
}

function truncate(text, maxLength) {
  if (typeof text !== 'string') return text;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

function pickRefId(item) {
  return pickString(item?.id, item?.thesisId, item?.storyId, item?.refId, item?.slug);
}

function normalizeEvidenceItem(item, fallbackKind = 'market') {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const refId = pickRefId(item);
  return {
    id: refId,
    kind: pickString(item.kind, item.type, item.objectType, item.entityType, fallbackKind) ?? fallbackKind,
    title: pickString(item.title, item.name, item.headline, item.symbol) ?? 'Untitled evidence',
    summary: truncate(pickString(item.summary, item.snippet, item.description, item.content, item.note) ?? '', 400),
    market: pickString(item.market, item.chain, item.exchange),
    asset: pickString(item.asset, item.token, item.symbol)
  };
}

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function classifyEvidenceItem(item, fallbackKind = 'market') {
  const normalized = normalizeEvidenceItem(item, fallbackKind);
  if (!normalized) {
    return null;
  }

  const classification = lower(normalized.kind);
  if (classification.includes('thesis')) {
    return { bucket: 'theses', item: normalized };
  }
  if (classification.includes('story')) {
    return { bucket: 'stories', item: normalized };
  }
  return { bucket: 'marketEvidence', item: normalized };
}

function collectClassifiedItems(result, explicitBucket, items) {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    const classified =
      explicitBucket === 'marketEvidence'
        ? { bucket: explicitBucket, item: normalizeEvidenceItem(item, 'market') }
        : classifyEvidenceItem(item, explicitBucket === 'theses' ? 'thesis' : 'story');
    if (classified?.item) {
      result[classified.bucket].push(classified.item);
    }
  }
}

function summarizeEvidenceCatalog(evidenceEvents) {
  const catalog = {
    theses: [],
    stories: [],
    marketEvidence: [],
    evidenceEvents: []
  };

  for (const event of evidenceEvents) {
    catalog.evidenceEvents.push({
      id: event.id,
      occurredAt: event.occurredAt,
      kind: event.payload?.kind,
      query: event.payload?.query,
      resultSummary: event.payload?.resultSummary,
      degraded: event.payload?.degraded ?? false
    });

    const result = event.payload?.result;
    collectClassifiedItems(catalog, 'theses', result?.theses);
    collectClassifiedItems(catalog, 'stories', result?.stories);
    collectClassifiedItems(catalog, 'marketEvidence', result?.marketState);
    collectClassifiedItems(catalog, 'marketEvidence', result?.results);
    collectClassifiedItems(catalog, 'marketEvidence', result?.items);
  }

  return catalog;
}

function buildPromptPayload({ triggerEvent, evidenceEvents, instanceConfig, marketState }) {
  const catalog = summarizeEvidenceCatalog(evidenceEvents);
  return {
    triggerEvent: {
      id: triggerEvent.id,
      type: triggerEvent.type,
      occurredAt: triggerEvent.occurredAt,
      source: triggerEvent.source,
      payload: triggerEvent.payload
    },
    marketState,
    evidence: catalog
  };
}

export function buildPrompt({ triggerEvent, evidenceEvents, instanceConfig, marketState }) {
  const userPrompt = JSON.stringify(
    buildPromptPayload({ triggerEvent, evidenceEvents, instanceConfig, marketState }),
    null,
    2
  );

  return { systemPrompt: buildSystemPrompt(instanceConfig?.name || 'the company'), userPrompt };
}

function stripMarkdownFence(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseCandidateJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error(`${ROLE_NAME} returned empty output`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFence(rawText));
  } catch (error) {
    throw new Error(`${ROLE_NAME} returned invalid JSON: ${error.message}`);
  }

  return parsed;
}

function deriveResearchQuery(triggerEvent) {
  const payload = triggerEvent.payload ?? {};
  return (
    payload.marketTopic ||
    payload.marketState?.focus ||
    payload.topic ||
    payload.note ||
    payload.title ||
    triggerEvent.subject?.id ||
    triggerEvent.type
  );
}

function normalizeProviderNames(providerConfig) {
  if (typeof providerConfig === 'string' && providerConfig.trim() !== '') {
    return [providerConfig.trim()];
  }
  if (Array.isArray(providerConfig)) {
    const names = providerConfig
      .filter((name) => typeof name === 'string' && name.trim() !== '')
      .map((name) => name.trim());
    if (names.length > 0) {
      return names;
    }
  }

  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

function resolveProviderCall({ instanceConfig, providerName, providerCount, llmClient }) {
  const provider = providerName;
  if (!llmClient) {
    const resolved = resolveProvider(instanceConfig, provider);
    return { provider, model: resolved.model, call: resolved.call };
  }

  if (typeof llmClient === 'function') {
    if (providerCount !== 1) {
      throw new Error('runInvestingOpportunityScorer received a single llmClient function for a multi-provider role');
    }
    const { model } = resolveProvider(instanceConfig, provider);
    return { provider, model, call: llmClient };
  }

  if (llmClient && typeof llmClient === 'object') {
    const call = llmClient[provider];
    if (typeof call !== 'function') {
      throw new Error(`runInvestingOpportunityScorer is missing an llmClient stub for provider "${provider}"`);
    }
    const { model } = resolveProvider(instanceConfig, provider);
    return { provider, model, call };
  }

  throw new Error('runInvestingOpportunityScorer requires llmClient to be a function or provider map when provided');
}

async function recordProviderCompletion({
  dataDir,
  triggerEvent,
  provider,
  model,
  usage,
  costUsd,
  latencyMs,
  reservationId = null
}) {
  const event = {
    type: 'role.provider.completed',
    source: `role:${ROLE_NAME}`,
    subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider, model, usage, costUsd, latencyMs, reservationId },
    causationId: triggerEvent.id,
    correlationId: triggerEvent.correlationId
  };

  if (reservationId) {
    return settleReservation(dataDir, event);
  }

  return appendEvent(dataDir, event);
}

async function recordProviderFailure({
  dataDir,
  triggerEvent,
  provider,
  model,
  usage,
  costUsd,
  latencyMs,
  reason,
  reservationId = null,
  settle = false
}) {
  const event = {
    type: 'role.provider.failed',
    source: `role:${ROLE_NAME}`,
    subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider, model, usage, costUsd, latencyMs, reason, reservationId },
    causationId: triggerEvent.id,
    correlationId: triggerEvent.correlationId
  };

  if (settle && reservationId) {
    return settleReservation(dataDir, event);
  }

  return appendEvent(dataDir, event);
}

function recordProviderSkipped({ dataDir, triggerEvent, provider, reason }) {
  appendEvent(dataDir, {
    type: 'role.provider.skipped',
    source: `role:${ROLE_NAME}`,
    subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider, reason },
    causationId: triggerEvent.id,
    correlationId: triggerEvent.correlationId
  });
}

function enrichProviderError(error, { usage, costUsd, latencyMs }) {
  const enriched = error instanceof Error ? error : new Error(String(error));
  enriched.usage = usage ?? null;
  enriched.costUsd = costUsd ?? null;
  enriched.latencyMs = latencyMs ?? null;
  return enriched;
}

function collectAllowedReferenceIds(evidenceEvents) {
  const promptPayload = buildPromptPayload({
    triggerEvent: { id: 'unused', type: 'unused', occurredAt: null, source: 'unused', payload: {} },
    evidenceEvents,
    instanceConfig: null,
    marketState: null
  });
  return {
    evidenceEventIds: new Set(promptPayload.evidence.evidenceEvents.map((event) => event.id)),
    thesisRefs: new Set(promptPayload.evidence.theses.map((item) => item.id).filter(Boolean)),
    storyRefs: new Set(promptPayload.evidence.stories.map((item) => item.id).filter(Boolean))
  };
}

function assertKnownRefs(values, allowed, fieldName) {
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`${fieldName} contains unknown reference "${value}"`);
    }
  }
}

function assertCandidateReferences(candidate, allowedRefs) {
  assertKnownRefs(candidate.evidenceEventIds, allowedRefs.evidenceEventIds, 'evidenceEventIds');
  assertKnownRefs(candidate.thesisRefs, allowedRefs.thesisRefs, 'thesisRefs');
  assertKnownRefs(candidate.storyRefs, allowedRefs.storyRefs, 'storyRefs');
}

async function executeProviderAttempt({
  instanceConfig,
  dataDir,
  triggerEvent,
  providerName,
  providerCount,
  llmClient,
  systemPrompt,
  userPrompt,
  sourceEventIds,
  allowedRefs,
  reservationId = null
}) {
  let resolved;
  try {
    resolved = resolveProviderCall({ instanceConfig, providerName, providerCount, llmClient });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordProviderFailure({
      dataDir,
      triggerEvent,
      provider: providerName,
      model: null,
      usage: null,
      costUsd: null,
      latencyMs: null,
      reason,
      reservationId,
      settle: Boolean(reservationId)
    });
    return { ok: false, error: error instanceof Error ? error : new Error(reason) };
  }

  const { provider, model, call } = resolved;
  const startedAt = Date.now();
  let response;
  try {
    response = await call({ systemPrompt, userPrompt });
  } catch (error) {
    const enriched = enrichProviderError(error, {
      usage: error?.usage ?? null,
      costUsd: error?.costUsd ?? null,
      latencyMs: Date.now() - startedAt
    });
    await recordProviderFailure({
      dataDir,
      triggerEvent,
      provider,
      model,
      usage: enriched.usage,
      costUsd: enriched.costUsd,
      latencyMs: enriched.latencyMs,
      reason: enriched.message,
      reservationId,
      settle: Boolean(reservationId)
    });
    return { ok: false, error: enriched };
  }

  const { text, usage, costUsd } = response;
  const latencyMs = Date.now() - startedAt;
  await recordProviderCompletion({ dataDir, triggerEvent, provider, model, usage, costUsd, latencyMs, reservationId });

  let parsed;
  try {
    parsed = parseCandidateJson(text);
  } catch (error) {
    const enriched = enrichProviderError(error, { usage, costUsd, latencyMs });
    await recordProviderFailure({
      dataDir,
      triggerEvent,
      provider,
      model,
      usage,
      costUsd,
      latencyMs,
      reason: enriched.message,
      reservationId
    });
    return { ok: false, error: enriched };
  }

  const wantsSecondOpinion = parsed.wantsSecondOpinion === true;
  const secondOpinionReason =
    typeof parsed.secondOpinionReason === 'string' && parsed.secondOpinionReason.trim() !== ''
      ? parsed.secondOpinionReason.trim()
      : null;

  let candidate;
  try {
    candidate = normalizeInvestingOpportunityCandidate(parsed);
    assertCandidateReferences(candidate, allowedRefs);
  } catch (error) {
    const enriched = enrichProviderError(error, { usage, costUsd, latencyMs });
    await recordProviderFailure({
      dataDir,
      triggerEvent,
      provider,
      model,
      usage,
      costUsd,
      latencyMs,
      reason: enriched.message,
      reservationId
    });
    return { ok: false, error: enriched };
  }

  return {
    ok: true,
    candidate: {
      ...candidate,
      sourceEventIds,
      correlationId: triggerEvent.correlationId,
      proposedBy: { role: ROLE_NAME, provider, model }
    },
    provider,
    wantsSecondOpinion,
    secondOpinionReason
  };
}

export async function runInvestingOpportunityScorer({
  instanceConfig,
  dataDir,
  triggerEvent,
  researchAdapter,
  researchQuery,
  marketState,
  llmClient
} = {}) {
  if (!triggerEvent || !triggerEvent.id || !triggerEvent.correlationId) {
    throw new Error('runInvestingOpportunityScorer requires a triggerEvent with an id and correlationId');
  }
  if (!dataDir) {
    throw new Error('runInvestingOpportunityScorer requires a dataDir');
  }

  let evidenceEvents = queryEvents(dataDir, {
    type: 'evidence.gathered',
    correlationId: triggerEvent.correlationId
  });

  if (researchAdapter && evidenceEvents.length === 0) {
    const query = researchQuery ?? deriveResearchQuery(triggerEvent);
    if (query) {
      await researchAdapter.searchKnowledgeBase(query, {
        causationId: triggerEvent.id,
        correlationId: triggerEvent.correlationId
      });
      evidenceEvents = queryEvents(dataDir, {
        type: 'evidence.gathered',
        correlationId: triggerEvent.correlationId
      });
    }
  }

  const providerNames = normalizeProviderNames(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const resolvedMarketState = marketState ?? triggerEvent.payload?.marketState ?? null;
  const { systemPrompt, userPrompt } = buildPrompt({
    triggerEvent,
    evidenceEvents,
    instanceConfig,
    marketState: resolvedMarketState
  });
  const sourceEventIds = [triggerEvent.id, ...evidenceEvents.map((event) => event.id)];
  const allowedRefs = collectAllowedReferenceIds(evidenceEvents);
  const failures = [];
  const candidates = [];
  let bossResult = null;
  let bossSucceeded = false;

  for (const providerName of providerNames) {
    const result = await executeProviderAttempt({
      instanceConfig,
      dataDir,
      triggerEvent,
      providerName,
      providerCount: providerNames.length,
      llmClient,
      systemPrompt,
      userPrompt,
      sourceEventIds,
      allowedRefs
    });

    if (result.ok) {
      candidates.push(result.candidate);
      bossResult = result;
      bossSucceeded = true;
      break;
    }

    failures.push(result.error);
  }

  if (bossSucceeded && bossResult?.wantsSecondOpinion && providerNames.length > 1) {
    const electiveProvider = providerNames[1];
    if (electiveProvider !== bossResult.provider) {
      const reservation = await reserveBudget(dataDir, instanceConfig, electiveProvider, {
        source: `role:${ROLE_NAME}`,
        subject: { type: 'role', id: ROLE_NAME },
        role: ROLE_NAME,
        provider: electiveProvider,
        causationId: triggerEvent.id,
        correlationId: triggerEvent.correlationId
      });

      if (!reservation.granted) {
        recordProviderSkipped({ dataDir, triggerEvent, provider: electiveProvider, reason: 'budget exhausted' });
      } else {
        const electiveResult = await executeProviderAttempt({
          instanceConfig,
          dataDir,
          triggerEvent,
          providerName: electiveProvider,
          providerCount: providerNames.length,
          llmClient,
          systemPrompt,
          userPrompt,
          sourceEventIds,
          allowedRefs,
          reservationId: reservation.reservationId
        });

        if (electiveResult.ok) {
          candidates.push(electiveResult.candidate);
        } else {
          failures.push(electiveResult.error);
        }
      }
    }
  }

  if (candidates.length === 0) {
    throw failures[0];
  }

  return candidates;
}
