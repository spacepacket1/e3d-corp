import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents } from '../lib/events/store.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { getProposal } from '../lib/proposals/store.js';
import { ACTION_POLICY, ACTION_POLICY_VERSION, assertProposalAuthorized } from '../lib/authority/policy.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { postXProposal, postLinkedinProposal } from '../lib/actions/socialPost.js';
import { proposeXPost, proposeLinkedinPost } from '../lib/proposals/socialPost.js';
import { proposePilotAdCampaign, validatePilotAdCampaign } from '../lib/proposals/pilotAdCampaign.js';
import { searchRecentTweets } from '../lib/research/xSearchClient.js';
import { clearAppBearerCache, X_APP_TOKEN_URL } from '../lib/research/xAppBearer.js';
import { postToX, X_TWEETS_URL } from '../lib/social/xPost.js';
import { postToLinkedIn } from '../lib/social/linkedinPost.js';
import { oauth1Header } from '../lib/social/oauth1.js';
import { loadGrowthFacts, BASE_PILOT_FACTS } from '../lib/pilot/growthFacts.js';
import { validateContentDrafts } from '../lib/roles/pilotContentDraft.js';
import { validateAdCopy } from '../lib/roles/pilotAdCopy.js';
import { draftCompetitorBrief } from '../lib/roles/pilotCompetitorBrief.js';
import { migrateConfigToPilot } from '../lib/pilot/pilotInstanceConfig.js';
import { migrateInstanceFile } from '../ops/migrate-instance-to-pilot.js';
import { validateInstanceConfig } from '../lib/config.js';
import { runPilotContent } from '../ops/reports/runPilotContent.js';
import { runPilotResearch } from '../ops/reports/runPilotResearch.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilotgrowth-'));
const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, async json() { return body; } });
const factIds = BASE_PILOT_FACTS.map((f) => f.id);

// ---------- policy ----------
test('policy v8 registers x-post/linkedin-post at level 2 and pilot-ad-campaign at level 3', () => {
  assert.equal(ACTION_POLICY_VERSION, 9);
  assert.equal(ACTION_POLICY['x-post'], 2);
  assert.equal(ACTION_POLICY['linkedin-post'], 2);
  assert.equal(ACTION_POLICY['pilot-ad-campaign'], 3);
});

// ---------- X search auth ----------
test('X search: no bearer and no consumer pair is unavailable', async () => {
  const r = await searchRecentTweets({ query: 'q' });
  assert.equal(r.status, 'unavailable');
});

test('X search: missing bearer derives an app-only bearer from the consumer pair, cached in memory, flagged degraded', async () => {
  clearAppBearerCache();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url) === X_APP_TOKEN_URL) return json({ token_type: 'bearer', access_token: 'derived-1' });
    return json({ data: [{ id: '1', text: 'hi' }] });
  };
  const r = await searchRecentTweets({ query: 'q', consumerKey: 'ck', consumerSecret: 'cs', fetchImpl });
  assert.equal(r.status, 'ok');
  assert.equal(r.auth.mode, 'derived-app-bearer');
  assert.equal(r.auth.degraded, true);
  assert.equal(calls[0].opts.method, 'POST');
  assert.match(calls[0].opts.body, /grant_type=client_credentials/);
  assert.equal(calls[1].opts.headers.authorization, 'Bearer derived-1');
  await searchRecentTweets({ query: 'q2', consumerKey: 'ck', consumerSecret: 'cs', fetchImpl });
  assert.equal(calls.filter((c) => c.url === X_APP_TOKEN_URL).length, 1, 'derived token is cached');
  clearAppBearerCache();
});

test('X search: a 401 on the configured bearer falls back to the derived bearer and retries', async () => {
  clearAppBearerCache();
  const seen = [];
  const fetchImpl = async (url, opts) => {
    if (String(url) === X_APP_TOKEN_URL) return json({ token_type: 'bearer', access_token: 'derived-2' });
    seen.push(opts.headers.authorization);
    return opts.headers.authorization === 'Bearer stale' ? json({}, 401) : json({ data: [] });
  };
  const r = await searchRecentTweets({ bearerToken: 'stale', query: 'q', consumerKey: 'ck', consumerSecret: 'cs', fetchImpl });
  assert.equal(r.status, 'ok');
  assert.deepEqual(seen, ['Bearer stale', 'Bearer derived-2']);
  assert.match(r.auth.note, /HTTP 401/);
  clearAppBearerCache();
});

test('X search: 401 without fallback credentials explains the likely cause; failing fallback is reported', async () => {
  clearAppBearerCache();
  const r = await searchRecentTweets({ bearerToken: 'stale', query: 'q', fetchImpl: async () => json({}, 401) });
  assert.equal(r.status, 'unavailable');
  assert.match(r.reason, /401.*(expired|user token)/);
  const r2 = await searchRecentTweets({
    bearerToken: 'stale', query: 'q', consumerKey: 'ck', consumerSecret: 'cs',
    fetchImpl: async (url) => (String(url) === X_APP_TOKEN_URL ? json({}, 403) : json({}, 401))
  });
  assert.match(r2.reason, /fallback failed.*403/);
});

// ---------- social posting ----------
function setupDir() {
  const dir = tmp();
  return { dir, dataDir: dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('x-post: pending proposal is refused; approval posts via the transport once, records post event and Outcome with URL', async () => {
  const s = setupDir();
  const posts = [];
  const transport = async (req) => { posts.push(req); return { postId: '99', url: 'https://x.com/i/web/status/99', auth: 'oauth2-user' }; };
  registerActionExecutor('x-post', (p, ctx) => postXProposal(p, { ...ctx, transport }));
  try {
    const { proposal } = proposeXPost(s.dataDir, { text: 'Multi-model debate: see where models disagree.', citedFacts: ['f'] });
    assert.equal(proposal.authorityLevel, 2);
    await assert.rejects(postXProposal(proposal, { dataDir: s.dataDir, transport }), /not approved/);
    assert.equal(posts.length, 0);

    await decideProposal(s.dataDir, proposal.id, 'approved', 'ok', 'chris', 'cli', {});
    assert.equal(posts.length, 1);
    const [posted] = queryEvents(s.dataDir, { type: 'x.posted' });
    assert.equal(posted.payload.url, 'https://x.com/i/web/status/99');
    const outcomes = queryEvents(s.dataDir, { type: 'social.post.published' });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].payload.url, 'https://x.com/i/web/status/99');

    const again = await postXProposal(getProposal(s.dataDir, proposal.id), { dataDir: s.dataDir, transport });
    assert.equal(again.idempotent, true);
    assert.equal(posts.length, 1);
  } finally { clearActionExecutor('x-post'); s.done(); }
});

test('x-post / linkedin-post: over-length text is refused up front; dry-run posts nothing and records nothing', async () => {
  const s = setupDir();
  try {
    assert.throws(() => proposeXPost(s.dataDir, { text: 'a'.repeat(281) }), /280/);
    const { proposal } = proposeLinkedinPost(s.dataDir, { text: 'LinkedIn draft grounded in a fact.' });
    const approved = { ...proposal, status: 'approved' };
    const transport = async () => { throw new Error('must not be called'); };
    const result = await postLinkedinProposal(approved, { dataDir: s.dataDir, transport, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(queryEvents(s.dataDir, { type: 'linkedin.posted' }).length, 0);
    await assert.rejects(postLinkedinProposal({ ...approved, authorityLevel: 1 }, { dataDir: s.dataDir, transport }), /authorityLevel/);
  } finally { s.done(); }
});

test('postToX: OAuth2 token refresh on 401 rewrites the token file; OAuth1 fallback signs the request', async () => {
  const dir = tmp();
  try {
    const tokenFile = path.join(dir, 'x.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'old', refresh_token: 'r1', client_id: 'cid', expires_at: Date.now() + 3600_000 }));
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('oauth2/token')) return json({ access_token: 'new', refresh_token: 'r2', expires_in: 7200 });
      return opts.headers.authorization === 'Bearer new' ? json({ data: { id: '7' } }, 201) : json({}, 401);
    };
    const r = await postToX({ text: 'hello', replyToTweetId: '5' }, { env: { X_TOKEN_FILE: tokenFile, X_CLIENT_ID: 'cid' }, fetchImpl });
    assert.equal(r.auth, 'oauth2-user');
    assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refresh_token, 'r2');
    const tweetCall = calls.filter((c) => c.url === X_TWEETS_URL).pop();
    assert.deepEqual(JSON.parse(tweetCall.opts.body).reply, { in_reply_to_tweet_id: '5' });

    const oauth1Env = { X_OAUTH1_CONSUMER_KEY: 'ck', X_OAUTH1_CONSUMER_SECRET: 'cs', X_OAUTH1_ACCESS_TOKEN: 'at', X_OAUTH1_ACCESS_TOKEN_SECRET: 'ts' };
    const seen = [];
    const r2 = await postToX({ text: 'hello' }, { env: oauth1Env, fetchImpl: async (url, opts) => { seen.push(opts.headers.authorization); return json({ data: { id: '8' } }, 201); } });
    assert.equal(r2.auth, 'oauth1');
    assert.match(seen[0], /^OAuth .*oauth_signature="/);
    await assert.rejects(postToX({ text: 'x' }, { env: {}, fetchImpl: async () => json({}, 500) }), /X post failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('oauth1Header matches the documented Twitter signing example', () => {
  const header = oauth1Header({
    method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json',
    params: { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958
  });
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test('postToLinkedIn sends the Posts API request and returns the URL from x-restli-id', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'li.json');
    fs.writeFileSync(file, JSON.stringify({ access_token: 'tok', person_urn: 'abc123', expiry_date: Date.now() + 100000 }));
    let req;
    const r = await postToLinkedIn({ text: 'hi' }, { env: { LINKEDIN_TOKEN_FILE: file }, fetchImpl: async (url, opts) => { req = { url, opts }; return json({}, 201, { 'x-restli-id': 'urn:li:share:1' }); } });
    assert.equal(r.url, 'https://www.linkedin.com/feed/update/urn:li:share:1/');
    assert.equal(JSON.parse(req.opts.body).author, 'urn:li:person:abc123');
    fs.writeFileSync(file, JSON.stringify({ access_token: 'tok', person_urn: 'abc', expiry_date: 1 }));
    await assert.rejects(postToLinkedIn({ text: 'hi' }, { env: { LINKEDIN_TOKEN_FILE: file }, fetchImpl: async () => json({}, 201) }), /expired/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- roles ----------
test('content drafts: facts must be cited, unknown ids/URLs/overclaims/length are dropped', () => {
  const facts = [...BASE_PILOT_FACTS];
  const good = { platform: 'x', text: 'Pilot is a multi-model debate service; disagreement is recorded.', citedFacts: ['what', 'dissent'] };
  const raw = JSON.stringify({ drafts: [
    good,
    { platform: 'x', text: 'No citation here.', citedFacts: [] },
    { platform: 'x', text: 'Cites ghost.', citedFacts: ['nope'] },
    { platform: 'x', text: 'Our ChatGPT plugin is live on ChatGPT now.', citedFacts: ['chatgpt'] },
    { platform: 'x', text: 'multi-LLM magic', citedFacts: ['what'] },
    { platform: 'x', text: 'See https://evil.example/x', citedFacts: ['what'] },
    { platform: 'x', text: 'a'.repeat(281), citedFacts: ['what'] },
    { platform: 'linkedin', text: 'Guaranteed to be right.', citedFacts: ['what'] }
  ] });
  const r = validateContentDrafts(raw, { facts });
  assert.equal(r.drafts.length, 1);
  assert.deepEqual(r.drafts[0].citedFacts, ['what', 'dissent']);
  assert.equal(r.dropped.length, 7);
  assert.equal(validateContentDrafts('not json', { facts }).ok, false);
});

const goodAd = () => ({
  variants: [{ headline: 'Ask several AI models', primaryText: 'See where multi-model answers disagree.', description: 'Pilot by e3d', cta: 'SIGN_UP', citedFacts: ['what'] }],
  audience: { interests: ['LLMs'], roles: ['developer'], regions: ['US'], ageMin: 22, ageMax: 55 },
  budget: { monthlyCeilingUsd: 300, dailyCapUsd: 10 },
  killRule: { pauseIfCpaUsdAbove: 25, pauseIfZeroSignupsAfterSpendUsd: 100 },
  rationale: 'test'
});

test('ad copy validation enforces ceiling, per-day cap, kill rule, length and citations', () => {
  const facts = [...BASE_PILOT_FACTS];
  assert.equal(validateAdCopy(JSON.stringify(goodAd()), { facts }).ok, true);
  const bad = (mutate) => { const a = goodAd(); mutate(a); return validateAdCopy(JSON.stringify(a), { facts }); };
  assert.match(bad((a) => { a.budget.monthlyCeilingUsd = 500; }).reason, /exceeds/);
  assert.match(bad((a) => { a.budget.dailyCapUsd = 30; }).reason, /dailyCapUsd/);
  assert.match(bad((a) => { delete a.killRule; }).reason, /killRule/);
  assert.match(bad((a) => { a.killRule.pauseIfZeroSignupsAfterSpendUsd = 200; }).reason, /half/);
  assert.match(bad((a) => { a.variants[0].headline = 'x'.repeat(41); }).reason, /no variant/);
  assert.match(bad((a) => { a.variants[0].citedFacts = []; }).reason, /no variant/);
});

test('pilot-ad-campaign proposal is level 3, carries kill rule, has no executor, and approval does not execute', async () => {
  const s = setupDir();
  try {
    const ad = goodAd();
    assert.throws(() => proposePilotAdCampaign(s.dataDir, { ...ad, budget: { monthlyCeilingUsd: 900, dailyCapUsd: 10 } }), /exceeds/);
    const { proposal } = proposePilotAdCampaign(s.dataDir, ad);
    assert.equal(proposal.authorityLevel, 3);
    assert.equal(proposal.payload.killRule.pauseIfCpaUsdAbove, 25);
    assert.match(proposal.payload.launch, /nothing is spent/);
    assert.equal(validatePilotAdCampaign(proposal.payload).valid, true);
    assert.throws(() => assertProposalAuthorized(proposal, 'pilot-ad-campaign'), /not approved/);
  } finally { s.done(); }
});

test('competitor brief: failed search is degraded with no LLM call; ok search keeps only cited, known URLs', async () => {
  const never = async () => { throw new Error('LLM must not be called'); };
  const degraded = await draftCompetitorBrief({ searches: [{ status: 'unavailable', query: 'q', reason: 'web search unavailable: HTTP 401' }], llmClient: never });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.provenance.degraded, true);
  assert.equal(degraded.brief, null);

  const config = { llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'X', modelEnvVar: 'Y' } } }, roles: { 'pilot.competitorBrief': { provider: 'local' } } };
  process.env.X = 'http://127.0.0.1:1'; process.env.Y = 'm';
  try {
    const llmClient = async () => ({ text: JSON.stringify({ summary: 's', competitors: [{ name: 'A', what: 'w', url: 'https://a.example' }, { name: 'B', what: 'w', url: 'https://invented.example' }], mentions: [], implications: ['i'] }) });
    const ok = await draftCompetitorBrief({ instanceConfig: config, llmClient, searches: [
      { status: 'ok', query: 'q', results: [{ title: 'A', url: 'https://a.example', content: 'c' }] },
      { status: 'unavailable', query: 'q2', reason: 'boom' }
    ] });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.provenance.degraded, true, 'partial failure is flagged');
    assert.deepEqual(ok.brief.competitors.map((c) => c.url), ['https://a.example']);
  } finally { delete process.env.X; delete process.env.Y; }
});

// ---------- config transition ----------
const legacy = () => ({
  name: 'futco', dataDir: 'd', eventSources: [],
  llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'K' } } },
  research: { webSearchProvider: 'https://example.invalid/search', x: { bearerTokenEnvVar: 'B', searchQueries: ['"on-chain analytics"'], topics: ['wallet analytics'] } },
  researchTopics: ['AI consulting', 'oppscan crypto thing'],
  ownDomains: ['futco.ai', 'e3d.ai'],
  scoring: { typeWeights: { 'consulting-engagement': 1.2, 'product-opportunity': 1.1 } },
  roles: { 'opportunity.prospect': { provider: 'claude' } }
});

test('migrateConfigToPilot swaps topics/queries/weights, archives the old ones, is idempotent, validates, and does not mutate input', () => {
  const input = legacy();
  const snapshot = JSON.stringify(input);
  const out = migrateConfigToPilot(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(out.archived.researchTopics, ['AI consulting', 'oppscan crypto thing']);
  assert.deepEqual(out.archived.x.searchQueries, ['"on-chain analytics"']);
  assert.deepEqual(out.archived.typeWeights, { 'consulting-engagement': 1.2, 'product-opportunity': 1.1 });
  assert.ok(out.researchTopics.every((t) => !/crypto|oppscan/i.test(t)));
  assert.ok(out.scoring.typeWeights.distribution > out.scoring.typeWeights.partnership);
  assert.ok(out.ownDomains.includes('pilot.e3d.ai') && out.ownDomains.includes('e3d.ai'));
  assert.equal(out.roles['pilot.contentDraft'].provider, 'claude');
  assert.equal(out.pilotGrowth.adMonthlyCeilingUsd, 300);
  assert.equal(validateInstanceConfig(out).valid, true);
  assert.deepEqual(migrateConfigToPilot(out), out);
});

test('migrate script is a dry run by default; --apply writes a backup first', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'instance.json');
    fs.writeFileSync(file, JSON.stringify(legacy()));
    const before = fs.readFileSync(file, 'utf8');
    const dry = migrateInstanceFile(file);
    assert.equal(dry.applied, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(dry.errors, []);
    const applied = migrateInstanceFile(file, { apply: true });
    assert.equal(applied.applied, true);
    assert.equal(fs.readFileSync(applied.backupPath, 'utf8'), before);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).archived.researchTopics);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- runners ----------
test('runPilotContent queues pending proposals only (nothing posted), skips duplicates; --with-ads queues a level-3 proposal', async () => {
  const s = setupDir();
  try {
    const config = migrateConfigToPilot(legacy());
    config.pilotGrowth.factsFile = path.join(s.dataDir, 'no-facts.json'); // never the live instance's pilot-facts.json
    process.env.K = 'test-key-not-real';
    const llmClient = async ({ systemPrompt }) => ({
      text: systemPrompt.includes('ad copy')
        ? JSON.stringify(goodAd())
        : JSON.stringify({ drafts: [{ platform: 'x', text: 'Pilot is a multi-model debate service.', citedFacts: ['what'] }, { platform: 'linkedin', text: 'Disagreement between models is recorded, not hidden.', citedFacts: ['dissent'] }] })
    });
    const first = await runPilotContent({ config, dataDir: s.dataDir, llmClient, withAds: true });
    assert.equal(first.drafts, 2);
    assert.ok(first.adProposal);
    const second = await runPilotContent({ config, dataDir: s.dataDir, llmClient });
    assert.equal(second.drafts, 0);
    const created = queryEvents(s.dataDir, { type: 'proposal.created' });
    assert.deepEqual(created.map((e) => e.payload.status), ['pending', 'pending', 'pending']);
    assert.equal(queryEvents(s.dataDir, { type: 'x.posted' }).length, 0);
    assert.equal(loadGrowthFacts(config).facts.length, factIds.length);
  } finally { delete process.env.K; s.done(); }
});

test('runPilotResearch records a degraded brief event when web search fails', async () => {
  const s = setupDir();
  try {
    const researchAdapter = { webSearch: async (query) => ({ status: 'unavailable', query, reason: 'web search provider is not configured' }) };
    const result = await runPilotResearch({ config: { pilotGrowth: { competitorQueries: ['q1', 'q2'] } }, dataDir: s.dataDir, researchAdapter });
    assert.equal(result.status, 'degraded');
    const [event] = queryEvents(s.dataDir, { type: 'pilot.competitorBrief.created' });
    assert.equal(event.payload.provenance.degraded, true);
  } finally { s.done(); }
});
