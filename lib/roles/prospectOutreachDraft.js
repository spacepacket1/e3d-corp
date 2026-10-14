import { resolveProvider } from '../llm/registry.js';

const ROLE_NAME = 'sales.prospectOutreachDraft';

// The ICP/GTM doc's 15-day multichannel sequence. Day 2 (LinkedIn view or
// connect) is deliberately excluded - the doc describes it as a bare action
// ("create familiarity without a full pitch"), not a drafted message, so
// there is nothing for this role to produce for that day.
const DAY_CHANNEL = { 1: 'email', 4: 'email', 6: 'callScript', 8: 'loomScript', 11: 'email', 15: 'email' };
const VALID_DAYS = Object.keys(DAY_CHANNEL).map(Number);
const MAX_SUBJECT_CHARS = 120;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Each day's purpose and tone comes straight from the doc's own "Outreach
// Message Architecture" (observation -> implication -> credibility -> low-
// friction CTA) and "Loom Teardown Framework" - this role doesn't invent a
// new voice per day, it applies the doc's one voice to that day's job.
const DAY_GUIDANCE = {
  1: 'Day 1, first email. Lead with ONE specific, verifiable observation about this business (from the leak hypothesis), explain the implication briefly, state your role in one line without a company pitch, and end with a low-friction CTA (e.g. offering a short video walkthrough). This is the only day with no prior contact - do not reference an earlier message.',
  4: 'Day 4, second email, after no reply to Day 1. Add one new, useful implication or a small concrete test idea. Keep it short. Reference that you reached out previously without being pushy about the lack of reply.',
  6: 'Day 6, phone call. This is NOT a message to send - it is a short call opener / talking-points script for the human making the call, to validate the observed issue and reach the decision maker.',
  8: 'Day 8, a personalized Loom video. This is NOT a message to send - it is a script/outline for the human recording the video, following: 0:00-0:30 why you are reaching out, 0:30-2:30 show the specific issue, 2:30-3:30 the implication, 3:30-4:30 what you would test or change, 4:30-5:00 invite a 20-minute lead-journey review. Keep the whole thing under five minutes spoken.',
  11: 'Day 11, follow-up email after the Loom. Offer the 20-minute lead-journey discussion plainly, referencing the Loom briefly.',
  15: 'Day 15, close the loop. Make it easy to decline or revisit later - respectful, not a final hard pitch. After this, the sequence stops regardless of reply.'
};

function buildSystemPrompt(day) {
  return [
    'You are drafting one step of a multichannel outreach sequence to an HVAC or plumbing business, a sales prospect, for a human at Itera Works to review and send or use themselves - you are not sending or calling anyone yourself.',
    'You are given the business name and a leak hypothesis grounded in real research about this specific business. This is your only fact about them - never invent a different problem, a claim about their revenue, or a result/guarantee Itera has not stated.',
    'The sequence stops immediately if the prospect has already replied, opted out, or booked - assume none of that has happened, since you would not be asked to draft this step otherwise.',
    DAY_GUIDANCE[day],
    'Respond with ONLY a JSON object, no markdown, no commentary, matching exactly this shape: {"subject": string or null, "body": string}',
    `"subject" is required and must be ${MAX_SUBJECT_CHARS} characters or fewer for an email day, and must be null for a call-script or Loom-script day.`,
    'If the leak hypothesis is too vague or generic to credibly reference a specific issue, respond with ONLY the text: null'
  ].join('\n');
}

function buildUserPrompt({ business, brief, day }) {
  return JSON.stringify(
    {
      day,
      channel: DAY_CHANNEL[day],
      business_name: business.name,
      leak_hypothesis: brief.leakHypothesis,
      source_notes: brief.sourceNotes ?? []
    },
    null,
    2
  );
}

function sanitizeDraft(rawText, day) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isNonEmptyString(parsed?.body)) return null;

  const isEmailDay = DAY_CHANNEL[day] === 'email';
  if (isEmailDay) {
    if (!isNonEmptyString(parsed?.subject)) return null;
    return { subject: parsed.subject.trim().slice(0, MAX_SUBJECT_CHARS), body: parsed.body.trim() };
  }
  return { subject: null, body: parsed.body.trim() };
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) return providerConfig.trim();
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

// Authority level 0: pure drafting, no send, no call, no recording. The
// caller queues this for human review/use exactly like every other
// draft-and-queue role in this codebase.
export async function draftProspectOutreach({ instanceConfig, business, brief, day, llmClient } = {}) {
  if (!business || !isNonEmptyString(business.name)) {
    throw new Error(`${ROLE_NAME} requires a business object with a name`);
  }
  if (!brief || !isNonEmptyString(brief.leakHypothesis)) {
    throw new Error(`${ROLE_NAME} requires a brief object with a leakHypothesis`);
  }
  if (!VALID_DAYS.includes(day)) {
    throw new Error(`${ROLE_NAME} requires day to be one of: ${VALID_DAYS.join(', ')}`);
  }
  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }

  const systemPrompt = buildSystemPrompt(day);
  const userPrompt = buildUserPrompt({ business, brief, day });
  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const draft = sanitizeDraft(response?.text, day);

  return { draft, channel: DAY_CHANNEL[day], provider, model };
}

export { DAY_CHANNEL, VALID_DAYS, MAX_SUBJECT_CHARS, buildSystemPrompt, sanitizeDraft };
