import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { reconstructChain } from '../lib/events/chain.js';
import { listOpportunities, getOpportunity } from '../lib/opportunities/store.js';
import { scanYoutubeSignals, YOUTUBE_OPPORTUNITY_TYPES } from '../lib/opportunities/youtubeOpportunities.js';
import { NOW, seedVideo, steadySamples, isoAgo } from './helpers/seedYoutube.js';

const config = (extra = {}) => ({ research: { youtube: { channelId: 'UC_TEST', ...extra } } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-youtube-scan-'));

function seedHealthyChannel(dataDir) {
  seedVideo(dataDir, { id: 'old1', ageDays: 20, samples: steadySamples({ ageDays: 20, perDay: 200 }) });
  seedVideo(dataDir, { id: 'old2', ageDays: 15, samples: steadySamples({ ageDays: 15, perDay: 400 }) });
  seedVideo(dataDir, { id: 'old3', ageDays: 12, samples: steadySamples({ ageDays: 12, perDay: 300 }) });
}

function stalledSamples() {
  // 8 days old, ~40 views total and flat for the last 3 days
  return [96, 90, 84, 78, 72, 66, 60, 54, 48, 42, 36, 30, 24, 18, 12, 6, 0].map((hoursAgo) => ({ hoursAgo, views: hoursAgo > 60 ? 38 : 40 }));
}

test('a stalled video becomes a scored Opportunity whose evidence cites the real sampled events', () => {
  const dataDir = tmp();
  try {
    seedHealthyChannel(dataDir);
    const { sampleEvents } = seedVideo(dataDir, { id: 'flat', title: 'The flat one', ageDays: 8, samples: stalledSamples() });
    const result = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW });

    assert.equal(result.created.length, 1);
    const opp = result.created[0];
    assert.equal(opp.type, YOUTUBE_OPPORTUNITY_TYPES.stall);
    assert.equal(opp.status, 'scored');
    assert.equal(opp.pursuable, false, 'internal opportunity, not a sales lead');
    assert.equal(opp.counterparty.kind, 'none');
    assert.match(opp.title, /"The flat one" has stalled/);
    assert.match(opp.description, /Small numbers are noisy/);
    assert.equal(opp.signal.videoId, 'flat');
    assert.ok(opp.score.value > 0 && opp.score.value <= 1);
    assert.deepEqual(opp.proposedBy, { role: 'youtube.scan', provider: 'deterministic', model: 'n/a' });

    // evidence = the evidence.gathered event + the real sample events the numbers came from
    const sampleIds = new Set(sampleEvents.map((e) => e.id));
    const cited = opp.evidence.filter((id) => sampleIds.has(id));
    assert.equal(cited.length, 2, 'cites the latest sample and the 48h baseline sample');
    const evidence = queryEvents(dataDir, { type: 'evidence.gathered' })[0];
    assert.ok(opp.evidence.includes(evidence.id));
    assert.equal(evidence.payload.kind, 'youtube-video-metrics');
    assert.equal(evidence.payload.degraded, false);
    assert.equal(evidence.payload.result.status, 'ok');

    // the causal chain is intact and the store folds the opportunity like any other
    const chain = reconstructChain(dataDir, opp.correlationId).map((e) => e.type);
    assert.deepEqual(chain, ['evidence.gathered', 'youtube.signal.detected', 'opportunity.created', 'opportunity.scored']);
    const events = reconstructChain(dataDir, opp.correlationId);
    assert.equal(events[1].causationId, events[0].id);
    assert.equal(events[2].causationId, events[1].id);
    assert.equal(getOpportunity(dataDir, opp.id).status, 'scored');
    assert.equal(listOpportunities(dataDir, { status: 'scored' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a breakout video is flagged, and a modest day is not', () => {
  const dataDir = tmp();
  try {
    seedHealthyChannel(dataDir);
    seedVideo(dataDir, { id: 'hot', title: 'The hot one', ageDays: 5, samples: [{ hoursAgo: 30, views: 1300 }, { hoursAgo: 24, views: 1400 }, { hoursAgo: 18, views: 1700 }, { hoursAgo: 12, views: 2000 }, { hoursAgo: 6, views: 2200 }, { hoursAgo: 0, views: 2400 }] });
    seedVideo(dataDir, { id: 'ok', title: 'The ok one', ageDays: 5, samples: steadySamples({ ageDays: 5, perDay: 320 }) });
    const result = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW });
    const types = result.created.map((o) => `${o.signal.videoId}:${o.type}`);
    assert.deepEqual(types, [`hot:${YOUTUBE_OPPORTUNITY_TYPES.breakout}`]);
    assert.match(result.created[0].title, /breaking out/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('new comments become a reply opportunity that cites the comment events', () => {
  const dataDir = tmp();
  try {
    seedHealthyChannel(dataDir);
    const { commentEvents } = seedVideo(dataDir, {
      id: 'talk', title: 'People are talking', ageDays: 6,
      samples: steadySamples({ ageDays: 6, perDay: 300, comments: (h) => (h >= 24 ? 2 : 6) }),
      comments: [{ commentId: 'k1', text: 'how did you do the round table?' }, { commentId: 'k2', text: 'subscribed' }, { commentId: 'k3', text: 'is this open source?' }, { commentId: 'k4', text: 'nice' }]
    });
    const result = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW });
    const opp = result.created.find((o) => o.type === YOUTUBE_OPPORTUNITY_TYPES.comments);
    assert.ok(opp);
    assert.match(opp.title, /4 new comments on "People are talking"/);
    const cited = commentEvents.filter((e) => opp.evidence.includes(e.id));
    assert.equal(cited.length, 4);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('scans are idempotent within a signal window, resurface in the next, and a signal with no Opportunity is retryable', () => {
  const dataDir = tmp();
  try {
    seedHealthyChannel(dataDir);
    seedVideo(dataDir, { id: 'flat', ageDays: 8, samples: stalledSamples() });
    const first = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.equal(first.created.length, 1);
    const eventsAfterFirst = queryEvents(dataDir).length;

    const again = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: new Date(NOW.getTime() + 3_600_000) });
    assert.equal(again.created.length, 0);
    assert.equal(again.alreadySignaled.length, 1);
    assert.equal(queryEvents(dataDir).length, eventsAfterFirst, 'no events are written for an already-handled signal');

    // two weeks later the same problem is allowed to surface again (it needs fresh samples to still count)
    const later = new Date(NOW.getTime() + 14 * 24 * 3_600_000);
    seedHealthyChannelAt(dataDir, later);
    seedVideo(dataDir, { id: 'flat', ageDays: 22, from: later, samples: [{ hoursAgo: 60, views: 41 }, { hoursAgo: 12, views: 42 }, { hoursAgo: 0, views: 42 }] });
    const next = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: later });
    assert.ok(next.created.some((o) => o.signal.videoId === 'flat'), 'a new window raises the signal again');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // retry: a crash after the signal but before the Opportunity leaves the signal unhandled
  const crashDir = tmp();
  try {
    seedHealthyChannel(crashDir);
    seedVideo(crashDir, { id: 'flat', ageDays: 8, samples: stalledSamples() });
    appendEvent(crashDir, {
      type: 'youtube.signal.detected', source: 'youtube.scan', subject: { type: 'youtube-signal', id: 'whatever' },
      payload: { signalId: 'whatever', kind: 'stall', videoId: 'flat' }, causationId: null, correlationId: 'orphan-chain'
    });
    assert.equal(scanYoutubeSignals({ dataDir: crashDir, instanceConfig: config(), now: NOW }).created.length, 1);
  } finally {
    fs.rmSync(crashDir, { recursive: true, force: true });
  }
});

function seedHealthyChannelAt(dataDir, from) {
  // re-seed fresh samples near `from` for the baseline videos (the earlier ones are too old to describe this window)
  for (const [id, perDay, ageDays] of [['old1', 200, 34], ['old2', 400, 29], ['old3', 300, 26]]) {
    seedVideo(dataDir, { id, ageDays, from, samples: steadySamples({ ageDays, perDay }) });
  }
}

test('thin data produces no Opportunity and says why; private videos are ignored', () => {
  const dataDir = tmp();
  try {
    seedVideo(dataDir, { id: 'only', ageDays: 8, samples: stalledSamples() });
    const lone = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.equal(lone.created.length, 0);
    assert.ok(lone.insufficientData.some((x) => /baseline/.test(x.reason)));

    seedHealthyChannel(dataDir);
    seedVideo(dataDir, { id: 'secret', ageDays: 8, privacyStatus: 'private', samples: stalledSamples() });
    const result = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.ok(result.created.every((o) => o.signal.videoId !== 'secret'), 'private videos are never flagged');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('per-type weights from config change the score, and thresholds from config change what is flagged', () => {
  const dataDir = tmp();
  try {
    seedHealthyChannel(dataDir);
    seedVideo(dataDir, { id: 'flat', ageDays: 8, samples: stalledSamples() });
    const base = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW }).created[0].score.value;

    const other = tmp();
    seedHealthyChannel(other);
    seedVideo(other, { id: 'flat', ageDays: 8, samples: stalledSamples() });
    const weighted = scanYoutubeSignals({ dataDir: other, instanceConfig: config({ typeWeights: { [YOUTUBE_OPPORTUNITY_TYPES.stall]: 0.5 } }), now: NOW }).created[0].score.value;
    assert.ok(Math.abs(weighted - base * 0.5) < 0.01, `weighted ${weighted} vs base ${base}`);

    const strict = tmp();
    seedHealthyChannel(strict);
    seedVideo(strict, { id: 'flat', ageDays: 8, samples: stalledSamples() });
    const none = scanYoutubeSignals({ dataDir: strict, instanceConfig: config({ thresholds: { stallMaxRelativeToMedian: 0.0001 } }), now: NOW });
    assert.equal(none.created.length, 0, 'a stricter threshold flags nothing');
    for (const dir of [other, strict]) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('timestamps follow the injected clock', () => {
  const dataDir = tmp();
  try {
    seedHealthyChannel(dataDir);
    seedVideo(dataDir, { id: 'flat', ageDays: 8, samples: stalledSamples() });
    const [opp] = scanYoutubeSignals({ dataDir, instanceConfig: config(), now: NOW }).created;
    assert.equal(opp.createdAt, NOW.toISOString());
    assert.equal(queryEvents(dataDir, { type: 'youtube.signal.detected' })[0].occurredAt, NOW.toISOString());
    assert.equal(isoAgo(0), NOW.toISOString());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
