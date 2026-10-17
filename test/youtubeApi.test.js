import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createYoutubeClient, YoutubeApiError } from '../lib/research/youtubeApi.js';
import { createOAuthTokenProvider, readApiKeyFile } from '../lib/research/youtubeAuth.js';
import { createYoutubeClientFromConfig, resolveYoutubeConfig } from '../lib/research/youtubeConfig.js';
import { validateInstanceConfig } from '../lib/config.js';
import { startFakeYoutube, makeVideo, FAKE_KEY, FAKE_CHANNEL_ID, FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN } from './helpers/fakeYoutubeServer.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-youtube-api-'));
}

function sampleVideos(count) {
  return Array.from({ length: count }, (_, i) =>
    makeVideo(`vid${String(i).padStart(3, '0')}`, { title: `Title ${i}`, publishedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), views: 10 * i, likes: i, comments: i % 3 })
  );
}

test('client lists uploads across pages and fetches video statistics in batches of 50', async () => {
  const fake = await startFakeYoutube({ videos: sampleVideos(120) });
  try {
    fake.state.pageSize = 50;
    const client = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY });
    const playlist = await client.getChannelUploadsPlaylistId(FAKE_CHANNEL_ID);
    assert.equal(playlist, 'UU_FAKE_UPLOADS');
    const ids = await client.listUploadVideoIds(playlist);
    assert.equal(ids.length, 120);
    assert.equal(new Set(ids).size, 120);

    const videos = await client.getVideos(ids);
    assert.equal(videos.length, 120);
    const videoCalls = fake.state.calls.filter((call) => call.path === '/youtube/v3/videos');
    assert.equal(videoCalls.length, 3, '120 ids = 3 batches of at most 50');
    assert.ok(videoCalls.every((call) => call.query.id.split(',').length <= 50));
    assert.deepEqual(videoCalls[0].query.part, 'snippet,statistics,status');

    const v = videos.find((video) => video.id === 'vid007');
    assert.equal(v.viewCount, 70);
    assert.equal(typeof v.viewCount, 'number', 'statistics strings are normalized to numbers');
    // 1 (channels) + 3 (playlist pages) + 3 (video batches) read units
    assert.equal(client.quotaUnitsUsed, 7);
  } finally {
    await fake.close();
  }
});

test('hidden statistics stay null instead of becoming zero', async () => {
  const video = makeVideo('hidden', { publishedAt: '2026-10-01T00:00:00Z' });
  delete video.statistics.likeCount;
  const fake = await startFakeYoutube({ videos: [video] });
  try {
    const client = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY });
    const [got] = await client.getVideos(['hidden']);
    assert.equal(got.likeCount, null);
    assert.equal(got.viewCount, 0);
  } finally {
    await fake.close();
  }
});

test('errors are classified: quota, bad key, not found, server trouble, network, and missing credentials', async () => {
  const fake = await startFakeYoutube({ videos: sampleVideos(1) });
  try {
    const client = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY });

    fake.state.failNext = { status: 403, reason: 'quotaExceeded', message: 'The request cannot be completed because you have exceeded your quota.' };
    await assert.rejects(client.getVideos(['vid000']), (error) => error instanceof YoutubeApiError && error.kind === 'quota' && error.status === 403);

    const badKey = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: 'wrong' });
    await assert.rejects(badKey.getVideos(['vid000']), (error) => error.kind === 'auth');

    fake.state.failNext = { status: 503, reason: 'backendError' };
    await assert.rejects(client.getVideos(['vid000']), (error) => error.kind === 'unavailable');

    await assert.rejects(client.getChannelUploadsPlaylistId('UC_NOT_REAL'), (error) => error.kind === 'not_found');

    const dead = createYoutubeClient({ baseUrl: 'http://127.0.0.1:1', apiKey: FAKE_KEY, timeoutMs: 2000 });
    await assert.rejects(dead.getVideos(['vid000']), (error) => error.kind === 'network');

    const nothing = createYoutubeClient({ baseUrl: fake.baseUrl });
    await assert.rejects(nothing.getVideos(['vid000']), (error) => error.kind === 'auth' && /No YouTube API key/.test(error.message));
  } finally {
    await fake.close();
  }
});

test('comments: newest first, normalized, and a video with comments off is empty not an error', async () => {
  const fake = await startFakeYoutube({
    videos: sampleVideos(2),
    comments: { vid000: [
      { id: 'c1', author: 'Ann', text: 'first', publishedAt: '2026-10-02T00:00:00Z' },
      { id: 'c2', author: 'Bo', text: 'second', publishedAt: '2026-10-03T00:00:00Z', likes: 4 }
    ] }
  });
  try {
    fake.state.commentsDisabledFor.add('vid001');
    const client = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY });
    const { comments, disabled } = await client.listRecentComments('vid000');
    assert.equal(disabled, false);
    assert.deepEqual(comments.map((c) => c.commentId), ['c2', 'c1']);
    assert.equal(comments[0].likeCount, 4);
    const off = await client.listRecentComments('vid001');
    assert.deepEqual(off, { comments: [], disabled: true });
  } finally {
    await fake.close();
  }
});

test('the write call needs OAuth: an API key alone is refused before any request is made', async () => {
  const fake = await startFakeYoutube({ videos: sampleVideos(1) });
  try {
    const client = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY });
    const before = fake.state.calls.length;
    await assert.rejects(client.updateVideoSnippet('vid000', { title: 't', categoryId: '28' }), (error) => error.kind === 'auth' && /OAuth/.test(error.message));
    assert.equal(fake.state.calls.length, before, 'no network call was made');
  } finally {
    await fake.close();
  }
});

test('OAuth provider refreshes from files, never writes them, and explains a 7-day expiry', async () => {
  const fake = await startFakeYoutube({ videos: sampleVideos(1) });
  const dir = tmpDir();
  try {
    const tokenFile = path.join(dir, 'tokens.json');
    const clientSecretFile = path.join(dir, 'client.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'stale', expiry_date: 1, refresh_token: FAKE_REFRESH_TOKEN }));
    fs.writeFileSync(clientSecretFile, JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }));
    const tokenBefore = fs.readFileSync(tokenFile, 'utf8');

    const getAccessToken = createOAuthTokenProvider({ tokenFile, clientSecretFile, tokenUrl: fake.tokenUrl });
    assert.equal(await getAccessToken(), FAKE_ACCESS_TOKEN);
    assert.equal(await getAccessToken(), FAKE_ACCESS_TOKEN);
    assert.equal(fake.state.tokenRequests, 1, 'the refreshed token is cached in memory');
    assert.equal(fs.readFileSync(tokenFile, 'utf8'), tokenBefore, 'the token file is never rewritten');

    // a valid, unexpired access token in the file is used without any refresh
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'still-good', expiry_date: Date.now() + 3_600_000, refresh_token: FAKE_REFRESH_TOKEN }));
    const fresh = createOAuthTokenProvider({ tokenFile, clientSecretFile, tokenUrl: fake.tokenUrl });
    assert.equal(await fresh(), 'still-good');
    assert.equal(fake.state.tokenRequests, 1);

    // an expired refresh token produces an actionable message and no token
    fake.state.refreshTokenValid = false;
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'stale', expiry_date: 1, refresh_token: FAKE_REFRESH_TOKEN }));
    const expired = createOAuthTokenProvider({ tokenFile, clientSecretFile, tokenUrl: fake.tokenUrl });
    await assert.rejects(expired(), (error) => error.kind === 'auth' && /7 days/.test(error.message) && !error.message.includes(FAKE_REFRESH_TOKEN));

    // it can be used end to end for the one write
    fake.state.refreshTokenValid = true;
    const client = createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY, getAccessToken: createOAuthTokenProvider({ tokenFile, clientSecretFile, tokenUrl: fake.tokenUrl }) });
    const snippet = await client.getVideoSnippet('vid000');
    await client.updateVideoSnippet('vid000', { ...snippet, title: 'New title' });
    assert.equal(fake.state.updates.length, 1);
    assert.equal(fake.state.videos.get('vid000').snippet.title, 'New title');
    assert.equal(client.quotaUnitsUsed, 1 + 50);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an API key file must be private', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, `${FAKE_KEY}\n`, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.throws(() => readApiKeyFile(file), /chmod 600/);
    fs.chmodSync(file, 0o600);
    assert.equal(readApiKeyFile(file), FAKE_KEY);
    fs.writeFileSync(file, '\n');
    assert.throws(() => readApiKeyFile(file), /empty/);
    assert.throws(() => readApiKeyFile(path.join(dir, 'missing')), /Cannot read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client-from-config prefers the env var key, then the key file, then OAuth, and validates the config block', async () => {
  const fake = await startFakeYoutube({ videos: sampleVideos(1) });
  const dir = tmpDir();
  try {
    const instanceConfig = { research: { youtube: { channelId: FAKE_CHANNEL_ID, apiBaseUrl: fake.baseUrl, apiKeyEnvVar: 'E3D_TEST_YT_KEY' } } };
    const client = createYoutubeClientFromConfig(instanceConfig, { env: { E3D_TEST_YT_KEY: FAKE_KEY } });
    assert.equal((await client.getVideos(['vid000'])).length, 1);

    const keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, FAKE_KEY, { mode: 0o600 });
    const viaFile = createYoutubeClientFromConfig({ research: { youtube: { ...instanceConfig.research.youtube, apiKeyFile: keyFile } } }, { env: {} });
    assert.equal((await viaFile.getVideos(['vid000'])).length, 1);

    const none = createYoutubeClientFromConfig(instanceConfig, { env: {} });
    await assert.rejects(none.getVideos(['vid000']), (error) => error.kind === 'auth');

    assert.throws(() => resolveYoutubeConfig({ research: {} }), /channelId/);
    const base = { name: 'x', dataDir: 'd', eventSources: [], roles: {}, llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'A', modelEnvVar: 'B' } } }, research: { webSearchProvider: 'disabled' } };
    assert.equal(validateInstanceConfig({ ...base, research: { ...base.research, youtube: { channelId: 'UC1', minSampleIntervalMinutes: 60, thresholds: { breakoutMultiple: 4 } } } }).valid, true);
    const bad = validateInstanceConfig({ ...base, research: { ...base.research, youtube: { thresholds: { breakoutMultiple: -1 }, oauth: { tokenFile: 't' } } } });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some((e) => /channelId/.test(e)));
    assert.ok(bad.errors.some((e) => /breakoutMultiple/.test(e)));
    assert.ok(bad.errors.some((e) => /clientSecretFile/.test(e)));
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
