import assert from 'node:assert/strict';
import test from 'node:test';
import { draftEngagementReply, MAX_REPLY_CHARS } from '../lib/roles/xEngagementReply.js';

const ORIGINAL_ENV = {
  X_REPLY_LLM_BASE_URL: process.env.X_REPLY_LLM_BASE_URL,
  X_REPLY_LLM_MODEL: process.env.X_REPLY_LLM_MODEL
};
process.env.X_REPLY_LLM_BASE_URL = process.env.X_REPLY_LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.X_REPLY_LLM_MODEL = process.env.X_REPLY_LLM_MODEL ?? 'x-reply-model-local';

test.after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function instanceConfig() {
  return {
    name: 'FutCo',
    llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'X_REPLY_LLM_BASE_URL', modelEnvVar: 'X_REPLY_LLM_MODEL' } } },
    roles: { 'x.engagementReply': { provider: 'local' } }
  };
}

const SAMPLE_FINDINGS = [{ source: 'e3d.ai search_stories', text: 'WALLETX: cluster of 40 wallets rotated into the same token within an hour' }];

test('draftEngagementReply returns the sanitized model reply, trimmed to the char cap', async () => {
  const longReply = 'a'.repeat(MAX_REPLY_CHARS + 50);
  const result = await draftEngagementReply({
    instanceConfig: instanceConfig(),
    postText: 'what tools do people use for on-chain wallet analytics?',
    topic: 'on-chain wallet and address analytics',
    findings: SAMPLE_FINDINGS,
    llmClient: async () => ({ text: longReply })
  });
  assert.equal(result.reply.length, MAX_REPLY_CHARS);
  assert.equal(result.provider, 'local');
});

test('draftEngagementReply returns null when the model declines (spam/off-topic)', async () => {
  const result = await draftEngagementReply({
    instanceConfig: instanceConfig(),
    postText: 'buy my meme coin now, 100x guaranteed',
    topic: null,
    findings: SAMPLE_FINDINGS,
    llmClient: async () => ({ text: 'null' })
  });
  assert.equal(result.reply, null);
});

test('draftEngagementReply returns null and never calls the model when there is no finding', async () => {
  let called = false;
  const result = await draftEngagementReply({
    instanceConfig: instanceConfig(),
    postText: 'what tools do people use for on-chain wallet analytics?',
    findings: [],
    llmClient: async () => {
      called = true;
      return { text: 'should not be used' };
    }
  });
  assert.equal(result.reply, null);
  assert.equal(called, false);
  assert.match(result.reason, /no concrete e3d\.ai finding/);
});

test('draftEngagementReply strips a markdown fence and surrounding whitespace', async () => {
  const result = await draftEngagementReply({
    instanceConfig: instanceConfig(),
    postText: 'on-chain analytics is interesting',
    findings: SAMPLE_FINDINGS,
    llmClient: async () => ({ text: '```\n  Worth checking how wallet clustering actually works under the hood.  \n```' })
  });
  assert.equal(result.reply, 'Worth checking how wallet clustering actually works under the hood.');
});

test('draftEngagementReply requires non-empty postText', async () => {
  await assert.rejects(
    draftEngagementReply({
      instanceConfig: instanceConfig(),
      postText: '',
      findings: SAMPLE_FINDINGS,
      llmClient: async () => ({ text: 'x' })
    }),
    /non-empty postText/
  );
});

test('draftEngagementReply throws when roles["x.engagementReply"].provider is missing', async () => {
  await assert.rejects(
    draftEngagementReply({
      instanceConfig: { ...instanceConfig(), roles: {} },
      postText: 'on-chain analytics',
      llmClient: async () => ({ text: 'x' })
    }),
    /missing roles\.x\.engagementReply\.provider/
  );
});
