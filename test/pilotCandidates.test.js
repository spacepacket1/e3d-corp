import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCandidates, recentCandidates, scoreCandidate, eligible, dedupe, DEFAULT_MIN_REACH } from '../lib/research/pilotCandidates.js';
import { collectBrief, renderText, renderHtml } from '../ops/reports/pilotBrief.js';

const NOW = new Date('2026-11-08T15:00:00Z');
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fakeFetch = (log = []) => async (url) => {
  const u = String(url); log.push(u);
  if (u.includes('/2/tweets/search/recent')) return ok({ data: [
    { id: 't1', author_id: 'u1', text: 'I built an MCP agent', public_metrics: { like_count: 90, retweet_count: 10, reply_count: 5 } },
    { id: 't2', author_id: 'u2', text: 'tiny account post', public_metrics: {} },
    { id: 't3', author_id: 'u3', text: 'free airdrop agent', public_metrics: {} }],
    includes: { users: [
      { id: 'u1', username: 'builder', name: 'Builder', description: 'shipping agents', public_metrics: { followers_count: 42000 } },
      { id: 'u2', username: 'tiny', name: 'Tiny', description: '', public_metrics: { followers_count: 80 } },
      { id: 'u3', username: 'spam', name: 'Spam', description: 'AIRDROP signals DM me', public_metrics: { followers_count: 90000 } }] } });
  if (u.includes('googleapis.com/youtube/v3/search')) return ok({ items: [{ id: { videoId: 'v1' }, snippet: { channelId: 'c1', title: 'Claude Code &amp; MCP don&#39;t panic' } }] });
  if (u.includes('googleapis.com/youtube/v3/channels')) return ok({ items: [{ id: 'c1', snippet: { title: 'Dev Channel', customUrl: '@devchan', description: 'ai dev' }, statistics: { subscriberCount: '120000' } }] });
  if (u.includes('searchActors')) return ok({ actors: [{ did: 'did:1' }] });
  if (u.includes('getProfiles')) return ok({ profiles: [{ did: 'did:1', handle: 'a.bsky.social', displayName: 'A', followersCount: 3000, description: 'agents' }] });
  if (u.includes('api.github.com/search')) return ok({ items: [{ full_name: 'dev/mcp-thing', description: 'an mcp server', html_url: 'https://github.com/dev/mcp-thing', stargazers_count: 300, owner: { login: 'dev', type: 'User' } }, { full_name: 'org/x', owner: { login: 'org', type: 'Organization' } }] });
  if (u.includes('api.github.com/users/dev')) return ok({ login: 'dev', name: 'Dev', html_url: 'https://github.com/dev', followers: 1500, bio: 'builds agents' });
  if (u.includes('hn.algolia')) return ok({ hits: [{ author: 'hnuser', title: 'Show HN: agent thing', objectID: '9', points: 40 }] });
  if (u.includes('firebaseio')) return ok({ karma: 5000, about: 'hi <b>there</b>' });
  throw new Error('unexpected ' + u);
};
const env = { X_SEARCH_BEARER_TOKEN: 'b', YOUTUBE_API_KEY: 'k' };
const cfg = { research: { pilotCandidates: { queries: { x: ['q'], youtube: ['q'], bluesky: ['q'], github: ['q'], hackernews: ['q'] } } } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cand-'));

test('collects people from every source, drops tiny and spammy accounts and organisations, never repeats someone', async () => {
  const dataDir = tmp();
  try {
    const r1 = await collectCandidates({ instanceConfig: cfg, dataDir, now: NOW, env, fetchImpl: fakeFetch() });
    assert.deepEqual(r1.errors, []);
    assert.deepEqual(r1.added.map((c) => `${c.source}:${c.handle}`).sort(),
      ['bluesky:@a.bsky.social', 'github:dev', 'hackernews:hnuser', 'x:@builder', 'youtube:@devchan']);
    assert.ok(!r1.added.some((c) => c.handle === '@spam' || c.handle === '@tiny' || c.handle === 'org'));
    const r2 = await collectCandidates({ instanceConfig: cfg, dataDir, now: NOW, env, fetchImpl: fakeFetch() });
    assert.equal(r2.added.length, 0, 'already surfaced people are not added again');
    const recent = recentCandidates(dataDir, { now: NOW });
    assert.equal(recent.find((c) => c.source === 'youtube').evidence.title, "Claude Code & MCP don't panic", 'HTML entities from the YouTube API are decoded');
    assert.equal(recent[0].handle, '@builder', 'best score first (audience plus engagement): 42k followers and a strong post beat 120k subscribers with none');
    assert.ok(recent.length <= 8);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a failing source is isolated and reported; excluded handles (our own accounts) are skipped', async () => {
  const dataDir = tmp();
  try {
    const c = { research: { pilotCandidates: { ...cfg.research.pilotCandidates, excludeHandles: ['x:@Builder'] } } };
    const r = await collectCandidates({ instanceConfig: c, dataDir, now: NOW, env: { X_SEARCH_BEARER_TOKEN: 'b' }, fetchImpl: fakeFetch() });
    assert.deepEqual(r.errors.map((e) => e.source), ['youtube']);
    assert.ok(!r.added.some((x) => x.source === 'x'), 'excluded');
    assert.ok(r.added.some((x) => x.source === 'github'), 'other sources unaffected');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('ranking uses audience and engagement only; no demographic field is read or stored', () => {
  assert.ok(scoreCandidate({ reach: 100000, evidence: { engagement: 5 } }) > scoreCandidate({ reach: 10000, evidence: { engagement: 5 } }), 'more audience scores higher at equal engagement');
  assert.ok(scoreCandidate({ reach: 10000, evidence: { engagement: 500 } }) > scoreCandidate({ reach: 10000, evidence: { engagement: 5 } }), 'a stronger post scores higher at equal audience');
  const person = { source: 'x', id: '1', handle: '@a', name: 'A', reach: 9000, bio: 'building AI agents', evidence: { engagement: 1 } };
  assert.equal(eligible(person, { minReach: DEFAULT_MIN_REACH, exclude: new Set() }), true);
  assert.equal(eligible({ ...person, reach: null }, { minReach: DEFAULT_MIN_REACH, exclude: new Set() }), false, 'hidden audience size is not guessed');
  assert.equal(eligible({ ...person, reach: 20_000_000 }, { minReach: DEFAULT_MIN_REACH, exclude: new Set() }), false, 'a mega-account is outside the reachable band');
  assert.equal(eligible({ ...person, bio: 'cooking and travel', evidence: { title: 'my pasta recipe', engagement: 1 } }, { minReach: DEFAULT_MIN_REACH, exclude: new Set() }), false, 'must visibly talk about AI building');
  assert.equal(dedupe([person, { ...person, evidence: { engagement: 50 } }]).length, 1);
  const src = fs.readFileSync(new URL('../lib/research/pilotCandidates.js', import.meta.url), 'utf8');
  assert.ok(!/\b(age|birth|gender|genz|gen z)\b\s*[:=(]/i.test(src.replace(/\/\/.*$/gm, '')), 'no age or demographic inference in code');
});

test('the brief shows a people-to-invite section, framed as invitations and not sales leads, and omits it when empty', async () => {
  const dataDir = tmp();
  try {
    await collectCandidates({ instanceConfig: cfg, dataDir, now: NOW, env, fetchImpl: fakeFetch() });
    const c = collectBrief({ dataDir, now: NOW });
    const text = renderText(c, 'Sun, Nov 8, 2026'), html = renderHtml(c, 'Sun, Nov 8, 2026');
    assert.match(text, /PEOPLE TO INVITE TO TRY PILOT \(not sales leads/);
    assert.match(text, /Dev Channel @devchan on youtube, 120,000 subscribers/);
    assert.match(html, /People to invite to try Pilot/);
    assert.match(text, /5 people to invite/);
    const empty = collectBrief({ dataDir: tmp(), now: NOW });
    assert.ok(!/PEOPLE TO INVITE/.test(renderText(empty, 'x')));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
