import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPostRelevance } from '../lib/research/jevRelevance.js';

const ORIGINAL_KEY = process.env.TYPESAFE_API_KEY;

test.after(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = ORIGINAL_KEY;
});

function jsonResponse(body) {
  return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
}

test('checkPostRelevance fails closed (relevant:false) when TYPESAFE_API_KEY is not set', async () => {
  delete process.env.TYPESAFE_API_KEY;
  const result = await checkPostRelevance({ text: 'on-chain analytics is great', topics: ['on-chain analytics'] });
  assert.equal(result.checked, false);
  assert.equal(result.relevant, false);
  assert.match(result.reason, /TYPESAFE_API_KEY/);
});

test('checkPostRelevance fails closed when no topics are configured', async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  const result = await checkPostRelevance({ text: 'hello', topics: [] });
  assert.equal(result.checked, false);
  assert.equal(result.relevant, false);
  assert.match(result.reason, /no topics configured/);
});

test('checkPostRelevance returns relevant:true with the matched topic on a real Choice match', async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url.toString(), body: JSON.parse(init.body) });
    return jsonResponse({ answers: { topic_match: { choice: 'topic_0', confidence: 'high' } } });
  };

  const result = await checkPostRelevance({
    text: 'what on-chain tools do people use for wallet analytics?',
    topics: ['on-chain wallet and address analytics', 'AI trading agents'],
    fetchImpl
  });

  assert.equal(result.checked, true);
  assert.equal(result.relevant, true);
  assert.equal(result.matchedTopic, 'topic_0');
  assert.equal(result.confidence, 'high');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.questions.topic_match.criteria.topic_0, 'on-chain wallet and address analytics');
  assert.ok('none' in calls[0].body.questions.topic_match.criteria);
});

test('checkPostRelevance returns relevant:false when Jev picks "none"', async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  const fetchImpl = async () => jsonResponse({ answers: { topic_match: { choice: 'none' } } });
  const result = await checkPostRelevance({ text: 'buy my meme coin now', topics: ['on-chain analytics'], fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.relevant, false);
});

test('checkPostRelevance fails closed on a Jev HTTP error rather than guessing relevant', async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'upstream error' });
  const result = await checkPostRelevance({ text: 'on-chain analytics', topics: ['on-chain analytics'], fetchImpl });
  assert.equal(result.checked, false);
  assert.equal(result.relevant, false);
  assert.match(result.reason, /Jev call failed/);
});
