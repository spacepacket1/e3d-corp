import { WORDING_RULES } from '../pilot/growthFacts.js';
import { isNonEmptyString, parseJsonObject, resolveRoleProvider, claimProblem, checkCitations, urlProblem } from '../pilot/growthCommon.js';

const ROLE_NAME = 'pilot.contentDraft';
const X_MAX = 280;
const LINKEDIN_MAX = 3000;
const PLATFORMS = ['x', 'linkedin'];

// Level 0/1 drafting only: returns validated drafts, writes and posts nothing.
// The runner (ops/reports/runPilotContent.js) turns each draft into an x-post /
// linkedin-post Proposal that waits for an owner Decision.
function buildSystemPrompt(maxDrafts) {
  return [
    'You draft weekly social posts for the owner of Pilot (pilot.e3d.ai), a multi-model debate service. A human reviews and approves every post; you never post.',
    'Audience: developers and teams who use several AI models, agent builders, MCP and ChatGPT-directory users, and people who want a second opinion before a decision.',
    'Ground every draft ONLY in the facts and debate examples you are given. Never invent a number, customer, quote, result, launch or feature. Each draft must list the ids of the facts it relies on in "citedFacts".',
    ...WORDING_RULES,
    'Write like a person who built the thing: specific, plain, no hype, no emoji spam, no hashtags stacks. Text and links only (the owner posts video natively himself). Only include URLs that appear in the facts.',
    `X posts must be ${X_MAX} characters or fewer. LinkedIn posts must be ${LINKEDIN_MAX} characters or fewer.`,
    `Return at most ${maxDrafts} drafts, a mix of X and LinkedIn. Returning fewer, or an empty list, is a good answer if the facts do not support more.`,
    'Respond with ONLY a JSON object, no markdown fences: {"drafts": [{"platform": "x"|"linkedin", "text": string, "citedFacts": string[], "angle": string}], "notes": string}'
  ].join('\n');
}

export function validateContentDrafts(raw, { facts, maxDrafts = 4 } = {}) {
  const parsed = parseJsonObject(raw);
  const dropped = [];
  if (!parsed) return { ok: false, reason: 'the model did not return a JSON object', drafts: [], dropped, notes: '' };

  const drafts = [];
  for (const item of Array.isArray(parsed.drafts) ? parsed.drafts : []) {
    if (!PLATFORMS.includes(item?.platform) || !isNonEmptyString(item?.text)) { dropped.push({ reason: 'unknown platform or empty text' }); continue; }
    const text = item.text.trim();
    if (item.platform === 'x' && text.length > X_MAX) { dropped.push({ reason: `x post over ${X_MAX} characters` }); continue; }
    if (item.platform === 'linkedin' && text.length > LINKEDIN_MAX) { dropped.push({ reason: `linkedin post over ${LINKEDIN_MAX} characters` }); continue; }
    const problem = claimProblem(text) ?? urlProblem(text, facts);
    if (problem) { dropped.push({ reason: problem }); continue; }
    const citation = checkCitations(item.citedFacts, facts);
    if (citation.problem) { dropped.push({ reason: citation.problem }); continue; }
    drafts.push({
      platform: item.platform,
      text,
      citedFacts: citation.ids,
      citedFactTexts: citation.ids.map((id) => facts.find((fact) => fact.id === id).text),
      angle: isNonEmptyString(item.angle) ? item.angle.trim() : ''
    });
    if (drafts.length >= maxDrafts) break;
  }
  return { ok: true, drafts, dropped, notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '' };
}

export async function draftPilotContent({ instanceConfig, facts, maxDrafts = 4, llmClient } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) throw new Error(`${ROLE_NAME} requires a non-empty facts list`);
  const { provider, model, call } = resolveRoleProvider(instanceConfig, ROLE_NAME);
  const started = Date.now();
  const response = await (llmClient ?? call)({
    systemPrompt: buildSystemPrompt(maxDrafts),
    userPrompt: JSON.stringify({ facts }, null, 2)
  });
  return { ...validateContentDrafts(response?.text, { facts, maxDrafts }), provider, model, latencyMs: Date.now() - started };
}

export { ROLE_NAME, buildSystemPrompt };
