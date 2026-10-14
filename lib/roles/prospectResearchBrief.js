import { resolveProvider } from '../llm/registry.js';
import { NUMERIC_SIGNAL_KEYS, BOOLEAN_SIGNAL_KEYS } from '../research/icpScoring.js';

const ROLE_NAME = 'sales.prospectResearchBrief';
const SIGNAL_KEYS = [...NUMERIC_SIGNAL_KEYS, ...BOOLEAN_SIGNAL_KEYS];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// "Research summaries" from the ICP/GTM doc's automate-now list: turns raw,
// already-gathered material (website text, Google Business Profile listing,
// ad-activity notes, review summary - gathering those is the caller's job,
// same division of labor as quickbooksInvoices.js fetching real invoices
// before invoiceReminder.js ever sees them) into the exact signal shape
// icpScoring.js scores, plus a leak hypothesis a human reviews before any
// outreach goes out. The doc is explicit that inferred fields must be
// labeled and verified at discovery, not silently treated as confirmed -
// that's estimatedFields below, not a score penalty.
function buildSystemPrompt() {
  return [
    'You are producing a research brief on one HVAC or plumbing business, a candidate sales prospect, for a human to review before any outreach is sent.',
    'You are given raw material already gathered about this business: website text, its Google Business Profile listing, notes on visible advertising, and/or review data. These are the only facts - never invent a detail not supported by what you were given.',
    `For each of these signals, extract a value ONLY if the material supports it; otherwise use null. Numeric signals: ${NUMERIC_SIGNAL_KEYS.join(', ')}. Boolean signals (true/false only, never a string): ${BOOLEAN_SIGNAL_KEYS.join(', ')}.`,
    'A signal is "estimated" when you inferred it indirectly (e.g. guessing employee count from a team photo) rather than reading it directly (e.g. an explicit "founded in 2010" on an About page). List every estimated signal\'s key in estimatedFields.',
    'leakHypothesis is one or two sentences naming the single most plausible, specific revenue leak this business has between generating a lead and completing a sale - grounded in what you actually observed, not a generic template leak.',
    'sourceNotes is a short list of strings, each citing what a specific finding was based on (e.g. "website has no visible hours or scheduling link" or "Google Business Profile shows 4.2 stars, 11 reviews, last reply 8 months ago").',
    'Respond with ONLY a JSON object, no markdown, no commentary, matching exactly this shape: {"leakHypothesis": string, "signals": {<the signal keys above>: number|boolean|null}, "estimatedFields": string[], "sourceNotes": string[]}'
  ].join('\n');
}

function buildUserPrompt({ business, rawResearch }) {
  return JSON.stringify({ business, raw_research: rawResearch }, null, 2);
}

function sanitizeSignals(rawSignals) {
  const signals = {};
  for (const key of NUMERIC_SIGNAL_KEYS) {
    const value = rawSignals?.[key];
    signals[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  for (const key of BOOLEAN_SIGNAL_KEYS) {
    const value = rawSignals?.[key];
    signals[key] = typeof value === 'boolean' ? value : null;
  }
  return signals;
}

function sanitizeBrief(rawText) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  if (trimmed === '') return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isNonEmptyString(parsed?.leakHypothesis)) return null;

  const estimatedFields = Array.isArray(parsed?.estimatedFields)
    ? parsed.estimatedFields.filter((key) => SIGNAL_KEYS.includes(key))
    : [];
  const sourceNotes = Array.isArray(parsed?.sourceNotes) ? parsed.sourceNotes.filter(isNonEmptyString) : [];

  return {
    leakHypothesis: parsed.leakHypothesis.trim(),
    signals: sanitizeSignals(parsed?.signals),
    estimatedFields,
    sourceNotes
  };
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) return providerConfig.trim();
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

// Authority level 0: pure drafting. The caller decides whether/how to use
// the brief (e.g. feeding `signals` into scoreIcpFit) - this role never
// writes state or scores anything itself.
export async function draftProspectResearchBrief({ instanceConfig, business, rawResearch, llmClient } = {}) {
  if (!business || !isNonEmptyString(business.name)) {
    throw new Error(`${ROLE_NAME} requires a business object with a name`);
  }
  if (!rawResearch || typeof rawResearch !== 'object') {
    throw new Error(`${ROLE_NAME} requires a rawResearch object`);
  }
  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ business, rawResearch });
  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const brief = sanitizeBrief(response?.text);

  return { brief, provider, model };
}

export { SIGNAL_KEYS, buildSystemPrompt, sanitizeBrief };
