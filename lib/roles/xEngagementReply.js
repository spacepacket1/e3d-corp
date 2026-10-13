import { resolveProvider } from '../llm/registry.js';

const ROLE_NAME = 'x.engagementReply';
const MAX_REPLY_CHARS = 240;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Grounded in e3d.ai's own real, documented capabilities (e3d-mcp's README:
// token prices/gainers, on-chain narratives, investment theses, wallet/
// address analytics, AI trading agents with funding/strategy/burn data,
// token registry claims) - never invented marketing claims. Mirrors the
// proven system prompt shape from e3d-maps' own X agent
// (/Users/mini/e3d/agents/scripts/x-heartbeat.js): add real value first,
// mention the product naturally only if it fits, and give the model an
// explicit escape hatch (respond exactly "null") for anything spammy,
// promotional, or off-topic rather than forcing a reply out of it.
//
// Findings-first by design, not just by prompt wording: the caller
// (ops/reports/runXEngagement.js) is expected to pass a concrete `findings`
// data point pulled live from e3d.ai (lib/research/e3dFindings.js). If none
// was found, draftEngagementReply skips the LLM call entirely and returns
// null - a draft with nothing real to cite is worse than no draft, and this
// also means the fabrication guard doesn't depend on the model obeying an
// instruction it could ignore.
//
// The no-fabrication boundary is specifically about FACTS, not voice: an
// earlier version of this prompt ("lead with the finding", "use ONLY the
// finding you were given") produced replies that just read the finding back
// verbatim, flagged in review as regurgitation. The fix is drawing the line
// precisely - no second invented number/price/claim, but a genuine take,
// implication, or sharper framing built on the one real fact is exactly
// what's wanted, not a violation of it.
function buildSystemPrompt() {
  return [
    'You are drafting a reply for a human at FutCo to review and post from FutCo\'s X/Twitter account - you are not posting it yourself.',
    'You found a public post genuinely discussing on-chain analytics, crypto trading agents, token research, or blockchain data tooling.',
    'You have one concrete, real finding from e3d.ai related to this topic. Do not just restate it - that reads as a bot repeating a headline. React to it: connect it specifically to what this post said, and add a genuine take, implication, or angle a knowledgeable person in this space would actually have.',
    'The finding is your only fact - never invent a second number, price, or claim. Opinion, interpretation, and framing built on that one fact are encouraged, not a violation of this rule.',
    'Mention e3d.ai (a blockchain analytics and AI agent platform) naturally only if it fits after you have made your actual point. Never force it in. If you do mention it and finding_url below is not null, include that exact URL - it points at the specific story or thesis the finding came from, not e3d.ai\'s homepage, so a reader can go verify the actual claim. Never substitute a bare "e3d.ai" mention as a link, never invent a different URL, and never include any link at all if finding_url is null.',
    'If the finding does not genuinely fit this specific post, respond with exactly: null',
    `CRITICAL: the reply must be ${MAX_REPLY_CHARS} characters or fewer.`,
    'Respond with ONLY the reply text, or exactly "null" - no quotes, no markdown, no commentary.'
  ].join('\n');
}

function buildUserPrompt({ postText, topic, findings }) {
  return JSON.stringify(
    {
      post_text: postText,
      matched_topic: topic ?? null,
      finding: findings[0].text,
      finding_source: findings[0].source,
      finding_url: findings[0].url ?? null
    },
    null,
    2
  );
}

function sanitizeReply(rawText) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, MAX_REPLY_CHARS);
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) return providerConfig.trim();
  if (Array.isArray(providerConfig)) {
    const [first] = providerConfig;
    if (isNonEmptyString(first)) return first.trim();
  }
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

// Authority level 0: pure drafting, no state write, no Proposal. The
// decision to actually post (and the event-log record of having done so)
// lives entirely in the caller (ops/reports/runXEngagement.js) - this role
// only ever returns a candidate reply string or null.
export async function draftEngagementReply({ instanceConfig, postText, topic, findings, llmClient } = {}) {
  if (!isNonEmptyString(postText)) {
    throw new Error(`${ROLE_NAME} requires non-empty postText`);
  }
  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }

  if (!Array.isArray(findings) || findings.length === 0) {
    return { reply: null, provider, model, reason: 'no concrete e3d.ai finding for this topic' };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ postText, topic, findings });
  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const reply = sanitizeReply(response?.text);

  return { reply, provider, model };
}

export { MAX_REPLY_CHARS, buildSystemPrompt, sanitizeReply };
