import assert from 'node:assert/strict';
import test from 'node:test';
import { isLikelySpam } from '../lib/research/xSpamFilter.js';

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
