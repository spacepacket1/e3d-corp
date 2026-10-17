// Derived YouTube metrics. Pure functions over a video's sample series (lib/youtube/series.js): no I/O, no clock
// (callers pass `now`), no model. Every function answers "insufficient data" instead of guessing, because a
// monitor that invents a trend from two close-together samples is worse than one that says it cannot tell yet.
//
// Formulas (all thresholds are in lib/youtube/thresholds.js and overridable per instance):
//
//   ageDays(v, t)            = max((t - publishedAt) / 1 day, 0.25)            (floor avoids dividing by ~0 on a fresh upload)
//   viewsPerDay(v)           = views at the latest sample / ageDays at that sample          (lifetime average)
//   windowDelta(v, field, h) = field(latest sample) - field(newest sample at or before latest - h hours)
//                              only valid when that baseline sample is within `windowToleranceHours` of the window start
//   perDay                   = delta / (actual span in hours / 24)             (normalizes a baseline that is a bit off)
//   channelBaseline          = median of viewsPerDay over OTHER videos at least `baselineMinAgeDays` old
//                              (needs >= 2 such videos; otherwise there is no baseline and relative claims are refused)
//   stall                    = age >= stallAfterDays
//                              AND views gained in the last stallWindowHours < stallMaxViewsInWindow
//                              AND viewsPerDay < stallMaxRelativeToMedian x channel median
//   breakout                 = views gained in the last breakoutWindowHours >= breakoutMinViews
//                              AND that window's perDay >= breakoutMultiple x channel median
//   comment spike            = new comments in the last commentWindowHours >= commentMinNew
//   trend                    = (last-24h perDay) / (last-7d perDay): >= 1.5 accelerating, <= 0.5 slowing, else steady
//
// Honest limits: views alone are a weak signal (they mix search, suggestions, shares and bots), and with a handful
// of videos and tens of views the median and the rates are noisy. Treat every flag as "worth a human look".
import { DEFAULT_THRESHOLDS } from './thresholds.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_AGE_DAYS = 0.25;

const at = (value) => new Date(value).getTime();

export function ageDays(publishedAt, when) {
  const age = (at(when) - at(publishedAt)) / DAY_MS;
  return Number.isFinite(age) ? Math.max(age, MIN_AGE_DAYS) : null;
}

export function median(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function samplesWith(video, field, upTo) {
  const limit = upTo === undefined ? Infinity : at(upTo);
  return (video.samples ?? []).filter((s) => typeof s[field] === 'number' && at(s.sampledAt) <= limit);
}

export function latestSample(video, field = 'viewCount', upTo) {
  const list = samplesWith(video, field, upTo);
  return list[list.length - 1] ?? null;
}

export function viewsPerDay(video) {
  const latest = latestSample(video);
  if (!latest || !video.publishedAt) return null;
  const age = ageDays(video.publishedAt, latest.sampledAt);
  if (age === null) return null;
  return { value: latest.viewCount / age, views: latest.viewCount, ageDays: age, sampleEventId: latest.eventId };
}

// Gain in `field` over (about) the last `windowHours`, measured at the latest sample.
export function windowDelta(video, field, windowHours, now, { toleranceHours = DEFAULT_THRESHOLDS.windowToleranceHours } = {}) {
  const latest = latestSample(video, field);
  if (!latest) return { insufficientData: true, reason: `no ${field} samples` };
  if (now !== undefined && at(now) - at(latest.sampledAt) > (windowHours + toleranceHours) * HOUR_MS) {
    return { insufficientData: true, reason: 'latest sample is too old to describe the last window' };
  }
  const windowStart = at(latest.sampledAt) - windowHours * HOUR_MS;
  const candidates = samplesWith(video, field, latest.sampledAt).filter((s) => at(s.sampledAt) <= windowStart);
  const baseline = candidates[candidates.length - 1];
  if (!baseline) return { insufficientData: true, reason: `history shorter than ${windowHours}h` };
  if (windowStart - at(baseline.sampledAt) > toleranceHours * HOUR_MS) {
    return { insufficientData: true, reason: `no sample close to ${windowHours}h before the latest` };
  }
  const spanHours = (at(latest.sampledAt) - at(baseline.sampledAt)) / HOUR_MS;
  const delta = latest[field] - baseline[field];
  return {
    insufficientData: false,
    delta,
    spanHours,
    perDay: delta / (spanHours / 24),
    latestEventId: latest.eventId,
    baselineEventId: baseline.eventId
  };
}

export function channelBaseline(videos, { excludeVideoId, minAgeDays = DEFAULT_THRESHOLDS.baselineMinAgeDays } = {}) {
  const rates = [];
  for (const video of videos) {
    if (video.videoId === excludeVideoId) continue;
    const vpd = viewsPerDay(video);
    if (vpd && vpd.ageDays >= minAgeDays) rates.push(vpd.value);
  }
  if (rates.length < 2) return null;
  return { medianViewsPerDay: median(rates), videoCount: rates.length };
}

export function detectStall(video, videos, now, t = DEFAULT_THRESHOLDS) {
  const vpd = viewsPerDay(video);
  if (!vpd || !video.publishedAt) return { stalled: null, insufficientData: true, reason: 'no view samples' };
  const age = ageDays(video.publishedAt, now);
  if (age < t.stallAfterDays) return { stalled: false, reason: `only ${age.toFixed(1)} days old (needs ${t.stallAfterDays})` };
  const window = windowDelta(video, 'viewCount', t.stallWindowHours, now, { toleranceHours: t.windowToleranceHours });
  if (window.insufficientData) return { stalled: null, insufficientData: true, reason: window.reason };
  const baseline = channelBaseline(videos, { excludeVideoId: video.videoId, minAgeDays: t.baselineMinAgeDays });
  if (!baseline) return { stalled: null, insufficientData: true, reason: 'fewer than 2 other videos to form a channel baseline' };
  const relative = baseline.medianViewsPerDay > 0 ? vpd.value / baseline.medianViewsPerDay : null;
  const stalled = window.delta < t.stallMaxViewsInWindow && relative !== null && relative < t.stallMaxRelativeToMedian;
  return {
    stalled,
    insufficientData: false,
    viewsInWindow: window.delta,
    windowHours: window.spanHours,
    viewsPerDay: vpd.value,
    medianViewsPerDay: baseline.medianViewsPerDay,
    relativeToMedian: relative,
    baselineVideoCount: baseline.videoCount,
    sampleEventIds: [window.latestEventId, window.baselineEventId]
  };
}

export function detectBreakout(video, videos, now, t = DEFAULT_THRESHOLDS) {
  const window = windowDelta(video, 'viewCount', t.breakoutWindowHours, now, { toleranceHours: t.windowToleranceHours });
  if (window.insufficientData) return { breakout: null, insufficientData: true, reason: window.reason };
  const baseline = channelBaseline(videos, { excludeVideoId: video.videoId, minAgeDays: t.baselineMinAgeDays });
  if (!baseline) return { breakout: null, insufficientData: true, reason: 'fewer than 2 other videos to form a channel baseline' };
  const multiple = baseline.medianViewsPerDay > 0 ? window.perDay / baseline.medianViewsPerDay : null;
  const breakout = window.delta >= t.breakoutMinViews && multiple !== null && multiple >= t.breakoutMultiple;
  return {
    breakout,
    insufficientData: false,
    viewsInWindow: window.delta,
    windowHours: window.spanHours,
    viewsPerDayInWindow: window.perDay,
    medianViewsPerDay: baseline.medianViewsPerDay,
    multipleOfMedian: multiple,
    baselineVideoCount: baseline.videoCount,
    sampleEventIds: [window.latestEventId, window.baselineEventId]
  };
}

export function detectCommentSpike(video, now, t = DEFAULT_THRESHOLDS) {
  const window = windowDelta(video, 'commentCount', t.commentWindowHours, now, { toleranceHours: t.windowToleranceHours });
  if (window.insufficientData) return { spike: null, insufficientData: true, reason: window.reason };
  return {
    spike: window.delta >= t.commentMinNew,
    insufficientData: false,
    newComments: window.delta,
    windowHours: window.spanHours,
    sampleEventIds: [window.latestEventId, window.baselineEventId]
  };
}

export function trend(video, now, t = DEFAULT_THRESHOLDS) {
  const day = windowDelta(video, 'viewCount', 24, now, { toleranceHours: t.windowToleranceHours });
  const week = windowDelta(video, 'viewCount', 24 * 7, now, { toleranceHours: t.windowToleranceHours });
  if (day.insufficientData || week.insufficientData || week.perDay <= 0) return { label: 'unknown' };
  const ratio = day.perDay / week.perDay;
  return { label: ratio >= 1.5 ? 'accelerating' : ratio <= 0.5 ? 'slowing' : 'steady', ratio, perDay24h: day.perDay, perDay7d: week.perDay };
}

// Everything the report and the scan need for one video, computed the same way in both places.
export function analyzeVideo(video, videos, now, t = DEFAULT_THRESHOLDS) {
  return {
    videoId: video.videoId,
    title: video.title,
    publishedAt: video.publishedAt,
    ageDays: video.publishedAt ? ageDays(video.publishedAt, now) : null,
    latest: latestSample(video),
    viewsPerDay: viewsPerDay(video),
    views24h: windowDelta(video, 'viewCount', 24, now, { toleranceHours: t.windowToleranceHours }),
    views7d: windowDelta(video, 'viewCount', 24 * 7, now, { toleranceHours: t.windowToleranceHours }),
    trend: trend(video, now, t),
    stall: detectStall(video, videos, now, t),
    breakout: detectBreakout(video, videos, now, t),
    comments: detectCommentSpike(video, now, t)
  };
}
