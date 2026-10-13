import assert from 'node:assert/strict';
import test from 'node:test';
import {
  draftLeadReplyTriage,
  MAX_SMS_REPLY_CHARS,
  sanitizeTriageResult,
  truncateKeepingUrls
} from '../lib/roles/leadReplyTriage.js';

const ORIGINAL_API_KEY = process.env.TEST_ANTHROPIC_API_KEY;
process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY ?? 'test-key';

test.after(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.TEST_ANTHROPIC_API_KEY;
  else process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});

function instanceConfig() {
  return {
    llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'TEST_ANTHROPIC_API_KEY' } } },
    roles: { 'sales.leadReplyTriage': { provider: 'claude' } }
  };
}

const SAMPLE_MESSAGE = {
  channel: 'sms',
  from: '+15551234567',
  receivedAt: '2026-10-13T18:00:00Z',
  text: 'What are your hours on Saturday?'
};

test('sanitizeTriageResult parses a well-formed auto-tier JSON response', () => {
  const result = sanitizeTriageResult(
    JSON.stringify({ tier: 'auto', reply: 'We are open 8am-2pm on Saturdays.', reason: 'Restates a known business fact.' }),
    'sms'
  );
  assert.deepEqual(result, {
    tier: 'auto',
    reply: 'We are open 8am-2pm on Saturdays.',
    reason: 'Restates a known business fact.'
  });
});

test('sanitizeTriageResult strips a markdown fence around the JSON', () => {
  const result = sanitizeTriageResult(
    '```json\n{"tier": "draft", "reply": "Happy to help, what time works?", "reason": "Scheduling request needs judgment."}\n```',
    'email'
  );
  assert.equal(result.tier, 'draft');
  assert.equal(result.reply, 'Happy to help, what time works?');
});

test('sanitizeTriageResult forces escalate with a null reply, even if the model included one', () => {
  const result = sanitizeTriageResult(
    JSON.stringify({ tier: 'escalate', reply: 'I can do $99 for that.', reason: 'Prospect is negotiating price.' }),
    'sms'
  );
  assert.equal(result.tier, 'escalate');
  assert.equal(result.reply, null);
  assert.equal(result.reason, 'Prospect is negotiating price.');
});

test('sanitizeTriageResult defaults to escalate on invalid JSON rather than guessing', () => {
  const result = sanitizeTriageResult('not json at all', 'sms');
  assert.equal(result.tier, 'escalate');
  assert.equal(result.reply, null);
});

test('sanitizeTriageResult defaults to escalate on an unrecognized tier value', () => {
  const result = sanitizeTriageResult(JSON.stringify({ tier: 'auto-send', reply: 'x', reason: 'y' }), 'sms');
  assert.equal(result.tier, 'escalate');
  assert.equal(result.reply, null);
});

test('sanitizeTriageResult defaults to escalate when reason is missing', () => {
  const result = sanitizeTriageResult(JSON.stringify({ tier: 'auto', reply: 'x' }), 'sms');
  assert.equal(result.tier, 'escalate');
});

test('sanitizeTriageResult truncates an sms reply without cutting a URL in half', () => {
  const url = 'https://booking.example.com/slot/abcdef1234567890';
  const longReply = `${'x'.repeat(MAX_SMS_REPLY_CHARS - 10)} ${url}`;
  const result = sanitizeTriageResult(JSON.stringify({ tier: 'draft', reply: longReply, reason: 'long reply' }), 'sms');
  // The URL must be either fully intact or entirely absent - never a partial fragment.
  const containsFullUrl = result.reply.includes(url);
  const containsNoUrlFragment = !result.reply.includes('https://');
  assert.ok(containsFullUrl || containsNoUrlFragment);
  assert.ok(result.reply.length <= MAX_SMS_REPLY_CHARS);
});

test('sanitizeTriageResult does not truncate an email reply', () => {
  const longReply = 'x'.repeat(MAX_SMS_REPLY_CHARS + 200);
  const result = sanitizeTriageResult(JSON.stringify({ tier: 'draft', reply: longReply, reason: 'long reply' }), 'email');
  assert.equal(result.reply.length, MAX_SMS_REPLY_CHARS + 200);
});

test('truncateKeepingUrls cuts before a straddled URL rather than through it', () => {
  const url = 'https://e3d.ai/stories/abc123';
  const text = `${'a'.repeat(20)} ${url}`;
  const result = truncateKeepingUrls(text, 25);
  assert.ok(!result.includes('http'));
});

test('draftLeadReplyTriage returns the sanitized triage result and passes real message facts to the model', async () => {
  let capturedUserPrompt = null;
  const result = await draftLeadReplyTriage({
    instanceConfig: instanceConfig(),
    message: SAMPLE_MESSAGE,
    context: { businessFacts: { hours: 'Mon-Fri 8-5, Sat 8-2' }, lead: { name: 'Pat' }, conversationHistory: [] },
    llmClient: async ({ userPrompt }) => {
      capturedUserPrompt = userPrompt;
      return { text: JSON.stringify({ tier: 'auto', reply: 'We are open 8am-2pm Saturdays!', reason: 'Known fact.' }) };
    }
  });

  assert.equal(result.tier, 'auto');
  assert.equal(result.reply, 'We are open 8am-2pm Saturdays!');
  assert.equal(result.provider, 'claude');

  const parsed = JSON.parse(capturedUserPrompt);
  assert.equal(parsed.message_text, 'What are your hours on Saturday?');
  assert.equal(parsed.channel, 'sms');
  assert.deepEqual(parsed.lead, { name: 'Pat' });
});

test('draftLeadReplyTriage requires a message with non-empty text', async () => {
  await assert.rejects(
    draftLeadReplyTriage({
      instanceConfig: instanceConfig(),
      message: { channel: 'sms' },
      llmClient: async () => ({ text: 'x' })
    }),
    /requires a message object with non-empty text/
  );
});

test('draftLeadReplyTriage requires message.channel', async () => {
  await assert.rejects(
    draftLeadReplyTriage({
      instanceConfig: instanceConfig(),
      message: { text: 'hello' },
      llmClient: async () => ({ text: 'x' })
    }),
    /requires message\.channel/
  );
});

test('draftLeadReplyTriage throws when roles["sales.leadReplyTriage"].provider is missing', async () => {
  await assert.rejects(
    draftLeadReplyTriage({
      instanceConfig: { ...instanceConfig(), roles: {} },
      message: SAMPLE_MESSAGE,
      llmClient: async () => ({ text: 'x' })
    }),
    /missing roles\.sales\.leadReplyTriage\.provider/
  );
});

test('draftLeadReplyTriage defaults to escalate (not a throw) when the model responds with garbage', async () => {
  const result = await draftLeadReplyTriage({
    instanceConfig: instanceConfig(),
    message: SAMPLE_MESSAGE,
    llmClient: async () => ({ text: 'sorry, I cannot help with that' })
  });
  assert.equal(result.tier, 'escalate');
  assert.equal(result.reply, null);
});
