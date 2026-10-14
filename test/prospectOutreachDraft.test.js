import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProspectOutreach, DAY_CHANNEL, MAX_SUBJECT_CHARS, sanitizeDraft } from '../lib/roles/prospectOutreachDraft.js';

const ORIGINAL_API_KEY = process.env.TEST_ANTHROPIC_API_KEY;
process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY ?? 'test-key';

test.after(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.TEST_ANTHROPIC_API_KEY;
  else process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});

function instanceConfig() {
  return {
    llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'TEST_ANTHROPIC_API_KEY' } } },
    roles: { 'sales.prospectOutreachDraft': { provider: 'claude' } }
  };
}

const SAMPLE_BUSINESS = { name: 'Acme HVAC' };
const SAMPLE_BRIEF = { leakHypothesis: 'No online scheduling likely loses after-hours inquiries.', sourceNotes: ['phone only, no scheduling link'] };

test('sanitizeDraft requires a subject on an email day and trims it to the cap', () => {
  const longSubject = 'x'.repeat(MAX_SUBJECT_CHARS + 20);
  const result = sanitizeDraft(JSON.stringify({ subject: longSubject, body: 'Hi there' }), 1);
  assert.equal(result.subject.length, MAX_SUBJECT_CHARS);
  assert.equal(result.body, 'Hi there');
});

test('sanitizeDraft forces subject to null on a call-script day even if the model included one', () => {
  const result = sanitizeDraft(JSON.stringify({ subject: 'ignored', body: 'Ask about their after-hours process.' }), 6);
  assert.equal(result.subject, null);
  assert.equal(result.body, 'Ask about their after-hours process.');
});

test('sanitizeDraft returns null on an email day with no subject', () => {
  assert.equal(sanitizeDraft(JSON.stringify({ body: 'Hi there' }), 1), null);
});

test('sanitizeDraft returns null for invalid JSON rather than guessing', () => {
  assert.equal(sanitizeDraft('not json', 1), null);
});

test('sanitizeDraft returns null for a literal "null" response (model declining)', () => {
  assert.equal(sanitizeDraft('null', 1), null);
});

test('DAY_CHANNEL excludes day 2 (LinkedIn view/connect has no drafted content)', () => {
  assert.equal(DAY_CHANNEL[2], undefined);
});

test('draftProspectOutreach drafts an email for day 1 and passes the leak hypothesis to the model', async () => {
  let capturedUserPrompt = null;
  const result = await draftProspectOutreach({
    instanceConfig: instanceConfig(),
    business: SAMPLE_BUSINESS,
    brief: SAMPLE_BRIEF,
    day: 1,
    llmClient: async ({ userPrompt }) => {
      capturedUserPrompt = userPrompt;
      return { text: JSON.stringify({ subject: 'Quick question about after-hours calls', body: 'Hi, noticed...' }) };
    }
  });

  assert.equal(result.channel, 'email');
  assert.equal(result.draft.subject, 'Quick question about after-hours calls');
  const parsed = JSON.parse(capturedUserPrompt);
  assert.equal(parsed.leak_hypothesis, SAMPLE_BRIEF.leakHypothesis);
  assert.equal(parsed.business_name, 'Acme HVAC');
});

test('draftProspectOutreach drafts a call script for day 6 with no subject', async () => {
  const result = await draftProspectOutreach({
    instanceConfig: instanceConfig(),
    business: SAMPLE_BUSINESS,
    brief: SAMPLE_BRIEF,
    day: 6,
    llmClient: async () => ({ text: JSON.stringify({ body: 'Open by validating the after-hours gap, then ask for the decision maker.' }) })
  });
  assert.equal(result.channel, 'callScript');
  assert.equal(result.draft.subject, null);
});

test('draftProspectOutreach rejects an invalid day', async () => {
  await assert.rejects(
    draftProspectOutreach({
      instanceConfig: instanceConfig(),
      business: SAMPLE_BUSINESS,
      brief: SAMPLE_BRIEF,
      day: 2,
      llmClient: async () => ({ text: 'x' })
    }),
    /requires day to be one of/
  );
});

test('draftProspectOutreach requires a brief with a leakHypothesis', async () => {
  await assert.rejects(
    draftProspectOutreach({
      instanceConfig: instanceConfig(),
      business: SAMPLE_BUSINESS,
      brief: {},
      day: 1,
      llmClient: async () => ({ text: 'x' })
    }),
    /requires a brief object with a leakHypothesis/
  );
});

test('draftProspectOutreach returns a null draft (not a throw) when the model declines', async () => {
  const result = await draftProspectOutreach({
    instanceConfig: instanceConfig(),
    business: SAMPLE_BUSINESS,
    brief: SAMPLE_BRIEF,
    day: 1,
    llmClient: async () => ({ text: 'null' })
  });
  assert.equal(result.draft, null);
});
