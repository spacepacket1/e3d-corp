import { resolveProvider } from '../llm/registry.js';

const ROLE_NAME = 'sales.leadReplyTriage';
const TIERS = new Set(['auto', 'draft', 'escalate']);

// SMS segments are 160 chars (70 with unicode); 480 covers three segments,
// which real estimate/scheduling links plus a sentence of context fit inside
// without the reply reading as spam-length. Email has no equivalent limit,
// so only sms replies get truncated.
const MAX_SMS_REPLY_CHARS = 480;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Mirrors the three tiers decided in docs/debates/2026-10-13-itera-works-gtm-
// reconciliation: auto-send is templated and non-committal only, draft is
// everything conversational that still needs a human to actually send it,
// and escalate is anything that would commit the business (price, scope,
// contract terms) or that the model isn't confident classifying - matching
// the same no-fabrication, no-unilateral-business-decision boundary as
// invoiceReminder.js and xEngagementReply.js.
function buildSystemPrompt() {
  return [
    'You are triaging one inbound SMS or email reply from a sales lead or existing customer of an HVAC/plumbing service business, for a human at the business (or at their marketing partner) to review.',
    'You are given the inbound message, the channel, known business facts (hours, service area, services, already-scheduled appointment details if any), and recent conversation history. These are the only facts - never invent a price, a policy, a promise, or a commitment the business has not stated.',
    'Classify the reply into exactly one tier:',
    '"auto" - the reply is templated and non-committal: acknowledging receipt, confirming an already-scheduled appointment detail, or restating a known fact (hours, service area, services offered). Safe to send with no human review.',
    '"draft" - the reply requires judgment (answering a substantive question, handling a mild objection, proposing a scheduling time) but does not commit the business to a price, scope, or contract term. A human must approve before it is sent.',
    '"escalate" - the message involves pricing, scope or contract negotiation, a complaint, anything legally or reputationally sensitive, or you are not confident how to classify it. Never draft a reply for this tier - a human handles it with no AI-authored text to anchor on.',
    'When uncertain between two tiers, choose the more conservative one (draft over auto, escalate over draft).',
    'Respond with ONLY a JSON object, no markdown, no commentary, matching exactly this shape: {"tier": "auto" | "draft" | "escalate", "reply": string or null, "reason": string}',
    '"reply" must be null when tier is "escalate", and a non-empty, ready-to-send string otherwise.',
    '"reason" is a short, specific explanation of the classification - this is the only thing a human sees for escalated messages, so make it useful.'
  ].join('\n');
}

function buildUserPrompt({ message, context }) {
  return JSON.stringify(
    {
      channel: message.channel,
      from: message.from ?? null,
      received_at: message.receivedAt ?? null,
      message_text: message.text,
      business_facts: context?.businessFacts ?? null,
      lead: context?.lead ?? null,
      conversation_history: context?.conversationHistory ?? []
    },
    null,
    2
  );
}

const URL_PATTERN = /https?:\/\/\S+/g;

// Same fix as xEngagementReply.js's sanitizeReply: a hard slice can land
// inside a URL (e.g. a scheduling link) and produce a broken one.
function truncateKeepingUrls(text, maxChars) {
  if (text.length <= maxChars) return text;

  let cutAt = maxChars;
  URL_PATTERN.lastIndex = 0;
  let match;
  while ((match = URL_PATTERN.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < maxChars && maxChars < end) {
      cutAt = start;
      break;
    }
  }
  return text.slice(0, cutAt).trimEnd();
}

// Fail-closed by construction: any response that doesn't parse, or doesn't
// match the exact shape, becomes "escalate" with no reply rather than being
// treated as unavailable - an inbound lead message always needs a human to
// see it land somewhere, even when the model's output can't be trusted.
function sanitizeTriageResult(rawText, channel) {
  const fallback = { tier: 'escalate', reply: null, reason: 'Model response could not be parsed - defaulting to escalate.' };
  if (typeof rawText !== 'string') return fallback;

  const trimmed = rawText.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  if (trimmed === '') return fallback;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fallback;
  }

  if (!TIERS.has(parsed?.tier) || !isNonEmptyString(parsed?.reason)) return fallback;

  if (parsed.tier === 'escalate') {
    return { tier: 'escalate', reply: null, reason: parsed.reason.trim() };
  }

  if (!isNonEmptyString(parsed?.reply)) return fallback;
  let reply = parsed.reply.trim();
  if (channel === 'sms') reply = truncateKeepingUrls(reply, MAX_SMS_REPLY_CHARS);

  return { tier: parsed.tier, reply, reason: parsed.reason.trim() };
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) return providerConfig.trim();
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

// Authority level 0: pure classification and drafting, no send, no state
// write. The caller is the one with authority to act, and must honor the
// tier - auto may be sent directly, draft must be queued for human approval,
// escalate must never carry an AI-authored reply to the send path at all.
export async function draftLeadReplyTriage({ instanceConfig, message, context, llmClient } = {}) {
  if (!message || !isNonEmptyString(message.text)) {
    throw new Error(`${ROLE_NAME} requires a message object with non-empty text`);
  }
  if (!isNonEmptyString(message.channel)) {
    throw new Error(`${ROLE_NAME} requires message.channel`);
  }
  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ message, context });
  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const { tier, reply, reason } = sanitizeTriageResult(response?.text, message.channel);

  return { tier, reply, reason, provider, model };
}

export { MAX_SMS_REPLY_CHARS, buildSystemPrompt, sanitizeTriageResult, truncateKeepingUrls };
