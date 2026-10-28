import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents } from '../lib/events/store.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { getProposal } from '../lib/proposals/store.js';
import { ACTION_POLICY, ACTION_POLICY_VERSION, assertProposalAuthorized } from '../lib/authority/policy.js';
import { proposeYoutubeMetadataChange, proposeYoutubeRollback } from '../lib/proposals/youtubeMetadataChange.js';
import { applyYoutubeMetadataChange } from '../lib/actions/youtubeMetadataChange.js';
import { registerActionExecutor } from '../lib/actions/registry.js';
import { listExecutedActions } from '../lib/actions/log.js';
import { snippetHash } from '../lib/youtube/series.js';
import { FAKE_KEY, FAKE_CHANNEL_ID, FAKE_REFRESH_TOKEN, makeVideo, startFakeYoutube } from './helpers/fakeYoutubeServer.js';
import { seedVideo, steadySamples } from './helpers/seedYoutube.js';

registerActionExecutor('youtube-metadata-change', applyYoutubeMetadataChange);

const ORIGINAL = { title: 'Old title', description: 'Old description', tags: ['ai', 'agents'], categoryId: '28' };

async function setup({ withOauth = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-youtube-meta-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const fake = await startFakeYoutube({ videos: [makeVideo('vid1', { ...ORIGINAL, publishedAt: '2026-10-10T00:00:00.000Z', views: 100 })] });
  const youtube = { channelId: FAKE_CHANNEL_ID, apiKeyEnvVar: 'E3D_TEST_YT_KEY', apiBaseUrl: fake.baseUrl };
  if (withOauth) {
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ access_token: 'stale', expiry_date: 1, refresh_token: FAKE_REFRESH_TOKEN }));
    fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret' } }));
    youtube.oauth = { tokenFile: path.join(dir, 'tokens.json'), clientSecretFile: path.join(dir, 'client.json'), tokenUrl: fake.tokenUrl };
  }
  process.env.E3D_TEST_YT_KEY = FAKE_KEY;
  seedVideo(dataDir, { id: 'vid1', ...ORIGINAL, ageDays: 10, samples: steadySamples({ ageDays: 10, perDay: 10 }) });
  const instanceConfig = { research: { youtube } };
  const done = async () => { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.E3D_TEST_YT_KEY; };
  return { dataDir, fake, instanceConfig, done };
}

const propose = (dataDir, instanceConfig, overrides = {}) => proposeYoutubeMetadataChange(dataDir, {
  videoId: 'vid1', videoTitle: 'Old title',
  changes: { title: 'A clearer title', tags: ['ai', 'agents', 'pipeline'] },
  current: { title: ORIGINAL.title, description: ORIGINAL.description, tags: ORIGINAL.tags },
  baseSnippetHash: snippetHash(ORIGINAL),
  reason: 'Title does not say what the video is about', hypothesis: 'A specific title improves click-through',
  instanceConfig, ...overrides
}).proposal;

test('policy v8 lists youtube-metadata-change at level 2, and the draft types are not in the table', () => {
  assert.equal(ACTION_POLICY_VERSION, 8);
  assert.equal(ACTION_POLICY['youtube-metadata-change'], 2);
  assert.equal(ACTION_POLICY['youtube-audience-copy-draft'], undefined);
  assert.equal(ACTION_POLICY['youtube-comment-reply-draft'], undefined);
});

test('payload validation: limits, unknown fields, missing rollback values', async () => {
  const s = await setup();
  try {
    assert.throws(() => propose(s.dataDir, s.instanceConfig, { changes: { title: 'x'.repeat(101) } }), /over the 100 character limit/);
    assert.throws(() => propose(s.dataDir, s.instanceConfig, { changes: { categoryId: '1' } }), /unsupported field/);
    assert.throws(() => propose(s.dataDir, s.instanceConfig, { changes: {} }), /nothing to change/);
    assert.throws(() => propose(s.dataDir, s.instanceConfig, { reason: '' }), /reason: required/);
    assert.throws(() => propose(s.dataDir, s.instanceConfig, { current: {} }), /before\.title: required/);
    const p = propose(s.dataDir, s.instanceConfig);
    assert.equal(p.status, 'pending');
    assert.equal(p.authorityLevel, 2);
    assert.deepEqual(p.payload.before, { title: 'Old title', tags: ['ai', 'agents'] });
  } finally { await s.done(); }
});

test('nothing is written to the channel until a human approves; the executor refuses a pending proposal', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    assert.equal(s.fake.state.updates.length, 0, 'creating the proposal writes nothing');
    await assert.rejects(applyYoutubeMetadataChange(p, { dataDir: s.dataDir, instanceConfig: s.instanceConfig }), /not approved/);
    await assert.rejects(applyYoutubeMetadataChange({ ...p, status: 'approved', type: 'send-outreach' }, { dataDir: s.dataDir, instanceConfig: s.instanceConfig }), /expected "youtube-metadata-change"/);
    await assert.rejects(applyYoutubeMetadataChange({ ...p, status: 'approved', authorityLevel: 1 }, { dataDir: s.dataDir, instanceConfig: s.instanceConfig }), /authorityLevel/);
    assert.equal(s.fake.state.updates.length, 0);
    assert.throws(() => assertProposalAuthorized(p, 'youtube-metadata-change'), /not approved/);
  } finally { await s.done(); }
});

test('approving applies one merged full-snippet PUT with OAuth, records before/after/baseline, and is idempotent', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    const result = await decideProposal(s.dataDir, p.id, 'approved', 'looks right', 'chris', 'cli', s.instanceConfig);
    assert.equal(result.executed, true);
    assert.equal(result.executionResult.applied, true);

    assert.equal(s.fake.state.updates.length, 1);
    const put = s.fake.state.updates[0];
    assert.equal(put.id, 'vid1');
    assert.equal(put.snippet.title, 'A clearer title');
    assert.deepEqual(put.snippet.tags, ['ai', 'agents', 'pipeline']);
    assert.equal(put.snippet.description, 'Old description', 'unchanged fields are carried over, not blanked');
    assert.equal(put.snippet.categoryId, '28', 'categoryId is required by the API and preserved');
    const putCall = s.fake.state.calls.find((c) => c.method === 'PUT');
    assert.match(putCall.auth, /^Bearer /, 'the write used OAuth');
    assert.equal(putCall.query.key, undefined, 'an API key is never sent on the write');

    const [applied] = queryEvents(s.dataDir, { type: 'youtube-metadata-change.applied' });
    assert.deepEqual(applied.payload.before, { title: 'Old title', tags: ['ai', 'agents'] });
    assert.deepEqual(applied.payload.after, { title: 'A clearer title', tags: ['ai', 'agents', 'pipeline'] });
    assert.ok(applied.payload.baseline.viewsPerDay > 0);
    assert.equal(applied.correlationId, p.correlationId);
    assert.equal(applied.causationId, result.event.id, 'the action is caused by the approval');
    assert.ok(listExecutedActions(s.dataDir).some((a) => a.type === 'youtube-metadata-change.applied' && /youtube metadata changed on video vid1/.test(a.summary)));

    // calling the executor again for the same proposal never writes twice
    const again = await applyYoutubeMetadataChange(getProposal(s.dataDir, p.id), { dataDir: s.dataDir, instanceConfig: s.instanceConfig });
    assert.equal(again.alreadyApplied, true);
    assert.equal(s.fake.state.updates.length, 1);
  } finally { await s.done(); }
});

test('conflict: a video edited after the proposal is never overwritten; the refusal is recorded and visible', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    s.fake.state.videos.get('vid1').snippet.title = 'Edited by a human in Studio';
    const result = await decideProposal(s.dataDir, p.id, 'approved', 'ok', 'chris', 'cli', s.instanceConfig);
    assert.equal(result.executionResult.applied, false);
    assert.match(result.executionResult.reason, /conflict/);
    assert.equal(s.fake.state.updates.length, 0);
    const [failed] = queryEvents(s.dataDir, { type: 'youtube-metadata-change.failed' });
    assert.equal(failed.payload.conflict, true);
    assert.deepEqual(failed.payload.driftedFields, ['title']);
    assert.equal(queryEvents(s.dataDir, { type: 'youtube-metadata-change.applied' }).length, 0);
    assert.equal(getProposal(s.dataDir, p.id).status, 'approved', 'the human decision stands; only the write was refused');
  } finally { await s.done(); }
});

test('a change to a field the proposal does not touch (description) still counts as a conflict via the snippet hash', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    s.fake.state.videos.get('vid1').snippet.description = 'Someone added links';
    const result = await applyYoutubeMetadataChange({ ...getProposal(s.dataDir, p.id), status: 'approved' }, { dataDir: s.dataDir, instanceConfig: s.instanceConfig });
    assert.equal(result.applied, false);
    assert.match(result.reason, /conflict/);
    assert.equal(s.fake.state.updates.length, 0);
  } finally { await s.done(); }
});

test('without OAuth the write fails closed (an API key can read but never write) and the proposal stays retryable', async () => {
  const s = await setup({ withOauth: false });
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    const result = await decideProposal(s.dataDir, p.id, 'approved', 'ok', 'chris', 'cli', s.instanceConfig);
    assert.equal(result.executionResult.applied, false);
    assert.match(result.executionResult.reason, /needs OAuth/);
    assert.equal(s.fake.state.updates.length, 0);
    assert.equal(queryEvents(s.dataDir, { type: 'youtube-metadata-change.failed' }).length, 1);

    // fixing the config and retrying applies it exactly once
    const fixed = await setup();
    try {
      const retry = await applyYoutubeMetadataChange({ ...getProposal(s.dataDir, p.id), status: 'approved' }, { dataDir: s.dataDir, instanceConfig: { research: { youtube: { ...fixed.instanceConfig.research.youtube } } } });
      assert.equal(retry.applied, true);
    } finally { await fixed.done(); }
  } finally { await s.done(); }
});

test('an API refusal (quota) is recorded as a failure, not thrown, and nothing is claimed as applied', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    const original = s.fake.state.videos.get('vid1');
    const approved = { ...getProposal(s.dataDir, p.id), status: 'approved' };
    // let the read succeed, then fail the write
    const client = {
      quotaUnitsUsed: 0,
      getVideoSnippet: async () => structuredClone(original.snippet),
      updateVideoSnippet: async () => { const { YoutubeApiError } = await import('../lib/research/youtubeApi.js'); throw new YoutubeApiError('quota', { kind: 'quota' }); }
    };
    const result = await applyYoutubeMetadataChange(approved, { dataDir: s.dataDir, instanceConfig: s.instanceConfig, client });
    assert.equal(result.applied, false);
    assert.match(result.reason, /YouTube refused the update/);
    assert.equal(queryEvents(s.dataDir, { type: 'youtube-metadata-change.applied' }).length, 0);
  } finally { await s.done(); }
});

test('rollback is a new pending proposal that restores the previous values, needs approval, and conflicts if edited since', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    assert.throws(() => proposeYoutubeRollback(s.dataDir, p.id), /never applied/);
    await decideProposal(s.dataDir, p.id, 'approved', 'ok', 'chris', 'cli', s.instanceConfig);

    const rollback = proposeYoutubeRollback(s.dataDir, p.id, { instanceConfig: s.instanceConfig }).proposal;
    assert.equal(rollback.status, 'pending');
    assert.deepEqual(rollback.payload.changes, { title: 'Old title', tags: ['ai', 'agents'] });
    assert.deepEqual(rollback.payload.before, { title: 'A clearer title', tags: ['ai', 'agents', 'pipeline'] });
    assert.equal(rollback.payload.rollbackOf, p.id);
    assert.equal(s.fake.state.updates.length, 1, 'proposing a rollback changes nothing');

    await decideProposal(s.dataDir, rollback.id, 'approved', 'revert', 'chris', 'cli', s.instanceConfig);
    const snippet = s.fake.state.videos.get('vid1').snippet;
    assert.equal(snippet.title, 'Old title');
    assert.deepEqual(snippet.tags, ['ai', 'agents']);
    assert.equal(snippet.description, 'Old description');
    assert.equal(s.fake.state.updates.length, 2);
  } finally { await s.done(); }
});

test('a rejected proposal never executes', async () => {
  const s = await setup();
  try {
    const p = propose(s.dataDir, s.instanceConfig);
    const result = await decideProposal(s.dataDir, p.id, 'rejected', 'not now', 'chris', 'cli', s.instanceConfig);
    assert.equal(result.executed, false);
    assert.equal(s.fake.state.updates.length, 0);
  } finally { await s.done(); }
});
