import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents } from '../lib/events/store.js';
import { loadGrowthFacts } from '../lib/pilot/growthFacts.js';
import { validatePilotReply, draftPilotEngagementReply } from '../lib/roles/xEngagementReply.js';
import { migrateConfigToPilot } from '../lib/pilot/pilotInstanceConfig.js';
import { migrateInstanceFile } from '../ops/migrate-instance-to-pilot.js';
import { validateInstanceConfig } from '../lib/config.js';
import { runXEngagement, resolveGrounding } from '../ops/reports/runXEngagement.js';

const { facts } = loadGrowthFacts({});
const reply = (o) => JSON.stringify({ reply: 'Disagreement between models is the useful signal. pilot.e3d.ai keeps it visible.', citedFacts: ['dissent'], reason: 'fits', ...o });
process.env.K = process.env.K ?? 'test-key';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-xreplies-'));

test('validatePilotReply accepts a grounded reply and rejects every violation', () => {
  const ok = validatePilotReply(reply({}), { facts });
  assert.ok(ok.reply && ok.citedFacts.includes('dissent') && ok.citedFactTexts.length === 1);
  const bad = (o) => validatePilotReply(reply(o), { facts });
  assert.equal(bad({ reply: null }).reason, 'declined');
  assert.equal(bad({ reply: 'null' }).reason, 'declined');
  assert.match(bad({ citedFacts: [] }).reason, /cites no facts/);
  assert.match(bad({ citedFacts: ['nope'] }).reason, /unknown fact/);
  assert.match(bad({ reply: 'A multi-LLM tool.' }).reason, /multi-LLM/);
  assert.match(bad({ reply: 'The ChatGPT plugin is live on ChatGPT now.' }).reason, /live/);
  assert.match(bad({ reply: 'see https://invented.example/x' }).reason, /URL/);
  assert.match(bad({ reply: 'x'.repeat(281) }).reason, /280/);
  assert.match(bad({ reply: 'pilot.e3d.ai is great, try pilot.e3d.ai' }).reason, /more than once/);
  assert.match(bad({ reply: 'Pilot is always right.' }).reason, /overclaims/);
  assert.equal(validatePilotReply('not json', { facts }).reply, null);
});

test('draftPilotEngagementReply passes only facts to the model and needs facts', async () => {
  const config = { llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'K' } } }, roles: { 'x.engagementReply': { provider: 'claude' } } };
  let seen;
  const out = await draftPilotEngagementReply({ instanceConfig: config, postText: 'which model do I trust?', facts, llmClient: async (req) => { seen = req; return { text: reply({}) }; } });
  assert.ok(out.reply);
  assert.ok(JSON.parse(seen.userPrompt).facts.length === facts.length);
  await assert.rejects(draftPilotEngagementReply({ instanceConfig: config, postText: 'x', facts: [] }), /facts/);
});

function setup(grounding) {
  const dir = tmp();
  const tweets = [
    { id: '1', text: 'Which model do you trust when ChatGPT and Claude disagree?', public_metrics: { like_count: 5, reply_count: 2, retweet_count: 1 } },
    { id: '2', text: 'BUY NOW http://a.co http://b.co http://c.co http://d.co 100x', public_metrics: { like_count: 50, reply_count: 2, retweet_count: 1 } },
    { id: '3', text: 'no engagement at all here today', public_metrics: { like_count: 0, reply_count: 0, retweet_count: 0 } },
    { id: '4', text: 'Unrelated pizza post that is popular', public_metrics: { like_count: 9, reply_count: 2, retweet_count: 1 } }
  ];
  const config = {
    llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'K' } } },
    roles: { 'x.engagementReply': { provider: 'claude' } },
    research: { x: { bearerTokenEnvVar: 'XB', searchQueries: ['q'], topics: ['model disagreement'], draftsPerRun: 5, grounding } }
  };
  const searches = [];
  const researchAdapter = { pullXSearch: async (o) => { searches.push(o.query); return { status: 'ok', tweets }; } };
  const relevanceCheck = async ({ text }) => ({ relevant: !/pizza/.test(text), matchedTopic: 'topic_0' });
  return { dir, config, researchAdapter, relevanceCheck, searches };
}

test('pilot grounding queues a draft for relevant posts only, keeps safeguards, and skips declines', async () => {
  const s = setup('pilot');
  try {
    let calls = 0;
    const res = await runXEngagement({
      config: s.config, dataDir: s.dir, env: { XB: 't' }, researchAdapter: s.researchAdapter, relevanceCheck: s.relevanceCheck,
      findingsGatherer: async () => { throw new Error('e3d findings must not be used'); },
      llmClient: async () => { calls += 1; return { text: reply({}) }; }, log: () => {}, warn: () => {}
    });
    assert.equal(res.grounding, 'pilot');
    assert.equal(res.draftsQueued, 1);
    assert.equal(calls, 1, 'spam, thin and irrelevant posts never reach the LLM');
    const [event] = queryEvents(s.dir, { type: 'x.draftQueued' });
    assert.equal(event.subject.id, '1');
    assert.equal(event.payload.grounding, 'pilot');
    assert.deepEqual(event.payload.finding.factIds, ['dissent']);
    assert.match(event.payload.finding.source, /pilot facts/);
    // rerun: already queued, nothing new
    const again = await runXEngagement({ config: s.config, dataDir: s.dir, env: { XB: 't' }, researchAdapter: s.researchAdapter, relevanceCheck: s.relevanceCheck, llmClient: async () => ({ text: reply({}) }), log: () => {}, warn: () => {} });
    assert.equal(again.draftsQueued, 0);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('pilot grounding drops declined and invalid replies', async () => {
  for (const text of [reply({ reply: null }), reply({ reply: 'multi-LLM!' }), 'garbage']) {
    const s = setup('pilot');
    try {
      const res = await runXEngagement({ config: s.config, dataDir: s.dir, env: { XB: 't' }, researchAdapter: s.researchAdapter, relevanceCheck: s.relevanceCheck, llmClient: async () => ({ text }), log: () => {}, warn: () => {} });
      assert.equal(res.draftsQueued, 0);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  }
});

test('draftsPerRun caps pilot drafts', async () => {
  const s = setup('pilot');
  s.config.research.x.draftsPerRun = 1;
  s.researchAdapter.pullXSearch = async () => ({ status: 'ok', tweets: [1, 2, 3].map((n) => ({ id: `t${n}`, text: `which model should I trust ${n}`, public_metrics: { like_count: 9, reply_count: 2, retweet_count: 1 } })) });
  try {
    const res = await runXEngagement({ config: s.config, dataDir: s.dir, env: { XB: 't' }, researchAdapter: s.researchAdapter, relevanceCheck: s.relevanceCheck, llmClient: async () => ({ text: reply({}) }), log: () => {}, warn: () => {} });
    assert.equal(res.draftsQueued, 1);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('e3d-findings grounding keeps the old behaviour (findings gatherer, plain-text reply)', async () => {
  const s = setup('e3d-findings');
  try {
    const res = await runXEngagement({
      config: s.config, dataDir: s.dir, env: { XB: 't' }, researchAdapter: s.researchAdapter, relevanceCheck: s.relevanceCheck,
      findingsGatherer: async () => ({ findings: [{ source: 'e3d.ai', text: 'WALLETX moved' }] }),
      llmClient: async () => ({ text: 'Plain old reply.' }), log: () => {}, warn: () => {}
    });
    assert.equal(res.draftsQueued, 1);
    assert.equal(queryEvents(s.dir, { type: 'x.draftQueued' })[0].payload.finding.text, 'WALLETX moved');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('resolveGrounding defaults to e3d-findings and rejects unknown values', () => {
  assert.equal(resolveGrounding({}), 'e3d-findings');
  assert.equal(resolveGrounding({ grounding: 'pilot' }), 'pilot');
  assert.throws(() => resolveGrounding({ grounding: 'x' }), /grounding/);
});

test('migration sets research.x.grounding = pilot, idempotently, and validates', () => {
  const legacy = {
    name: 'futco', dataDir: 'd', eventSources: [],
    llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'K' } } },
    research: { webSearchProvider: 'https://example.invalid/search', x: { bearerTokenEnvVar: 'B', searchQueries: ['q'], topics: ['t'] } },
    researchTopics: ['a'], roles: {}, scoring: { typeWeights: { x: 1 } }
  };
  const out = migrateConfigToPilot(legacy);
  assert.equal(out.research.x.grounding, 'pilot');
  assert.deepEqual(migrateConfigToPilot(out), out);
  assert.equal(validateInstanceConfig(out).valid, true);
  const bad = structuredClone(out); bad.research.x.grounding = 'nope';
  assert.equal(validateInstanceConfig(bad).valid, false);
  const dir = tmp();
  try {
    const file = path.join(dir, 'instance.json');
    fs.writeFileSync(file, JSON.stringify(legacy));
    const dry = migrateInstanceFile(file);
    assert.equal(dry.applied, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).research.x.grounding, undefined);
    assert.ok(dry.summary.some((l) => l.includes('grounding')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replay: stored X search results are re-filtered and drafted with no new search, and each filter is counted', async () => {
  const { replayXEngagement } = await import('../ops/reports/replayXEngagement.js');
  const { appendEvent } = await import('../lib/events/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  try {
    const mk = (id, text, likes = 20) => ({ id, text, public_metrics: { like_count: likes, retweet_count: 0, reply_count: 0 }, reply_settings: 'everyone' });
    const store = (query, status, tweets) => appendEvent(dir, { type: 'evidence.gathered', source: 'research.x', subject: { type: 'x', id: query }, payload: { kind: 'x-search', query, result: { status, tweets } }, correlationId: 'c-' + query });
    store('q1', 'unavailable', []);                              // a 402 run: ignored
    store('q1', 'ok', [mk('1', 'which model do I trust for this?'), mk('2', 'pizza night', 20), mk('3', 'quiet post about models', 0)]);
    const config = { llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'K' } } }, roles: { 'x.engagementReply': { provider: 'claude' } }, research: { x: { bearerTokenEnvVar: 'XB', searchQueries: ['q1'], topics: ['model disagreement'], draftsPerRun: 5, grounding: 'pilot', minEngagement: 6 } } };
    const relevanceCheck = async ({ text }) => ({ relevant: !/pizza/.test(text), matchedTopic: 'topic_0' });
    const out = await replayXEngagement({ config, dataDir: dir, env: { XB: 't' }, relevanceCheck, llmClient: async () => ({ text: reply({}) }), log: () => {}, warn: () => {} });
    assert.equal(out.stats.posts, 3);
    assert.equal(out.stats.thin, 1, 'the zero-engagement post is under the floor');
    assert.equal(out.stats.notRelevant, 1, 'the pizza post is off topic');
    assert.equal(out.draftsQueued, 1);
    assert.equal(queryEvents(dir, { type: 'x.draftQueued' }).length, 1);
    // Running it again does not queue the same post twice.
    const again = await replayXEngagement({ config, dataDir: dir, env: { XB: 't' }, relevanceCheck, llmClient: async () => ({ text: '{}' }), log: () => {}, warn: () => {} });
    assert.equal(again.draftsQueued, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
