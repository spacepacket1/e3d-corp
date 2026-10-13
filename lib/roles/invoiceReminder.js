import { resolveProvider } from '../llm/registry.js';

const ROLE_NAME = 'finance.invoiceReminder';
const MAX_SUBJECT_CHARS = 120;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Unlike x.engagementReply, there's no fabrication risk to guard against here
// in the same way - the invoice itself (amount, due date, days overdue) is
// the complete, already-real fact set, not a single data point the model
// could be tempted to pad out. The prompt still draws an explicit line
// against inventing late fees or collections-action threats, since those are
// business-policy decisions no model should make unilaterally for someone
// else's customer relationship.
function buildSystemPrompt() {
  return [
    'You are drafting a payment reminder email for a human at an HVAC business to review and send to their own customer - you are not sending it yourself.',
    'You are given one real, overdue invoice: the customer name, invoice number, amount still owed, due date, and days overdue. These are the only facts - never invent a late fee, a different amount, a threat, or any collections/legal action the business hasn\'t stated it takes.',
    'Write a short, polite, professional reminder. Assume this may be the first reminder the customer has received - friendly and matter-of-fact, never accusatory or threatening.',
    'Respond with ONLY a JSON object, no markdown, no commentary, matching exactly this shape: {"subject": string, "body": string}',
    `"subject" must be ${MAX_SUBJECT_CHARS} characters or fewer.`,
    '"body" is plain text (no HTML), a few sentences, ready to send as-is or with light edits.'
  ].join('\n');
}

function buildUserPrompt({ invoice, daysOverdue }) {
  return JSON.stringify(
    {
      customer_name: invoice.customerName,
      invoice_number: invoice.docNumber,
      amount_due: invoice.balance,
      currency: invoice.currency,
      due_date: invoice.dueDate,
      days_overdue: daysOverdue
    },
    null,
    2
  );
}

function sanitizeDraft(rawText) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
  if (trimmed === '') return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isNonEmptyString(parsed?.subject) || !isNonEmptyString(parsed?.body)) return null;
  return { subject: parsed.subject.trim().slice(0, MAX_SUBJECT_CHARS), body: parsed.body.trim() };
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) return providerConfig.trim();
  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

// Authority level 0: pure drafting, no state write, no Proposal, same as
// x.engagementReply - the decision to actually queue (and later, to send) the
// reminder lives entirely in the caller.
export async function draftInvoiceReminder({ instanceConfig, invoice, daysOverdue, llmClient } = {}) {
  if (!invoice || typeof invoice !== 'object' || !isNonEmptyString(invoice.customerName)) {
    throw new Error(`${ROLE_NAME} requires an invoice object with a customerName`);
  }
  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error(`${ROLE_NAME} requires llmClient to be a function when provided`);
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ invoice, daysOverdue });
  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const draft = sanitizeDraft(response?.text);

  return { draft, provider, model };
}

export { MAX_SUBJECT_CHARS, buildSystemPrompt, sanitizeDraft };
