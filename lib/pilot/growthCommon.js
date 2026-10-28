import { resolveProvider } from '../llm/registry.js';

export const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

export function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function providerNameFor(instanceConfig, roleName) {
  const value = instanceConfig?.roles?.[roleName]?.provider;
  if (isNonEmptyString(value)) return value.trim();
  if (Array.isArray(value) && isNonEmptyString(value[0])) return value[0].trim();
  throw new Error(`Instance config is missing roles.${roleName}.provider`);
}

export function resolveRoleProvider(instanceConfig, roleName) {
  const provider = providerNameFor(instanceConfig, roleName);
  const { model, call } = resolveProvider(instanceConfig, provider);
  return { provider, model, call };
}

// Claims we never make for Pilot, whatever the model writes.
const FORBIDDEN = [
  [/multi-?llm/i, 'uses "multi-LLM" (wording rule is "multi-model")'],
  [/\b(guarantee[sd]?|always right|never wrong|100% accurate)\b/i, 'overclaims accuracy'],
  [/\b(live|available|listed|launched)\s+(in|on)\s+(the\s+)?(chatgpt|gpt)\b/i, 'claims the ChatGPT plugin is live (it is in review)'],
  [/\b(you won'?t believe|shocking|mind[- ]?blowing|insane)\b/i, 'clickbait phrasing'],
  [/!{2,}/, 'stacked exclamation marks']
];

export function claimProblem(text) {
  for (const [pattern, message] of FORBIDDEN) {
    if (pattern.test(text)) return message;
  }
  return null;
}

// Every cited id must be a fact we supplied; returns { ids } or { problem }.
export function checkCitations(cited, facts) {
  if (!Array.isArray(cited) || cited.length === 0) return { problem: 'cites no facts' };
  const known = new Set(facts.map((fact) => fact.id));
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length) return { problem: `cites unknown fact id(s): ${unknown.join(', ')}` };
  return { ids: [...new Set(cited)] };
}

// URLs in generated text must come from the supplied facts (no invented links).
export function urlProblem(text, facts) {
  const haystack = facts.map((fact) => `${fact.text} ${fact.source ?? ''}`).join(' ');
  for (const url of text.match(/https?:\/\/[^\s)>\]]+/g) ?? []) {
    if (!haystack.includes(url.replace(/[.,;:]+$/, ''))) return `contains a URL not in the supplied facts: ${url}`;
  }
  return null;
}
