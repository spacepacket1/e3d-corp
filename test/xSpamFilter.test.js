import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelySpam, hasEnoughEngagement, DEFAULT_MIN_ENGAGEMENT } from '../lib/research/xSpamFilter.js';

test('isLikelySpam flags reply_settings other than "everyone"', () => {
  const result = isLikelySpam({ text: 'genuine question about on-chain analytics', reply_settings: 'mentionedUsers' });
  assert.equal(result.spam, true);
  assert.match(result.reason, /reply_settings/);
});

test('isLikelySpam flags known spam keywords', () => {
  const result = isLikelySpam({ text: 'huge airdrop coming, whitelist now!', reply_settings: 'everyone' });
  assert.equal(result.spam, true);
  assert.match(result.reason, /spam keyword/);
});

test('isLikelySpam flags more than 2 links', () => {
  const text = 'check these out https://a.com https://b.com https://c.com';
  const result = isLikelySpam({ text, reply_settings: 'everyone' });
  assert.equal(result.spam, true);
  assert.match(result.reason, /links exceeds max/);
});

test('isLikelySpam passes a genuine, link-light post', () => {
  const result = isLikelySpam({ text: 'what tools do people use for wallet analytics?', reply_settings: 'everyone' });
  assert.equal(result.spam, false);
});

test('hasEnoughEngagement rejects a tweet with no public_metrics at all', () => {
  const result = hasEnoughEngagement({ text: 'hi' });
  assert.equal(result.enough, false);
  assert.match(result.reason, /no public_metrics/);
});

test('hasEnoughEngagement rejects a thin, bot-feeling post below the default floor', () => {
  const result = hasEnoughEngagement({ public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0, quote_count: 1 } });
  assert.equal(result.enough, false);
  assert.match(result.reason, new RegExp(`below the minimum of ${DEFAULT_MIN_ENGAGEMENT}`));
});

test('hasEnoughEngagement accepts a post with real engagement, summed across all four metrics', () => {
  const result = hasEnoughEngagement({ public_metrics: { like_count: 2, retweet_count: 1, reply_count: 2, quote_count: 0 } });
  assert.equal(result.enough, true);
  assert.equal(result.total, 5);
});

test('hasEnoughEngagement honors a configured minEngagement override', () => {
  const tweet = { public_metrics: { like_count: 2, retweet_count: 0, reply_count: 0, quote_count: 0 } };
  assert.equal(hasEnoughEngagement(tweet, 1).enough, true);
  assert.equal(hasEnoughEngagement(tweet, 10).enough, false);
});
