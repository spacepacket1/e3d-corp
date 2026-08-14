import { reconstructChain } from '../events/chain.js';
import { createLocalLlmClient } from '../llm/localClient.js';
import { createProposal } from '../proposals/create.js';

const ROLE_NAME = 'opportunity.communicator';

const SYSTEM_PROMPT = [
  'You are the opportunity.communicator role inside e3d-corp, a system that helps FutCo pursue real, ' +
    'evidence-backed business opportunities.',
  'You are given one Opportunity that a human has already reviewed and marked "pursuing", plus the full ' +
    'causal chain of events that led to it (the original trigger, research evidence gathered from FutCo\'s own ' +
    'knowledge base and the web, scoring, and the human decision).',
  'Draft outreach content (a short email) that a human will review and approve before anything is sent - you ' +
    'never send anything yourself.',
  'Respond with ONLY a single JSON object - no prose, no markdown code fences - matching exactly this shape:',
  '{"subject": string, "body": string, "rationale": string}',
  '"subject" is a short, specific email subject line - never generic ("Following up" is not acceptable; name ' +
    'the actual opportunity).',
  '"body" is the full email body, written for the specific recipient/context in the evidence below - reference ' +
    'a concrete detail from the evidence, not a generic pitch.',
  "Never claim a FutCo capability, product, or track record that isn't directly supported by the evidence " +
    'provided below - if the evidence is thin, write a shorter, more modest email rather than inventing detail.',
  'Do not include a recipient address, greeting placeholder like "[Name]", or signature block - those are ' +
    'filled in outside this draft.',
  '"rationale" briefly explains why this outreach and this specific angle, citing the evidence.',
  'Never respond with free text instead of JSON, in any case.'
].join('\n');

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

export function buildPrompt({ opportunity, chain }) {
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

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

function resolveRoleIdentity(instanceConfig) {
  const roleConfig = instanceConfig?.roles?.[ROLE_NAME];
  if (!roleConfig || !isNonEmptyString(roleConfig.provider) || !isNonEmptyString(roleConfig.model)) {
    throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider/model`);
  }
  return { role: ROLE_NAME, provider: roleConfig.provider, model: roleConfig.model };
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

  const { systemPrompt, userPrompt } = buildPrompt({ opportunity, chain });
  const call = llmClient ?? createLocalLlmClient(instanceConfig);
  const rawText = await call({ systemPrompt, userPrompt });
  const draft = normalizeOutreachDraft(parseDraftJson(rawText));

  const causationEvent = latestEventForOpportunity(chain, opportunity.id);

  const { proposal, event } = createProposal(dataDir, {
    type: 'send-outreach',
    payload: {
      to: recipient,
      subject: draft.subject,
      body: draft.body,
      rationale: draft.rationale,
      opportunityId: opportunity.id,
      opportunityTitle: opportunity.title
    },
    proposedBy: resolveRoleIdentity(instanceConfig),
    causationId: causationEvent ? causationEvent.id : null,
    correlationId: opportunity.correlationId,
    instanceConfig
  });

  return { draft: { ...draft, to: recipient }, proposal, event };
}
