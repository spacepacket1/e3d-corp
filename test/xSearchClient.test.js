import assert from 'node:assert/strict';
import test from 'node:test';
import { searchRecentTweets } from '../lib/research/xSearchClient.js';

function okJsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

test('searchRecentTweets is unavailable without a bearer token', async () => {
  const result = await searchRecentTweets({ query: '"on-chain signals" -is:retweet lang:en' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /bearer token/);
});

test('searchRecentTweets returns tweets on a successful call', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    return okJsonResponse({ data: [{ id: '1', text: 'what tools exist for wallet analytics?', author_id: '42', reply_settings: 'everyone' }] });
  };

  const result = await searchRecentTweets({ bearerToken: 'app-token', query: '"wallet analytics" -is:retweet lang:en', fetchImpl });
  assert.equal(result.status, 'ok');
  assert.equal(result.tweets.length, 1);
  assert.match(calls[0], /tweets\/search\/recent/);
});

test('searchRecentTweets degrades gracefully on a 403 (wrong API tier)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  const result = await searchRecentTweets({ bearerToken: 'app-token', query: 'anything', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /API tier/);
});

test('searchRecentTweets degrades gracefully on a 429 (rate limit)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429 });
  const result = await searchRecentTweets({ bearerToken: 'app-token', query: 'anything', fetchImpl });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /rate-limited/);
});
