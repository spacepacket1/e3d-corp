import { appendEvent, queryEvents } from '../events/store.js';
import { reserveBudget, settleReservation } from '../llm/budget.js';
import { resolveProvider } from '../llm/registry.js';
import { normalizeOpportunityCandidate, OPPORTUNITY_TYPE_EXAMPLES } from '../opportunities/schema.js';

const ROLE_NAME = 'opportunity.prospect';

function buildSystemPrompt(companyName) {
  return [
    `You are the opportunity.prospect role inside e3d-corp, a system that helps ${companyName} find real, ` +
      'evidence-backed business opportunities.',
    'You are given one triggering event (a lead, a manually-added signal, or a discovery-pass signal) ' +
      `and any evidence already gathered for it (${companyName} knowledge-base results, web search results).`,
    'Respond with ONLY a single JSON object — no prose, no markdown code fences — matching exactly this shape:',
    '{"type": string, "title": string, "description": string, "evidenceEventIds": string[], ' +
      '"confidence": number, "rationale": string, ' +
      '"counterparty": {"name": string|null, "kind": "company"|"person"|"none", "contactHint": string|null}, ' +
      '"wantsSecondOpinion"?: boolean, "secondOpinionReason"?: string}',
    `"type" should be a short kebab-case string. Common examples: ${OPPORTUNITY_TYPE_EXAMPLES.join(', ')}. ` +
      'Pick the closest fit, or invent a similarly-shaped one if none fit.',
    '"evidenceEventIds" must only contain ids taken from the evidence list you were given below — never invent one.',
    '"confidence" is your own confidence this is a real, worthwhile opportunity, from 0 to 1.',
    '"rationale" briefly explains why, citing the evidence.',
    '"counterparty" is required on every response. When the evidence names a real, contactable target for the ' +
      'opportunity, set kind to "company" or "person", give its real name, and include a brief contactHint when ' +
      'you have one. When the evidence does not name a real counterparty, set kind to "none" and leave both name ' +
      'and contactHint null.',
    `Never claim a ${companyName} capability that isn't supported by the evidence provided.`,
    '"title" and "description" must name a SPECIFIC finding from the evidence below — a named company, ' +
      'product, article, technology, or event you can point to — never a generic restatement of the search ' +
      'query or trigger topic itself (e.g. "growing interest in X" / "a market trend toward X" is not acceptable ' +
      'unless X is a specific named thing you found, not the topic you searched for).',
    `If the evidence is only about an entity that happens to share a name with one of ${companyName}'s own products, ` +
      'that is not a valid partnership or distribution counterparty for that product. Recognize the name collision ' +
      'and either set counterparty.kind to "none" or describe the distinct finding honestly without implying a ' +
      'relationship that the evidence does not support.',
    'If the evidence genuinely contains nothing specific and actionable, respond with the JSON shape above, ' +
      'using a low confidence value (below 0.3) and say plainly in the rationale that nothing specific was found ' +
      '— a low-confidence, honest "nothing here" is far better than a vague opportunity manufactured to fill ' +
      'the response.',
    'Set "wantsSecondOpinion" to true only when a second provider perspective would materially help; when you do, ' +
      'include a brief "secondOpinionReason". These fields are optional control signals, not part of the Opportunity record.',
    'Never respond with free text instead of JSON, in any case.'
  ].join('\n');
}

function truncate(text, maxLength) {
  if (typeof text !== 'string') return text;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeResultItem(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    title: item.title,
    url: item.url,
    snippet: truncate(item.content ?? item.snippet ?? '', 400)
  };
}

function normalizeDomainEntry(domain) {
  return typeof domain === 'string' && domain.trim() !== '' ? domain.trim().toLowerCase() : null;
}

function hostnameFromUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isOwnDomainMatch(url, ownDomains) {
  const hostname = hostnameFromUrl(url);
  if (!hostname || !Array.isArray(ownDomains) || ownDomains.length === 0) {
    return false;
  }

  return ownDomains.some((domain) => {
    const normalized = normalizeDomainEntry(domain);
    return normalized ? hostname === normalized || hostname.endsWith(`.${normalized}`) : false;
  });
}

function filterOwnDomainResults(results, ownDomains) {
  if (!Array.isArray(results) || !Array.isArray(ownDomains) || ownDomains.length === 0) {
    return results;
  }

  return results.filter((item) => !isOwnDomainMatch(item?.url, ownDomains));
}

function summarizeEvidenceEvent(event, ownDomains) {
  const result = event.payload?.result;
  const filteredResults = filterOwnDomainResults(result?.results, ownDomains);
  const topResults = Array.isArray(filteredResults) ? filteredResults.slice(0, 5).map(summarizeResultItem) : undefined;

  return {
    id: event.id,
    occurredAt: event.occurredAt,
    kind: event.payload?.kind,
    query: event.payload?.query,
    resultSummary: event.payload?.resultSummary,
    results: topResults,
    degraded: event.payload?.degraded ?? false
  };
}

export function buildPrompt({ triggerEvent, evidenceEvents, instanceConfig }) {
  const userPrompt = JSON.stringify(
    {
      triggerEvent: {
        id: triggerEvent.id,
        type: triggerEvent.type,
        occurredAt: triggerEvent.occurredAt,
        source: triggerEvent.source,
        payload: triggerEvent.payload
      },
      evidence: evidenceEvents.map((event) => summarizeEvidenceEvent(event, instanceConfig?.ownDomains))
    },
    null,
    2
  );

  return { systemPrompt: buildSystemPrompt(instanceConfig?.name || 'the company'), userPrompt };
}

// Local models sometimes wrap otherwise-correct JSON in a markdown fence despite
// instructions not to. Stripping that envelope is not "guessing" the semantic
// content — it's normalizing formatting before a strict JSON.parse, which still
// throws on anything that isn't valid JSON underneath.
function stripMarkdownFence(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseCandidateJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('opportunity.prospect returned empty output');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFence(rawText));
  } catch (error) {
    throw new Error(`opportunity.prospect returned invalid JSON: ${error.message}`);
  }

  return parsed;
}

function deriveResearchQuery(triggerEvent) {
  const payload = triggerEvent.payload ?? {};
  return (
    payload.topic ||
    payload.workflowProblem ||
    payload.submission?.workflowProblem ||
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
      throw new Error('runOpportunityProspect received a single llmClient function for a multi-provider role');
    }
    const { model } = resolveProvider(instanceConfig, provider);
    return { provider, model, call: llmClient };
  }

  if (llmClient && typeof llmClient === 'object') {
    const call = llmClient[provider];
    if (typeof call !== 'function') {
      throw new Error(`runOpportunityProspect is missing an llmClient stub for provider "${provider}"`);
    }
    const { model } = resolveProvider(instanceConfig, provider);
    return { provider, model, call };
  }

  throw new Error('runOpportunityProspect requires llmClient to be a function or provider map when provided');
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
    candidate = normalizeOpportunityCandidate(parsed);
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

// Authority level 0/1: read-only research plus an internal write (the evidence
// event), fully autonomous. This does not itself create the Opportunity record —
// runOpportunityEngine does that, deterministically, from this function's output.
export async function runOpportunityProspect({
  instanceConfig,
  dataDir,
  triggerEvent,
  researchAdapter,
  researchQuery,
  llmClient
} = {}) {
  if (!triggerEvent || !triggerEvent.id || !triggerEvent.correlationId) {
    throw new Error('runOpportunityProspect requires a triggerEvent with an id and correlationId');
  }
  if (!dataDir) {
    throw new Error('runOpportunityProspect requires a dataDir');
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
  const { systemPrompt, userPrompt } = buildPrompt({ triggerEvent, evidenceEvents, instanceConfig });
  const sourceEventIds = [triggerEvent.id, ...evidenceEvents.map((event) => event.id)];
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
      sourceEventIds
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
