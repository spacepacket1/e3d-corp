import { WORDING_RULES } from '../pilot/growthFacts.js';
import { isNonEmptyString, parseJsonObject, resolveRoleProvider, claimProblem, checkCitations, urlProblem } from '../pilot/growthCommon.js';
import { validatePilotAdCampaign, DEFAULT_MONTHLY_CEILING_USD } from '../proposals/pilotAdCampaign.js';

const ROLE_NAME = 'pilot.adCopy';
const LIMITS = { headline: 40, primaryText: 125, description: 30 };
const CTAS = ['LEARN_MORE', 'SIGN_UP', 'GET_STARTED'];

function buildSystemPrompt({ monthlyCeilingUsd }) {
  return [
    'You write Meta (Facebook/Instagram) ad copy variants for Pilot (pilot.e3d.ai), a multi-model debate service, and propose a small, capped test. A human approves before anything is spent; you launch nothing.',
    'Audience candidates: developers and teams who use several AI models, agent builders, MCP and ChatGPT-directory users, decision-makers who want a second opinion.',
    'Ground every variant ONLY in the facts provided and list the fact ids it uses in "citedFacts". Never invent numbers, testimonials, customers or results.',
    ...WORDING_RULES,
    `Length limits: headline <= ${LIMITS.headline}, primaryText <= ${LIMITS.primaryText}, description <= ${LIMITS.description} characters. cta is one of ${CTAS.join(', ')}.`,
    'Give 2 to 4 variants and a targeting audience (interests, roles, regions, ageMin/ageMax). No sensitive-attribute targeting.',
    `Budget: monthlyCeilingUsd must be <= ${monthlyCeilingUsd}; dailyCapUsd must be <= monthlyCeilingUsd / 20. Prefer a smaller test than the ceiling.`,
    'killRule is mandatory: pauseIfCpaUsdAbove (cost per sign-up in USD) and pauseIfZeroSignupsAfterSpendUsd (pause if no sign-ups after this much spend; at most half the monthly ceiling).',
    'Respond with ONLY a JSON object, no markdown: {"variants": [{"headline": string, "primaryText": string, "description": string, "cta": string, "citedFacts": string[]}], "audience": {"interests": string[], "roles": string[], "regions": string[], "ageMin": number, "ageMax": number}, "budget": {"monthlyCeilingUsd": number, "dailyCapUsd": number}, "killRule": {"pauseIfCpaUsdAbove": number, "pauseIfZeroSignupsAfterSpendUsd": number}, "rationale": string}'
  ].join('\n');
}

export function validateAdCopy(raw, { facts, monthlyCeilingUsd = DEFAULT_MONTHLY_CEILING_USD } = {}) {
  const parsed = parseJsonObject(raw);
  const dropped = [];
  if (!parsed) return { ok: false, reason: 'the model did not return a JSON object', dropped };

  const variants = [];
  for (const item of Array.isArray(parsed.variants) ? parsed.variants : []) {
    const reason = (() => {
      for (const field of Object.keys(LIMITS)) {
        if (!isNonEmptyString(item?.[field])) return `${field} is empty`;
        if (item[field].length > LIMITS[field]) return `${field} is over ${LIMITS[field]} characters`;
      }
      if (!CTAS.includes(item.cta)) return 'unknown cta';
      const text = `${item.headline} ${item.primaryText} ${item.description}`;
      const citation = checkCitations(item.citedFacts, facts);
      return claimProblem(text) ?? urlProblem(text, facts) ?? citation.problem ?? null;
    })();
    if (reason) { dropped.push({ reason }); continue; }
    variants.push({
      headline: item.headline.trim(),
      primaryText: item.primaryText.trim(),
      description: item.description.trim(),
      cta: item.cta,
      citedFacts: [...new Set(item.citedFacts)]
    });
  }
  if (variants.length === 0) return { ok: false, reason: 'no variant survived validation', dropped };

  const candidate = { variants, audience: parsed.audience, budget: parsed.budget, killRule: parsed.killRule };
  const check = validatePilotAdCampaign(candidate, { monthlyCeilingUsd });
  if (!check.valid) return { ok: false, reason: `invalid budget/kill rule: ${check.errors.join('; ')}`, dropped };
  return { ok: true, ...candidate, rationale: isNonEmptyString(parsed.rationale) ? parsed.rationale.trim() : '', dropped };
}

export async function draftPilotAdCopy({ instanceConfig, facts, monthlyCeilingUsd = DEFAULT_MONTHLY_CEILING_USD, llmClient } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) throw new Error(`${ROLE_NAME} requires a non-empty facts list`);
  const { provider, model, call } = resolveRoleProvider(instanceConfig, ROLE_NAME);
  const response = await (llmClient ?? call)({
    systemPrompt: buildSystemPrompt({ monthlyCeilingUsd }),
    userPrompt: JSON.stringify({ facts }, null, 2)
  });
  return { ...validateAdCopy(response?.text, { facts, monthlyCeilingUsd }), provider, model };
}

export { ROLE_NAME, buildSystemPrompt, LIMITS };
