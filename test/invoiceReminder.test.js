import assert from 'node:assert/strict';
import test from 'node:test';
import { draftInvoiceReminder, MAX_SUBJECT_CHARS, sanitizeDraft } from '../lib/roles/invoiceReminder.js';

const ORIGINAL_API_KEY = process.env.TEST_ANTHROPIC_API_KEY;
process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY ?? 'test-key';

test.after(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.TEST_ANTHROPIC_API_KEY;
  else process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});

function instanceConfig() {
  return {
    llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'TEST_ANTHROPIC_API_KEY' } } },
    roles: { 'finance.invoiceReminder': { provider: 'claude' } }
  };
}

const SAMPLE_INVOICE = {
  id: '67',
  docNumber: '1021',
  customerName: "Amy's Bird Sanctuary",
  balance: 239,
  currency: 'USD',
  dueDate: '2026-09-25'
};

test('sanitizeDraft parses a well-formed JSON draft and trims the subject to the cap', () => {
  const longSubject = 'x'.repeat(MAX_SUBJECT_CHARS + 20);
  const result = sanitizeDraft(JSON.stringify({ subject: longSubject, body: 'Please find attached...' }));
  assert.equal(result.subject.length, MAX_SUBJECT_CHARS);
  assert.equal(result.body, 'Please find attached...');
});

test('sanitizeDraft strips a markdown fence around the JSON', () => {
  const result = sanitizeDraft('```json\n{"subject": "Payment reminder", "body": "Hi there"}\n```');
  assert.deepEqual(result, { subject: 'Payment reminder', body: 'Hi there' });
});

test('sanitizeDraft returns null for invalid JSON rather than guessing', () => {
  assert.equal(sanitizeDraft('not json at all'), null);
});

test('sanitizeDraft returns null when subject or body is missing', () => {
  assert.equal(sanitizeDraft(JSON.stringify({ subject: 'only a subject' })), null);
  assert.equal(sanitizeDraft(JSON.stringify({ body: 'only a body' })), null);
});

test('draftInvoiceReminder returns the sanitized draft and passes the real invoice facts to the model', async () => {
  let capturedUserPrompt = null;
  const result = await draftInvoiceReminder({
    instanceConfig: instanceConfig(),
    invoice: SAMPLE_INVOICE,
    daysOverdue: 18,
    llmClient: async ({ userPrompt }) => {
      capturedUserPrompt = userPrompt;
      return { text: JSON.stringify({ subject: 'Invoice 1021 is overdue', body: 'Hi, just a friendly reminder...' }) };
    }
  });

  assert.deepEqual(result.draft, { subject: 'Invoice 1021 is overdue', body: 'Hi, just a friendly reminder...' });
  assert.equal(result.provider, 'claude');

  const parsed = JSON.parse(capturedUserPrompt);
  assert.equal(parsed.customer_name, "Amy's Bird Sanctuary");
  assert.equal(parsed.invoice_number, '1021');
  assert.equal(parsed.amount_due, 239);
  assert.equal(parsed.days_overdue, 18);
});

test('draftInvoiceReminder returns a null draft (not a throw) when the model responds with garbage', async () => {
  const result = await draftInvoiceReminder({
    instanceConfig: instanceConfig(),
    invoice: SAMPLE_INVOICE,
    daysOverdue: 5,
    llmClient: async () => ({ text: 'sorry, I cannot help with that' })
  });
  assert.equal(result.draft, null);
});

test('draftInvoiceReminder requires an invoice with a customerName', async () => {
  await assert.rejects(
    draftInvoiceReminder({
      instanceConfig: instanceConfig(),
      invoice: { docNumber: '1021' },
      llmClient: async () => ({ text: 'x' })
    }),
    /requires an invoice object with a customerName/
  );
});

test('draftInvoiceReminder throws when roles["finance.invoiceReminder"].provider is missing', async () => {
  await assert.rejects(
    draftInvoiceReminder({
      instanceConfig: { ...instanceConfig(), roles: {} },
      invoice: SAMPLE_INVOICE,
      llmClient: async () => ({ text: 'x' })
    }),
    /missing roles\.finance\.invoiceReminder\.provider/
  );
});
