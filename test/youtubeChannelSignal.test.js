import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents, verifyEventChain } from '../lib/events/store.js';
import { createYoutubeClient } from '../lib/research/youtubeApi.js';
import { sampleChannel } from '../lib/event-sources/youtubeChannelSignal.js';
import { buildVideoSeries, videoChainId } from '../lib/youtube/series.js';
import { startFakeYoutube, makeVideo, FAKE_KEY, FAKE_CHANNEL_ID } from './helpers/fakeYoutubeServer.js';

const T0 = new Date('2026-10-17T00:00:00.000Z');
const hours = (n, from = T0) => new Date(from.getTime() + n * 3_600_000);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-youtube-signal-'));
}

function config(fake, extra = {}) {
  return { research: { youtube: { channelId: FAKE_CHANNEL_ID, apiBaseUrl: fake.baseUrl, minSampleIntervalMinutes: 360, ...extra } } };
}

const clientFor = (fake) => createYoutubeClient({ baseUrl: fake.baseUrl, apiKey: FAKE_KEY });

function twoVideos() {
  return [
    makeVideo('aaa', { title: 'Alpha', description: 'first video', tags: ['ai'], publishedAt: '2026-10-10T00:00:00Z', views: 100, likes: 5, comments: 0 }),
    makeVideo('bbb', { title: 'Beta', description: 'second video', publishedAt: '2026-10-15T00:00:00Z', views: 20, likes: 1, comments: 2 })
  ];
}

test('first sample discovers every upload, records snippets, samples stats, and reads new comments', async () => {
  const dataDir = tmp();
  const fake = await startFakeYoutube({
    videos: twoVideos(),
    comments: { bbb: [{ id: 'c1', author: 'Ann', text: 'great one', publishedAt: '2026-10-16T01:00:00Z' }, { id: 'c2', author: 'Bo', text: 'question?', publishedAt: '2026-10-16T02:00:00Z' }] }
  });
  try {
    const result = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: T0 });
    assert.equal(result.skipped, null);
    assert.equal(result.discovered, 2);
    assert.equal(result.sampled, 2);
    assert.equal(result.snippets, 2);
    assert.equal(result.comments, 2, 'only the video whose comment count is > 0 was asked for comments');
    assert.equal(result.degraded, false);
    assert.equal(result.quotaUnitsUsed, 4, 'channel + one playlist page + one video batch + one comment request');

    assert.equal(queryEvents(dataDir, { type: 'youtube.video.discovered' }).length, 2);
    const sampled = queryEvents(dataDir, { type: 'youtube.video.sampled' });
    const alpha = sampled.find((event) => event.payload.videoId === 'aaa');
    assert.equal(alpha.payload.viewCount, 100);
    assert.equal(alpha.payload.sampledAt, T0.toISOString());
    assert.equal(alpha.occurredAt, T0.toISOString(), 'events follow the injected clock');
    assert.equal(alpha.correlationId, videoChainId('aaa'));

    const series = buildVideoSeries(dataDir);
    const beta = series.find((video) => video.videoId === 'bbb');
    assert.equal(beta.snippet.title, 'Beta');
    assert.deepEqual(beta.comments.map((c) => c.commentId), ['c2', 'c1'], 'newest first');
    const chain = verifyEventChain(dataDir);
    assert.equal(chain.valid, true, `the hash chain is intact after sampling (${chain.reason})`);
    assert.ok(chain.chained > 0);
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the minimum sampling interval makes a repeat run a no-op with no API calls', async () => {
  const dataDir = tmp();
  const fake = await startFakeYoutube({ videos: twoVideos() });
  try {
    await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: T0 });
    const callsBefore = fake.state.calls.length;
    const eventsBefore = queryEvents(dataDir).length;

    const soon = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(5) });
    assert.equal(soon.skipped, 'interval');
    assert.equal(soon.nextSampleAt, hours(6).toISOString());
    assert.equal(fake.state.calls.length, callsBefore, 'no request was made inside the interval');
    assert.equal(queryEvents(dataDir).length, eventsBefore, 'no event was written inside the interval');

    fake.setViews('aaa', 130);
    const later = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(7) });
    assert.equal(later.sampled, 2);
    assert.equal(later.discovered, 0, 'known videos are not re-discovered');
    assert.equal(later.snippets, 0, 'an unchanged snippet is not re-recorded');
    const alpha = buildVideoSeries(dataDir).find((video) => video.videoId === 'aaa');
    assert.deepEqual(alpha.samples.map((s) => s.viewCount), [100, 130]);

    const forced = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(8), force: true });
    assert.equal(forced.sampled, 2, 'force bypasses the interval');
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a new upload is discovered later, and an edited title is re-recorded as a snippet change', async () => {
  const dataDir = tmp();
  const fake = await startFakeYoutube({ videos: twoVideos() });
  try {
    await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: T0 });
    fake.addVideo(makeVideo('ccc', { title: 'Gamma', publishedAt: '2026-10-17T05:00:00Z', views: 3 }));
    fake.state.videos.get('aaa').snippet.title = 'Alpha, retitled';

    const next = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(24) });
    assert.equal(next.discovered, 1);
    assert.equal(next.snippets, 2, 'the new video plus the retitled one');
    const alpha = buildVideoSeries(dataDir).find((video) => video.videoId === 'aaa');
    assert.equal(alpha.snippet.title, 'Alpha, retitled');
    assert.notEqual(alpha.samples[0].snippetHash, alpha.samples[1].snippetHash);
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('comments are only fetched when the count grew, and each comment is recorded once', async () => {
  const dataDir = tmp();
  const fake = await startFakeYoutube({ videos: twoVideos(), comments: { bbb: [{ id: 'c1', author: 'Ann', text: 'hi', publishedAt: '2026-10-16T01:00:00Z' }, { id: 'c2', author: 'Bo', text: 'yo', publishedAt: '2026-10-16T02:00:00Z' }] } });
  try {
    await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: T0 });
    const commentCalls = () => fake.state.calls.filter((call) => call.path === '/youtube/v3/commentThreads').length;
    assert.equal(commentCalls(), 1);

    await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(7) });
    assert.equal(commentCalls(), 1, 'unchanged count: no comment request');

    fake.state.comments.bbb.push({ id: 'c3', author: 'Cy', text: 'new!', publishedAt: '2026-10-17T05:00:00Z' });
    fake.setViews('bbb', 40, { comments: 3 });
    const grew = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(14) });
    assert.equal(commentCalls(), 2);
    assert.equal(grew.comments, 1, 'only the unseen comment was recorded');
    assert.equal(queryEvents(dataDir, { type: 'youtube.comment.discovered' }).length, 3);
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a quota error records degraded evidence, writes no numbers, and does not crash or block a retry', async () => {
  const dataDir = tmp();
  const fake = await startFakeYoutube({ videos: twoVideos() });
  try {
    fake.state.failNext = { status: 403, reason: 'quotaExceeded', message: 'quota exhausted' };
    const failed = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: T0 });
    assert.equal(failed.degraded, true);
    assert.equal(failed.sampled, 0);
    assert.equal(failed.errors[0].kind, 'quota');
    assert.equal(queryEvents(dataDir, { type: 'youtube.video.sampled' }).length, 0, 'no invented numbers');

    const degraded = queryEvents(dataDir, { type: 'evidence.gathered' });
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].payload.degraded, true);
    assert.equal(degraded[0].payload.result.status, 'unavailable');
    assert.equal(degraded[0].payload.result.reason, 'quota');
    assert.match(degraded[0].payload.resultSummary, /quota/);

    // the failure did not start the interval clock: an immediate retry samples normally
    const retry = await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: hours(0.1) });
    assert.equal(retry.sampled, 2);
    assert.equal(retry.degraded, false);
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('missing credentials and an unreachable API both degrade instead of throwing; a failed comment fetch keeps the samples', async () => {
  const dataDir = tmp();
  const fake = await startFakeYoutube({ videos: twoVideos() });
  try {
    const noAuth = await sampleChannel({ dataDir, instanceConfig: config(fake), client: createYoutubeClient({ baseUrl: fake.baseUrl }), now: T0 });
    assert.equal(noAuth.degraded, true);
    assert.equal(noAuth.errors[0].kind, 'auth');

    const dead = await sampleChannel({ dataDir, instanceConfig: config(fake), client: createYoutubeClient({ baseUrl: 'http://127.0.0.1:1', apiKey: FAKE_KEY, timeoutMs: 1500 }), now: T0 });
    assert.equal(dead.degraded, true);
    assert.equal(dead.errors[0].kind, 'network');

    // channel call works, but the comment request fails: the video samples are still recorded
    let calls = 0;
    const flaky = clientFor(fake);
    const original = flaky.listRecentComments;
    flaky.listRecentComments = async (...args) => {
      calls += 1;
      fake.state.failNext = { status: 403, reason: 'quotaExceeded' };
      return original(...args);
    };
    const partial = await sampleChannel({ dataDir, instanceConfig: config(fake), client: flaky, now: hours(1) });
    assert.equal(calls, 1);
    assert.equal(partial.sampled, 2);
    assert.equal(partial.degraded, true);
    assert.match(partial.errors[0].step, /comments for bbb/);
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('hidden statistics are sampled as null, never as zero', async () => {
  const dataDir = tmp();
  const video = makeVideo('hid', { title: 'Hidden', publishedAt: '2026-10-10T00:00:00Z', views: 7 });
  delete video.statistics.likeCount;
  delete video.statistics.commentCount;
  const fake = await startFakeYoutube({ videos: [video] });
  try {
    await sampleChannel({ dataDir, instanceConfig: config(fake), client: clientFor(fake), now: T0 });
    const [event] = queryEvents(dataDir, { type: 'youtube.video.sampled' });
    assert.equal(event.payload.viewCount, 7);
    assert.equal(event.payload.likeCount, null);
    assert.equal(event.payload.commentCount, null);
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
