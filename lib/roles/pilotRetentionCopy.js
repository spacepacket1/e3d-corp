import { resolveProvider } from '../llm/registry.js';
import { NUDGE_COHORTS, NUDGE_LIMITS, addressProblem } from '../proposals/pilotRetentionNudgeSchema.js';
import { clickbaitProblem } from './youtubeGrowthDraft.js';

const ROLE_NAME = 'pilot.retentionCopy';
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const COHORT_BRIEF = {
  outOfCredits: 'People who used all their credits and have not bought a pack.',
  nearAllowance: 'People on a plan who are close to their plan allowance for the period.',
  paymentFailed: 'People whose latest payment failed.',
  starterExpiringSoon: 'People whose free starter credits are about to expire and who have not used them up.'
};

function buildSystemPrompt() {
  return [
    'You draft a short retention email for customers of Pilot (pilot.e3d.ai), a service that runs one question past several AI models and returns their answers and disagreements. You draft; the owner reviews and approves before anything is sent.',
    'You are given a cohort name, a head-count and what the cohort means. You are NOT given and must NEVER write any email address, name, or personal detail. Write one message that suits everyone in the cohort. No placeholders that expect personal data other than a greeting like "Hi,".',
    'Be plain, specific and honest. Do not invent prices, discounts, deadlines, credit amounts, features or statistics: you were not given any. Do not promise anything the cohort description does not support. No hype, no urgency tricks, no ALL-CAPS, no stacked exclamation marks.',
    'The only link you may include is https://pilot.e3d.ai . Keep it short: a subject line and a body of at most a few short paragraphs, ending with one clear next step.',
    'Respond with ONLY a JSON object, no markdown fences: {"subject": string, "body": string}'
  ].join('\n');
}

function buildUserPrompt(context) {
  return JSON.stringify(context, null, 2);
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Hard rules on the model's output. A draft that breaks one is dropped with the reason, never edited and never posted.
export function validateNudgeCopy(raw) {
  const parsed = parseJson(raw);
  if (!parsed) return { ok: false, reason: 'the model did not return a JSON object' };
  const { subject, body } = parsed;
  if (!isNonEmptyString(subject) || !isNonEmptyString(body)) return { ok: false, reason: 'subject and body are both required' };
  if (subject.length > NUDGE_LIMITS.subject) return { ok: false, reason: `subject is over ${NUDGE_LIMITS.subject} characters` };
  if (body.length > NUDGE_LIMITS.body) return { ok: false, reason: `body is over ${NUDGE_LIMITS.body} characters` };
  for (const [name, text] of [['subject', subject], ['body', body]]) {
    const address = addressProblem(text);
    if (address) return { ok: false, reason: `${name} ${address}` };
    const bait = clickbaitProblem(text);
    if (bait) return { ok: false, reason: `${name} has ${bait}` };
  }
  return { ok: true, copy: { subject: subject.trim(), body: body.trim() } };
}

function providerName(config) {
  const value = config?.roles?.[ROLE_NAME]?.provider;
  if (isNonEmptyString(value)) return value.trim();
  if (Array.isArray(value) && isNonEmptyString(value[0])) return value[0].trim();
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

export async function draftRetentionCopy({ instanceConfig, cohort, count, llmClient } = {}) {
  if (!NUDGE_COHORTS.includes(cohort)) throw new Error(`${ROLE_NAME}: unknown cohort "${cohort}"`);
  const provider = providerName(instanceConfig);
  const { model, call } = resolveProvider(instanceConfig, provider);
  const started = Date.now();
  const response = await (llmClient ?? call)({ systemPrompt: buildSystemPrompt(), userPrompt: buildUserPrompt({ cohort, headCount: count, meaning: COHORT_BRIEF[cohort] }) });
  const result = validateNudgeCopy(response?.text);
  return { ...result, provider, model, usage: response?.usage ?? null, costUsd: response?.costUsd ?? null, latencyMs: Date.now() - started };
}

export { ROLE_NAME, buildSystemPrompt, buildUserPrompt };
