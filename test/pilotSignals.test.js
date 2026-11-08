import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSignals, recentSignals, parseRss, amountOf, ANGLES } from '../lib/research/pilotSignals.js';

const rss = (items) => `<rss><channel>${items.map(([t, u, src]) => `<item><title><![CDATA[${t} - ${src}]]></title><link>${u}</link><source url="x">${src}</source><pubDate>Sat, 07 Nov 2026 10:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const NEWS = [
  ['Acme raises $12M seed to build AI agents for support', 'https://n/1', 'TechX'],
  ['OpenAI Secures $11B at $1.25T Valuation', 'https://n/2', 'TechX'],
  ['Public AI Contests Raise New Questions', 'https://n/3', 'TechX'],
  ['Claude outage hits developers for two hours', 'https://n/4', 'TechX'],
  ['Claude vs ChatGPT writing rules: 12 steps', 'https://n/5', 'Blog'],
  ['AI agent deleted a production database', 'https://n/6', 'TechX']
];
const res = (body, json = true) => ({ ok: true, status: 200, json: async () => body, text: async () => body });
const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('news.google.com')) return res(rss(NEWS), false);
  if (u.includes('author_whoishiring')) return res({ hits: [{ objectID: '77', title: 'Ask HN: Who is hiring? (November 2026)' }] });
  if (u.includes('story_77')) return res({ hits: [
    { objectID: '1', comment_text: 'Foo | Berlin | Building AI agents for support. LLM engineer wanted' },
    { objectID: '2', comment_text: 'NetBird | Berlin | networking and access control' }] });
  if (u.includes('search_by_date')) return res({ hits: [{ objectID: '9', title: 'Ask HN: Which LLM should I use for contracts?', num_comments: 12 }] });
  if (u.includes('search/issues')) return res({ items: [{ html_url: 'https://github.com/a/b/issues/1', title: 'Which LLM should we default to?', body: 'we use llm calls', repository_url: 'https://api.github.com/repos/a/b' }] });
  throw new Error('unexpected ' + u);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
const NOW = new Date('2026-11-08T12:00:00Z');

test('funding amounts parse, and mega rounds are skipped', () => {
  assert.equal(amountOf('Acme raises $12M seed'), 12e6);
  assert.equal(amountOf('Big raises $1.2 billion'), 1.2e9);
  assert.equal(amountOf('no money here'), null);
});

test('RSS items drop the publisher suffix from the title', () => {
  assert.equal(parseRss(rss([['Hello world', 'https://n/x', 'Pub']]))[0].title, 'Hello world');
});

test('signals: sensible funded, hiring, asking and trigger items, and noise is dropped', async () => {
  const dataDir = tmp();
  try {
    const { added, errors } = await collectSignals({ instanceConfig: {}, dataDir, now: NOW, env: {}, fetchImpl: fakeFetch });
    assert.deepEqual(errors, []);
    const r = recentSignals(dataDir, { now: NOW });
    assert.deepEqual(r.funded.map((x) => x.who), ['Acme'], 'OpenAI mega round and a non-funding headline are skipped');
    assert.deepEqual(r.hiring.map((x) => x.who), ['Foo'], 'a non-AI job is skipped');
    assert.equal(r.asking.length, 1, 'Hacker News questions only: GitHub issues were feature requests, not people asking');
    const cats = r.trigger.map((x) => x.category).sort();
    assert.deepEqual(cats, ['incident', 'outage'], 'a listicle and an off-topic headline are not triggers');
    assert.equal(r.trigger.find((x) => x.category === 'outage').angle, ANGLES.outage);
    assert.equal(added.length, 5);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('signals: an item is shown once, never again on a later day', async () => {
  const dataDir = tmp();
  try {
    await collectSignals({ instanceConfig: {}, dataDir, now: NOW, env: {}, fetchImpl: fakeFetch });
    const again = await collectSignals({ instanceConfig: {}, dataDir, now: new Date(NOW.getTime() + 86_400_000), env: {}, fetchImpl: fakeFetch });
    assert.equal(again.added.length, 0);
    assert.equal(recentSignals(dataDir, { now: new Date(NOW.getTime() + 86_400_000 - 3_000), hours: 20 }).funded.length, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('signals: one failing source does not hide the others', async () => {
  const dataDir = tmp();
  try {
    const flaky = async (url) => { if (String(url).includes('news.google.com')) return { ok: false, status: 503 }; return fakeFetch(url); };
    const { errors } = await collectSignals({ instanceConfig: {}, dataDir, now: NOW, env: {}, fetchImpl: flaky });
    assert.deepEqual(errors.map((e) => e.source).sort(), ['funded', 'triggers']);
    assert.equal(recentSignals(dataDir, { now: NOW }).hiring.length, 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
