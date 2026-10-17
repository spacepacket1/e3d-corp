import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageDays, median, viewsPerDay, windowDelta, channelBaseline,
  detectStall, detectBreakout, detectCommentSpike, trend, analyzeVideo
} from '../lib/youtube/metrics.js';
import { DEFAULT_THRESHOLDS, resolveThresholds } from '../lib/youtube/thresholds.js';

const NOW = new Date('2026-10-20T00:00:00.000Z');
const H = 3_600_000;
const iso = (offsetHours, from = NOW) => new Date(from.getTime() + offsetHours * H).toISOString();

// A video published `ageDaysAtNow` days before NOW, with views sampled every 6h following `viewsAt(hoursAgo)`.
function video(id, { ageDaysAtNow, views, comments = () => 0, sampleEveryHours = 6, lastSampleHoursAgo = 0 }) {
  const publishedAt = iso(-ageDaysAtNow * 24);
  const samples = [];
  const start = Math.ceil((ageDaysAtNow * 24) / sampleEveryHours) * sampleEveryHours;
  for (let hoursAgo = Math.min(start, ageDaysAtNow * 24); hoursAgo >= lastSampleHoursAgo; hoursAgo -= sampleEveryHours) {
    samples.push({ eventId: `${id}-s${hoursAgo}`, sampledAt: iso(-hoursAgo), viewCount: Math.round(views(hoursAgo)), likeCount: 0, commentCount: comments(hoursAgo) });
  }
  return { videoId: id, title: id, publishedAt, samples };
}

// steady: reaches `total` views by NOW growing linearly
const steady = (id, ageDaysAtNow, perDay) => video(id, { ageDaysAtNow, views: (h) => perDay * (ageDaysAtNow - h / 24) });

test('median handles empty, odd, even, and non-numeric input', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 9, 3]), 3);
  assert.equal(median([1, 3, 5, 7]), 4);
  assert.equal(median([null, undefined, 4, 'x']), 4);
});

test('ageDays floors a brand-new upload and viewsPerDay uses the age AT the sample, not at now', () => {
  assert.equal(ageDays(iso(-1), NOW), 1 / 24 < 0.25 ? 0.25 : 1 / 24);
  assert.equal(ageDays(iso(-48), NOW), 2);
  const v = steady('a', 10, 100);
  const vpd = viewsPerDay(v);
  assert.ok(Math.abs(vpd.value - 100) < 1, `expected ~100/day, got ${vpd.value}`);
  // a stale series (last sample 5 days ago) is measured at that time, so it is not diluted by 5 empty days
  const stale = video('b', { ageDaysAtNow: 10, views: (h) => 100 * (10 - h / 24), lastSampleHoursAgo: 120 });
  assert.ok(Math.abs(viewsPerDay(stale).value - 100 * 5 / 5) < 20);
  assert.equal(viewsPerDay({ videoId: 'c', publishedAt: iso(-24), samples: [] }), null);
  assert.equal(viewsPerDay({ videoId: 'd', publishedAt: iso(-24), samples: [{ sampledAt: iso(0), viewCount: null }] }), null, 'hidden views are not zero');
});

test('windowDelta: exact baseline, tolerance, short history, stale latest, and null fields', () => {
  const v = steady('a', 10, 100); // +25 per 6h, sampled every 6h
  const d = windowDelta(v, 'viewCount', 24, NOW);
  assert.equal(d.insufficientData, false);
  assert.equal(Math.round(d.delta), 100);
  assert.equal(d.spanHours, 24);
  assert.equal(Math.round(d.perDay), 100);

  const short = steady('s', 0.5, 100); // 12h of history
  const shortDelta = windowDelta(short, 'viewCount', 24, NOW);
  assert.equal(shortDelta.insufficientData, true);
  assert.match(shortDelta.reason, /shorter than 24h/);

  const gappy = { videoId: 'g', publishedAt: iso(-240), samples: [
    { eventId: 'x1', sampledAt: iso(-100), viewCount: 100, commentCount: 0 },
    { eventId: 'x2', sampledAt: iso(0), viewCount: 200, commentCount: 0 }] };
  const gap = windowDelta(gappy, 'viewCount', 24, NOW);
  assert.equal(gap.insufficientData, true, 'baseline 76h before the window start exceeds the 12h tolerance');
  assert.match(gap.reason, /no sample close to/);

  const stale = video('t', { ageDaysAtNow: 10, views: (h) => 100 * (10 - h / 24), lastSampleHoursAgo: 72 });
  assert.equal(windowDelta(stale, 'viewCount', 24, NOW).insufficientData, true);
  assert.match(windowDelta(stale, 'viewCount', 24, NOW).reason, /too old/);

  const hidden = { videoId: 'h', publishedAt: iso(-100), samples: [{ eventId: 'h1', sampledAt: iso(-30), viewCount: 10, commentCount: null }, { eventId: 'h2', sampledAt: iso(0), viewCount: 20, commentCount: null }] };
  assert.equal(windowDelta(hidden, 'commentCount', 24, NOW).insufficientData, true);
});

test('channelBaseline needs two other mature videos and excludes the video under test', () => {
  const a = steady('a', 10, 100);
  const b = steady('b', 10, 300);
  const fresh = steady('fresh', 1, 5000);
  assert.equal(channelBaseline([a], {}), null);
  assert.equal(channelBaseline([a, b], {}).medianViewsPerDay > 0, true);
  const withFresh = channelBaseline([a, b, fresh], {});
  assert.equal(withFresh.videoCount, 2, 'a 1-day-old video is too young for the baseline');
  const excl = channelBaseline([a, b, steady('c', 10, 200)], { excludeVideoId: 'b' });
  assert.equal(excl.videoCount, 2);
  assert.ok(Math.abs(excl.medianViewsPerDay - 150) < 5, `median of 100 and 200 = 150, got ${excl.medianViewsPerDay}`);
});

test('stall: flagged only when old, nearly flat for 48h, and far below the channel median', () => {
  const healthy = [steady('a', 20, 200), steady('b', 15, 400), steady('c', 12, 300)];
  const flat = video('flat', { ageDaysAtNow: 8, views: (h) => (h > 48 ? 40 - (h - 48) * 0 : 40 + (48 - h) * 0.05) }); // ~2 views in 48h, ~5/day lifetime
  const result = detectStall(flat, [...healthy, flat], NOW);
  assert.equal(result.stalled, true);
  assert.equal(result.insufficientData, false);
  assert.ok(result.relativeToMedian < 0.25);
  assert.equal(result.baselineVideoCount, 3);
  assert.equal(result.sampleEventIds.length, 2);

  const slowButAlive = video('alive', { ageDaysAtNow: 8, views: (h) => 40 + (48 - Math.min(h, 48)) * 2 }); // +96 views in 48h
  assert.equal(detectStall(slowButAlive, [...healthy, slowButAlive], NOW).stalled, false, 'still gaining views: not a stall');

  const tooNew = video('new', { ageDaysAtNow: 1, views: () => 3 });
  const young = detectStall(tooNew, [...healthy, tooNew], NOW);
  assert.equal(young.stalled, false);
  assert.match(young.reason, /days old/);

  const loneVideo = detectStall(flat, [flat], NOW);
  assert.equal(loneVideo.stalled, null);
  assert.match(loneVideo.reason, /baseline/);

  const nearMedian = video('mid', { ageDaysAtNow: 8, views: (h) => (h > 48 ? 2200 : 2200 + (48 - h) * 0.05) }); // flat recently but strong lifetime
  assert.equal(detectStall(nearMedian, [...healthy, nearMedian], NOW).stalled, false, 'a strong lifetime average is not a stall');
});

test('breakout needs both the relative multiple and the absolute floor', () => {
  const others = [steady('a', 20, 100), steady('b', 15, 100), steady('c', 12, 100)];
  const hot = video('hot', { ageDaysAtNow: 5, views: (h) => 2000 - h * 30 }); // +720 in the last 24h
  const r = detectBreakout(hot, [...others, hot], NOW);
  assert.equal(r.breakout, true);
  assert.ok(r.multipleOfMedian >= 3);

  const tiny = video('tiny', { ageDaysAtNow: 5, views: (h) => 20 - h * 0.3 }); // +7 in 24h but a huge multiple of a ~2/day median
  const lowOthers = [steady('a', 20, 2), steady('b', 15, 2), steady('c', 12, 2)];
  assert.equal(detectBreakout(tiny, [...lowOthers, tiny], NOW).breakout, false, 'under breakoutMinViews, a big multiple of nothing is not a breakout');

  const mild = video('mild', { ageDaysAtNow: 5, views: (h) => 500 - h * 4 }); // ~+96 vs median 100: 1x
  assert.equal(detectBreakout(mild, [...others, mild], NOW).breakout, false);
  assert.equal(detectBreakout(hot, [hot], NOW).breakout, null, 'no baseline, no breakout claim');
});

test('comment spike counts new comments in the window and tolerates hidden counts', () => {
  const v = video('c', { ageDaysAtNow: 5, views: (h) => 100 - h, comments: (h) => (h >= 24 ? 2 : 5) });
  const spike = detectCommentSpike(v, NOW);
  assert.equal(spike.spike, true);
  assert.equal(spike.newComments, 3);
  const quiet = video('q', { ageDaysAtNow: 5, views: (h) => 100 - h, comments: () => 4 });
  assert.equal(detectCommentSpike(quiet, NOW).spike, false);
  const hiddenComments = video('h', { ageDaysAtNow: 5, views: (h) => 100 - h, comments: () => null });
  assert.equal(detectCommentSpike(hiddenComments, NOW).insufficientData, true);
});

test('trend compares the last day to the last week and refuses with thin data', () => {
  const accel = video('x', { ageDaysAtNow: 9, views: (h) => (h > 24 ? 700 - (h - 24) * 2 : 700 + (24 - h) * 40) });
  assert.equal(trend(accel, NOW).label, 'accelerating');
  const fading = video('y', { ageDaysAtNow: 9, views: (h) => (h > 24 ? 700 - (h - 24) * 4 : 700 + (24 - h) * 0.2) });
  assert.equal(trend(fading, NOW).label, 'slowing');
  const flat = steady('z', 9, 100);
  assert.equal(trend(flat, NOW).label, 'steady');
  assert.equal(trend(steady('n', 0.5, 100), NOW).label, 'unknown');
});

test('thresholds: defaults are frozen, overrides apply only for known non-negative numbers', () => {
  assert.throws(() => { DEFAULT_THRESHOLDS.breakoutMultiple = 99; }, TypeError);
  const t = resolveThresholds({ breakoutMultiple: 5, bogusKey: 1, stallAfterDays: -2, commentMinNew: 'x' });
  assert.equal(t.breakoutMultiple, 5);
  assert.equal(t.stallAfterDays, DEFAULT_THRESHOLDS.stallAfterDays);
  assert.equal(t.commentMinNew, DEFAULT_THRESHOLDS.commentMinNew);
  assert.equal('bogusKey' in t, false);
  // overriding changes behavior
  const others = [steady('a', 20, 100), steady('b', 15, 100), steady('c', 12, 100)];
  const mild = video('mild', { ageDaysAtNow: 5, views: (h) => 500 - h * 14 }); // +336/day vs 100 median = 3.4x
  assert.equal(detectBreakout(mild, [...others, mild], NOW, resolveThresholds({})).breakout, true);
  assert.equal(detectBreakout(mild, [...others, mild], NOW, resolveThresholds({ breakoutMultiple: 6 })).breakout, false);
});

test('analyzeVideo bundles the same numbers the scan and report use', () => {
  const others = [steady('a', 20, 100), steady('b', 15, 100), steady('c', 12, 100)];
  const v = steady('v', 10, 110);
  const analysis = analyzeVideo(v, [...others, v], NOW);
  assert.equal(analysis.videoId, 'v');
  assert.ok(Math.abs(analysis.viewsPerDay.value - 110) < 2);
  assert.equal(analysis.views24h.insufficientData, false);
  assert.equal(analysis.stall.stalled, false);
  assert.equal(analysis.breakout.breakout, false);
  assert.equal(analysis.trend.label, 'steady');
});
