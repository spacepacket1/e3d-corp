import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectListening, recentListening } from '../lib/research/pilotListening.js';

const NOW = new Date('2026-11-04T15:00:00Z');
const fakeFetch = (log = []) => async (url) => {
  const u = String(url); log.push(u);
  if (u.includes('hn.algolia')) return { ok: true, json: async () => ({ hits: [{ objectID: '1', title: 'Launch HN: Council', points: 50, num_comments: 9, created_at: '2026-11-03T00:00:00Z' }] }) };
  if (u.includes('api.github.com')) return { ok: true, json: async () => ({ items: [{ full_name: 'a/b', description: 'x', html_url: 'https://github.com/a/b', stargazers_count: 7, created_at: '2026-11-01T00:00:00Z' }] }) };
  if (u.includes('googleapis')) return { ok: false, status: 403, json: async () => ({}) };
  throw new Error('unexpected ' + u);
};
const cfg = { research: { youtube: { apiKeyEnvVar: 'TEST_YT' }, pilotListening: { queries: { hackernews: ['q'], github: ['q'], youtube: ['q'] } } } };

test('listening records new items once, isolates a failing source, and never writes outside the event log', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-'));
  try {
    const r1 = await collectListening({ instanceConfig: cfg, dataDir, now: NOW, env: { TEST_YT: 'k' }, fetchImpl: fakeFetch() });
    assert.equal(r1.added.length, 2);
    assert.deepEqual(r1.errors.map((e) => e.source), ['youtube']);
    const r2 = await collectListening({ instanceConfig: cfg, dataDir, now: NOW, env: { TEST_YT: 'k' }, fetchImpl: fakeFetch() });
    assert.equal(r2.added.length, 0, 'seen items are not re-added');
    const recent = recentListening(dataDir, { now: NOW });
    assert.equal(recent.hackernews[0].title, 'Launch HN: Council');
    assert.equal(recent.github[0].score, 7);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('youtube without a key is reported, not thrown', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-'));
  try {
    const r = await collectListening({ instanceConfig: { research: { pilotListening: { disabledSources: ['hackernews', 'github'] } } }, dataDir, now: NOW, env: {}, fetchImpl: fakeFetch() });
    assert.match(r.errors[0].message, /no API key/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
