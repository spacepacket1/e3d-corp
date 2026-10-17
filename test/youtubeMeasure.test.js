import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { measureAppliedChanges, measureOne, HORIZONS } from '../lib/youtube/measure.js';
import { buildVideoSeries, videoChainId } from '../lib/youtube/series.js';
import { resolveThresholds } from '../lib/youtube/thresholds.js';
import { assembleExperience } from '../lib/experience/assemble.js';
import { listOutcomes } from '../lib/outcomes/store.js';
import { OUTCOME_TYPES } from '../lib/outcomes/schema.js';
import { POSITIVE_OUTCOME_TYPES } from '../lib/evaluation/metrics.js';
import { listLatestExperience } from '../lib/experience/store.js';
import { seedVideo } from './helpers/seedYoutube.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-youtube-measure-'));
const H = 3_600_000;
const APPLIED = new Date('2026-10-10T00:00:00.000Z');
const at = (hours) => new Date(APPLIED.getTime() + hours * H);

// seedVideo measures hoursAgo from `from`; use the end of the series as "now" so hoursAgo can be positive
const NOW = at(200);

// samples every 6h from -180h to +200h around APPLIED (so both the 24h and 7d windows are covered)
function seedSeries(dataDir, id, perDay) {
  const samples = [];
  let views = 1000;
  for (let h = -180; h <= 200; h += 6) {
    samples.push({ hoursAgo: 200 - h, views: Math.round(views) });
    views += (h < 0 ? perDay.before : perDay.after) / 4;
  }
  seedVideo(dataDir, { id, ageDays: 30, from: NOW, samples });
}

function appliedEvent(dataDir, proposalId = 'p1', videoId = 'target') {
  // a minimal proposal chain: proposal.created then applied, on the chain recordOutcome will attach to
  const chain = videoChainId(videoId);
  return appendEvent(dataDir, {
    type: 'youtube-metadata-change.applied', source: 'action:youtube-metadata-change', subject: { type: 'proposal', id: proposalId },
    payload: { proposalId, videoId, appliedAt: APPLIED.toISOString(), before: { title: 'a' }, after: { title: 'b' }, baseline: {} },
    causationId: null, correlationId: chain, occurredAt: APPLIED.toISOString()
  });
}

test('a lift beyond the channel-wide movement is "improved", with the evidence samples cited and caveats attached', () => {
  const dataDir = tmp();
  try {
    seedSeries(dataDir, 'target', { before: 100, after: 200 });
    seedSeries(dataDir, 'c1', { before: 100, after: 100 });
    seedSeries(dataDir, 'c2', { before: 300, after: 300 });
    appliedEvent(dataDir);
    const { recorded, skipped } = measureAppliedChanges(dataDir, { instanceConfig: {}, now: NOW });
    assert.equal(recorded.length, 2, `24h and 7d horizons; skipped: ${JSON.stringify(skipped)}`);
    const day = recorded.find((r) => r.outcome.payload.horizon === '24h').outcome.payload;
    assert.equal(day.verdict, 'improved');
    assert.ok(Math.abs(day.ratio - 2) < 0.1, `ratio ${day.ratio}`);
    assert.ok(Math.abs(day.controlRatio - 1) < 0.05);
    assert.ok(day.caveats.includes('correlation_not_causation'));
    assert.equal(day.evidenceSampleEventIds.length, 3);
    const seriesIds = new Set(buildVideoSeries(dataDir).flatMap((v) => v.samples.map((s) => s.eventId)));
    assert.ok(day.evidenceSampleEventIds.every((id) => seriesIds.has(id)), 'cites real sample events');
    assert.equal(recorded[0].outcome.type, 'youtube.metadata_change.measured');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the channel moving the same way cancels out: a rise everywhere is inconclusive, not a win', () => {
  const dataDir = tmp();
  try {
    seedSeries(dataDir, 'target', { before: 100, after: 200 });
    seedSeries(dataDir, 'c1', { before: 100, after: 200 });
    seedSeries(dataDir, 'c2', { before: 300, after: 600 });
    appliedEvent(dataDir);
    const { recorded } = measureAppliedChanges(dataDir, { instanceConfig: {}, now: NOW });
    const day = recorded.find((r) => r.outcome.payload.horizon === '24h').outcome.payload;
    assert.equal(day.verdict, 'inconclusive');
    assert.ok(Math.abs(day.relativeLift - 1) < 0.1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a drop is "declined"; with no control videos the caveat says the channel trend was not removed', () => {
  const dataDir = tmp();
  try {
    seedSeries(dataDir, 'target', { before: 200, after: 80 });
    appliedEvent(dataDir);
    const { recorded } = measureAppliedChanges(dataDir, { instanceConfig: {}, now: NOW });
    const day = recorded[0].outcome.payload;
    assert.equal(day.verdict, 'declined');
    assert.equal(day.controlRatio, null);
    assert.ok(day.caveats.includes('no_control_videos_so_channel_wide_movement_is_not_removed'));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('too little time, too few views, or no nearby samples: skipped with a reason, nothing recorded', () => {
  const dataDir = tmp();
  try {
    seedSeries(dataDir, 'target', { before: 100, after: 200 });
    appliedEvent(dataDir);
    const early = measureAppliedChanges(dataDir, { instanceConfig: {}, now: at(10) });
    assert.equal(early.recorded.length, 0);
    assert.ok(early.skipped.every((s) => /not enough time/.test(s.reason)));

    const series = buildVideoSeries(dataDir);
    const quiet = measureOne({ series, videoId: 'target', appliedAt: APPLIED.toISOString(), horizonHours: 24, now: NOW, thresholds: { ...resolveThresholds(), measureMinViews: 100000 } });
    assert.match(quiet.reason, /too noisy/);
    const missing = measureOne({ series, videoId: 'ghost', appliedAt: APPLIED.toISOString(), horizonHours: 24, now: NOW, thresholds: resolveThresholds() });
    assert.match(missing.reason, /no samples/);
    const wayBefore = measureOne({ series, videoId: 'target', appliedAt: new Date(APPLIED.getTime() - 400 * H).toISOString(), horizonHours: 24, now: NOW, thresholds: resolveThresholds() });
    assert.equal(wayBefore.skipped, true);
    assert.equal(listOutcomes(dataDir).length, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('measurement is idempotent, lands as an Outcome + Experience on the proposal chain, and is not a "positive" business outcome', () => {
  const dataDir = tmp();
  try {
    seedSeries(dataDir, 'target', { before: 100, after: 200 });
    seedSeries(dataDir, 'c1', { before: 100, after: 100 });
    const applied = appliedEvent(dataDir);
    const first = measureAppliedChanges(dataDir, { instanceConfig: {}, now: NOW });
    const eventCount = queryEvents(dataDir).length;
    const second = measureAppliedChanges(dataDir, { instanceConfig: {}, now: NOW });
    assert.equal(second.recorded.length, 0);
    assert.equal(queryEvents(dataDir).length, eventCount, 'nothing is re-recorded');

    assert.deepEqual(Object.keys(HORIZONS), ['24h', '7d']);
    const outcomes = listOutcomes(dataDir);
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.correlationId === applied.correlationId));
    assert.equal(first.recorded[0].outcome.id.startsWith('youtube-measure:p1:'), true);

    const experience = assembleExperience(dataDir, applied.correlationId);
    assert.equal(experience.outcome.type, 'youtube.metadata_change.measured');
    assert.equal(experience.action.type, 'youtube-metadata-change.applied');
    assert.ok(listLatestExperience(dataDir).length >= 1);
    assert.ok(OUTCOME_TYPES.includes('youtube.metadata_change.measured'));
    assert.ok(!POSITIVE_OUTCOME_TYPES.includes('youtube.metadata_change.measured'));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
