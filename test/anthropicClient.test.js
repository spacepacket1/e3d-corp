import assert from 'node:assert/strict';
import test from 'node:test';
import { callAnthropicLlm, resolveAnthropicSettings, DEFAULT_ANTHROPIC_MODEL } from '../lib/llm/anthropicClient.js';

const ORIGINAL_KEY = process.env.TEST_ANTHROPIC_KEY;
const ORIGINAL_MODEL = process.env.TEST_ANTHROPIC_MODEL;

test.after(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.TEST_ANTHROPIC_KEY;
  else process.env.TEST_ANTHROPIC_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODEL === undefined) delete process.env.TEST_ANTHROPIC_MODEL;
  else process.env.TEST_ANTHROPIC_MODEL = ORIGINAL_MODEL;
});

test('resolveAnthropicSettings requires apiKeyEnvVar in the provider config', () => {
  assert.throws(() => resolveAnthropicSettings({}), /missing apiKeyEnvVar/);
});

test('resolveAnthropicSettings requires the referenced env var to be set', () => {
  delete process.env.TEST_ANTHROPIC_KEY;
  assert.throws(() => resolveAnthropicSettings({ apiKeyEnvVar: 'TEST_ANTHROPIC_KEY' }), /TEST_ANTHROPIC_KEY.*not set/);
});

test('resolveAnthropicSettings falls back to the default model when modelEnvVar is unset', () => {
  process.env.TEST_ANTHROPIC_KEY = 'sk-test';
  const settings = resolveAnthropicSettings({ apiKeyEnvVar: 'TEST_ANTHROPIC_KEY' });
  assert.equal(settings.apiKey, 'sk-test');
  assert.equal(settings.model, DEFAULT_ANTHROPIC_MODEL);
});

test('resolveAnthropicSettings honors modelEnvVar when set', () => {
  process.env.TEST_ANTHROPIC_KEY = 'sk-test';
  process.env.TEST_ANTHROPIC_MODEL = 'claude-haiku-5-5';
  const settings = resolveAnthropicSettings({ apiKeyEnvVar: 'TEST_ANTHROPIC_KEY', modelEnvVar: 'TEST_ANTHROPIC_MODEL' });
  assert.equal(settings.model, 'claude-haiku-5-5');
});

test('callAnthropicLlm sends the Messages API shape and parses the text block', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url.toString(), headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { content: [{ type: 'text', text: 'hello from claude' }], usage: { input_tokens: 10, output_tokens: 4 } };
      }
    };
  };

  const result = await callAnthropicLlm({
    apiKey: 'sk-test',
    model: 'claude-sonnet-5-5',
    systemPrompt: 'be concise',
    userPrompt: 'say hi',
    fetchImpl
  });

  assert.equal(result.text, 'hello from claude');
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].body.system, 'be concise');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'say hi' }]);
});

test('callAnthropicLlm throws with the response body on a non-2xx status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async text() { return '{"error":"invalid x-api-key"}'; } });
  await assert.rejects(
    callAnthropicLlm({ apiKey: 'bad', model: 'claude-sonnet-5-5', systemPrompt: 's', userPrompt: 'u', fetchImpl }),
    /HTTP 401/
  );
});

test('callAnthropicLlm throws when the response has no text content block', async () => {
  const fetchImpl = async () => ({ ok: true, async json() { return { content: [] }; } });
  await assert.rejects(
    callAnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', systemPrompt: 's', userPrompt: 'u', fetchImpl }),
    /did not include text content/
  );
});
