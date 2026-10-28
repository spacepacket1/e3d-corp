import { resolveProvider } from '../llm/registry.js';
import { WORDING_RULES } from '../pilot/growthFacts.js';
import { parseJsonObject, claimProblem, checkCitations, urlProblem } from '../pilot/growthCommon.js';

const ROLE_NAME = 'x.engagementReply';
// X's actual single-tweet limit. The earlier 240 was carried over from
// x-heartbeat.js's own cap with no documented reason - since every draft is
// reviewed and edited by a human before posting, there's no need for extra
// safety margin below the real platform limit.
const MAX_REPLY_CHARS = 280;

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

const URL_PATTERN = /https?:\/\/\S+/g;

// A hard slice(0, MAX_REPLY_CHARS) can land inside a URL when the model's raw
// text runs slightly over the cap - confirmed live, producing a truncated,
// dead link (e.g. a story UUID missing its last few characters). A reply
// with no link at all is far better than one with a broken one a reviewer
// won't notice before posting, so the cut point moves back to before the
// URL starts rather than through it.
function sanitizeReply(rawText) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  if (trimmed.length <= MAX_REPLY_CHARS) return trimmed;

  let cutAt = MAX_REPLY_CHARS;
  URL_PATTERN.lastIndex = 0;
  let match;
  while ((match = URL_PATTERN.exec(trimmed))) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < MAX_REPLY_CHARS && MAX_REPLY_CHARS < end) {
      cutAt = start;
      break;
    }
  }
  return trimmed.slice(0, cutAt).trimEnd();
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

const PILOT_MENTION = /pilot\.e3d\.ai/gi;

function buildPilotSystemPrompt() {
  return [
    'You are drafting a reply for the owner of Pilot (pilot.e3d.ai), a multi-model debate service, to review and post from his X account. You never post.',
    'You found a public post. Write a short, genuinely useful, non-spammy reply a knowledgeable person would write: answer or sharpen the point the post makes. Opinion and framing are welcome; invented facts are not.',
    'Ground every factual claim about Pilot ONLY in the facts supplied. Never invent a number, customer, quote, result, launch or feature. List the ids of the facts you relied on in "citedFacts".',
    ...WORDING_RULES,
    'Mention pilot.e3d.ai only if it is directly relevant to what the post asks or discusses, at most once, and only after making your actual point. Never pitch, never use hashtags, never ask for follows. Only include URLs that appear in the facts.',
    'If the post is spam, off-topic, hostile, or no supplied fact fits it, decline by returning reply null.',
    `The reply must be ${MAX_REPLY_CHARS} characters or fewer.`,
    'Respond with ONLY a JSON object, no markdown fences: {"reply": string|null, "citedFacts": string[], "reason": string}'
  ].join('\n');
}

export function validatePilotReply(raw, { facts } = {}) {
  const parsed = parseJsonObject(raw);
  if (!parsed) return { reply: null, reason: 'the model did not return a JSON object' };
  if (parsed.reply === null || (typeof parsed.reply === 'string' && ['', 'null'].includes(parsed.reply.trim().toLowerCase()))) {
    return { reply: null, reason: 'declined' };
  }
  if (typeof parsed.reply !== 'string') return { reply: null, reason: 'reply is not text' };
  const reply = parsed.reply.trim();
  if (reply.length > MAX_REPLY_CHARS) return { reply: null, reason: `reply over ${MAX_REPLY_CHARS} characters` };
  if ((reply.match(PILOT_MENTION) ?? []).length > 1) return { reply: null, reason: 'mentions pilot.e3d.ai more than once' };
  const problem = claimProblem(reply) ?? urlProblem(reply, facts);
  if (problem) return { reply: null, reason: problem };
  const citation = checkCitations(parsed.citedFacts, facts);
  if (citation.problem) return { reply: null, reason: citation.problem };
  return {
    reply,
    citedFacts: citation.ids,
    citedFactTexts: citation.ids.map((id) => facts.find((fact) => fact.id === id).text)
  };
}

// Pilot-grounded variant: facts come from lib/pilot/growthFacts.js. Same
// authority level 0 as draftEngagementReply: returns a candidate or a decline.
export async function draftPilotEngagementReply({ instanceConfig, postText, topic, facts, llmClient } = {}) {
  if (!isNonEmptyString(postText)) throw new Error(`${ROLE_NAME} requires non-empty postText`);
  if (!Array.isArray(facts) || facts.length === 0) throw new Error(`${ROLE_NAME} requires a non-empty facts list`);
  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }
  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);
  const response = await (llmClient ?? call)({
    systemPrompt: buildPilotSystemPrompt(),
    userPrompt: JSON.stringify({ post_text: postText, matched_topic: topic ?? null, facts }, null, 2)
  });
  return { ...validatePilotReply(response?.text, { facts }), provider, model };
}

export { MAX_REPLY_CHARS, buildPilotSystemPrompt, buildSystemPrompt, sanitizeReply };
