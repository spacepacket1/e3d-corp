import { reconstructChain } from '../events/chain.js';
import { appendEvent } from '../events/store.js';
import { resolveProvider } from '../llm/registry.js';
import { createProposal } from '../proposals/create.js';

const ROLE_NAME = 'opportunity.communicator';

function buildSystemPrompt(companyName) {
  return [
    `You are the opportunity.communicator role inside e3d-corp, a system that helps ${companyName} pursue real, ` +
      'evidence-backed business opportunities.',
    'You are given one Opportunity that a human has already reviewed and marked "pursuing", plus the full ' +
      `causal chain of events that led to it (the original trigger, research evidence gathered from ${companyName}'s own ` +
      'knowledge base and the web, scoring, and the human decision).',
    'Draft outreach content (a short email) that a human will review and approve before anything is sent - you ' +
      'never send anything yourself.',
    'Respond with ONLY a single JSON object - no prose, no markdown code fences - matching exactly this shape:',
    '{"subject": string, "body": string, "rationale": string}',
    '"subject" is a short, specific email subject line - never generic ("Following up" is not acceptable; name ' +
      'the actual opportunity).',
    '"body" is the full email body, written for the specific recipient/context in the evidence below - reference ' +
      'a concrete detail from the evidence, not a generic pitch.',
    `Never claim a ${companyName} capability, product, or track record that isn't directly supported by the evidence ` +
      'provided below - if the evidence is thin, write a shorter, more modest email rather than inventing detail.',
    'Do not include a recipient address, greeting placeholder like "[Name]", or signature block - those are ' +
      'filled in outside this draft.',
    '"rationale" briefly explains why this outreach and this specific angle, citing the evidence.',
    'Never respond with free text instead of JSON, in any case.'
  ].join('\n');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function validateOutreachDraft(draft) {
  const errors = [];

  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    return { valid: false, errors: ['draft: must be an object'] };
  }

  if (!isNonEmptyString(draft.subject)) {
    errors.push('subject: must be a non-empty string');
  }
  if (!isNonEmptyString(draft.body)) {
    errors.push('body: must be a non-empty string');
  }
  if (!isNonEmptyString(draft.rationale)) {
    errors.push('rationale: must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeOutreachDraft(draft) {
  const { valid, errors } = validateOutreachDraft(draft);
  if (!valid) {
    throw new Error(`Invalid outreach draft:\n- ${errors.join('\n- ')}`);
  }

  return {
    subject: draft.subject.trim(),
    body: draft.body.trim(),
    rationale: draft.rationale.trim()
  };
}

// Local models sometimes wrap otherwise-correct JSON in a markdown fence
// despite instructions not to - same normalization opportunityProspect.js
// applies before a strict JSON.parse.
function stripMarkdownFence(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseDraftJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('opportunity.communicator returned empty output');
  }

  try {
    return JSON.parse(stripMarkdownFence(rawText));
  } catch (error) {
    throw new Error(`opportunity.communicator returned invalid JSON: ${error.message}`);
  }
}

function truncate(text, maxLength) {
  if (typeof text !== 'string') return text;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeChainEvent(event) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: truncate(JSON.stringify(event.payload), 1200)
  };
}

// Deterministic, not LLM-derived: a role should never hallucinate an email
// address. Prefers a real contact captured from an inbound lead; falls back
// to the instance's configured routing address (e.g. an internal inbox) for
// opportunities that never had a direct external contact (discovery-pass
// market signals), and refuses outright if neither is available.
export function deriveRecipient({ chain, instanceConfig }) {
  const leadEvent = [...chain]
    .reverse()
    .find((event) => event.type === 'lead.received' && isNonEmptyString(event.payload?.submission?.email));
  if (leadEvent) {
    return leadEvent.payload.submission.email.trim();
  }

  const fallback = instanceConfig?.outreach?.fallbackToEmail;
  if (isNonEmptyString(fallback)) {
    return fallback.trim();
  }

  return null;
}

export function buildPrompt({ opportunity, chain, instanceConfig }) {
  const userPrompt = JSON.stringify(
    {
      opportunity: {
        id: opportunity.id,
        type: opportunity.type,
        title: opportunity.title,
        description: opportunity.description,
        score: opportunity.score
      },
      causalChain: chain.map(summarizeChainEvent)
    },
    null,
    2
  );

  return { systemPrompt: buildSystemPrompt(instanceConfig?.name || 'the company'), userPrompt };
}

function normalizeProviderNames(providerConfig) {
  if (typeof providerConfig === 'string' && providerConfig.trim() !== '') {
    return [providerConfig.trim()];
  }
  if (Array.isArray(providerConfig) && providerConfig.length > 0) {
    const names = providerConfig
      .filter((name) => typeof name === 'string' && name.trim() !== '')
      .map((name) => name.trim());
    if (names.length > 0) {
      return names;
    }
  }
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

function resolveProviderCalls({ instanceConfig, providerNames, llmClient }) {
  if (!llmClient) {
    const calls = [];
    const failures = [];
    providerNames.forEach((provider) => {
      try {
        const resolved = resolveProvider(instanceConfig, provider);
        calls.push({ provider, model: resolved.model, call: resolved.call });
      } catch (error) {
        failures.push({ provider, error });
      }
    });
    return { calls, failures };
  }

  if (typeof llmClient === 'function') {
    if (providerNames.length !== 1) {
      throw new Error('runOpportunityCommunicator received a single llmClient function for a multi-provider role');
    }
    const [provider] = providerNames;
    const { model } = resolveProvider(instanceConfig, provider);
    return { calls: [{ provider, model, call: llmClient }], failures: [] };
  }

  if (llmClient && typeof llmClient === 'object') {
    const calls = [];
    const failures = [];
    providerNames.forEach((provider) => {
      try {
        const call = llmClient[provider];
        if (typeof call !== 'function') {
          throw new Error(`runOpportunityCommunicator is missing an llmClient stub for provider "${provider}"`);
        }
        const { model } = resolveProvider(instanceConfig, provider);
        calls.push({ provider, model, call });
      } catch (error) {
        failures.push({ provider, error });
      }
    });
    return { calls, failures };
  }

  throw new Error('runOpportunityCommunicator requires llmClient to be a function or provider map when provided');
}

function recordProviderCompletion({ dataDir, causationId, opportunity, provider, model, usage, costUsd, latencyMs }) {
  appendEvent(dataDir, {
    type: 'role.provider.completed',
    source: `role:${ROLE_NAME}`,
    subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider, model, usage, costUsd, latencyMs },
    causationId,
    correlationId: opportunity.correlationId
  });
}

function recordProviderFailure({ dataDir, causationId, opportunity, provider, model, usage, costUsd, latencyMs, reason }) {
  appendEvent(dataDir, {
    type: 'role.provider.failed',
    source: `role:${ROLE_NAME}`,
    subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider, model, usage, costUsd, latencyMs, reason },
    causationId,
    correlationId: opportunity.correlationId
  });
}

function enrichProviderError(error, { usage, costUsd, latencyMs }) {
  const enriched = error instanceof Error ? error : new Error(String(error));
  enriched.usage = usage ?? null;
  enriched.costUsd = costUsd ?? null;
  enriched.latencyMs = latencyMs ?? null;
  return enriched;
}

function latestEventForOpportunity(chain, opportunityId) {
  const related = chain.filter((event) => event.subject?.type === 'opportunity' && event.subject.id === opportunityId);
  return related[related.length - 1] ?? chain[chain.length - 1] ?? null;
}

// Authority level 0/1 read + an authority-level-1 write (creating the
// Proposal itself is internal/reversible, exactly like Phase 4's Opportunity
// creation) - what the Proposal proposes (actually sending the email) is
// authority level 2 and requires a human Decision, enforced by
// lib/actions/sendOutreach.js, never here. This function creates a Proposal
// and nothing else; it never sends anything under any circumstance.
export async function runOpportunityCommunicator({
  instanceConfig,
  dataDir,
  opportunity,
  researchAdapter,
  llmClient
} = {}) {
  if (!opportunity || !opportunity.id || !opportunity.correlationId) {
    throw new Error('runOpportunityCommunicator requires an opportunity with an id and correlationId');
  }
  if (opportunity.status !== 'pursuing') {
    throw new Error(
      `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status}); refusing to draft outreach`
    );
  }
  if (!dataDir) {
    throw new Error('runOpportunityCommunicator requires a dataDir');
  }

  if (researchAdapter) {
    await researchAdapter.searchKnowledgeBase(opportunity.title, {
      correlationId: opportunity.correlationId
    });
  }

  const chain = reconstructChain(dataDir, opportunity.correlationId);

  const recipient = deriveRecipient({ chain, instanceConfig });
  if (!recipient) {
    throw new Error(
      `Cannot draft outreach for opportunity ${opportunity.id}: no recipient email found in its evidence chain ` +
        'and no outreach.fallbackToEmail configured'
    );
  }

  const causationEvent = latestEventForOpportunity(chain, opportunity.id);
  const { systemPrompt, userPrompt } = buildPrompt({ opportunity, chain, instanceConfig });
  const providerNames = normalizeProviderNames(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { calls: providerCalls, failures: resolutionFailures } = resolveProviderCalls({
    instanceConfig,
    providerNames,
    llmClient
  });
  const failures = [];

  resolutionFailures.forEach(({ provider, error }) => {
    const reason = error instanceof Error ? error.message : String(error);
    recordProviderFailure({
      dataDir,
      causationId: causationEvent ? causationEvent.id : null,
      opportunity,
      provider,
      model: null,
      usage: null,
      costUsd: null,
      latencyMs: null,
      reason
    });
    failures.push(error instanceof Error ? error : new Error(reason));
  });

  const results = await Promise.allSettled(
    providerCalls.map(async ({ provider, model, call }) => {
      const startedAt = Date.now();
      let response;
      try {
        response = await call({ systemPrompt, userPrompt });
      } catch (error) {
        throw enrichProviderError(error, { usage: error?.usage ?? null, costUsd: error?.costUsd ?? null, latencyMs: Date.now() - startedAt });
      }

      const { text, usage, costUsd } = response;
      const latencyMs = Date.now() - startedAt;
      recordProviderCompletion({
        dataDir,
        causationId: causationEvent ? causationEvent.id : null,
        opportunity,
        provider,
        model,
        usage,
        costUsd,
        latencyMs
      });

      let draft;
      try {
        draft = normalizeOutreachDraft(parseDraftJson(text));
      } catch (error) {
        throw enrichProviderError(error, { usage, costUsd, latencyMs });
      }

      const created = createProposal(dataDir, {
        type: 'send-outreach',
        payload: {
          to: recipient,
          subject: draft.subject,
          body: draft.body,
          rationale: draft.rationale,
          opportunityId: opportunity.id,
          opportunityTitle: opportunity.title
        },
        proposedBy: { role: ROLE_NAME, provider, model },
        causationId: causationEvent ? causationEvent.id : null,
        correlationId: opportunity.correlationId,
        instanceConfig
      });

      return {
        draft: { ...draft, to: recipient },
        proposal: created.proposal,
        event: created.event
      };
    })
  );

  const succeeded = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      succeeded.push(result.value);
      return;
    }

    const provider = providerCalls[index].provider;
    const model = providerCalls[index].model;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    recordProviderFailure({
      dataDir,
      causationId: causationEvent ? causationEvent.id : null,
      opportunity,
      provider,
      model,
      usage: result.reason?.usage ?? null,
      costUsd: result.reason?.costUsd ?? null,
      latencyMs: result.reason?.latencyMs ?? null,
      reason
    });
    failures.push(result.reason instanceof Error ? result.reason : new Error(reason));
  });

  if (succeeded.length === 0) {
    throw failures[0] ?? new Error('opportunity.communicator produced no valid outreach drafts');
  }
  if (succeeded.length === 1) {
    const [only] = succeeded;
    return {
      draft: only.draft,
      proposal: only.proposal,
      event: only.event,
      drafts: [only.draft],
      proposals: [only.proposal],
      events: [only.event]
    };
  }

  return {
    drafts: succeeded.map((entry) => entry.draft),
    proposals: succeeded.map((entry) => entry.proposal),
    events: succeeded.map((entry) => entry.event)
  };
}
