// Before/after measurement of an applied youtube-metadata-change.
//
//   rate(a, b)      = (views at last sample <= b  -  views at last sample <= a) / ((b - a) in days)
//   before          = rate(applied - H, applied)            after = rate(applied, applied + H)       H = 24h or 7d
//   ratio           = after / before
//   controlRatio    = (sum of `after` over the channel's OTHER public videos) / (sum of their `before`),
//                     using only videos with samples at all three points
//   relativeLift    = ratio / controlRatio   (just `ratio` when there is no control)
//   verdict         = improved if relativeLift >= 1 + measureMinRelativeChange, declined if <= 1 - that, else inconclusive
//
// The outcome is a MEASUREMENT, always carrying caveats: correlation is not causation, views/day naturally decays as
// a video ages (the control is only a rough correction), and small numbers are noisy. A window with fewer than
// `measureMinViews` views before and after together is skipped, not recorded.
import { queryEvents } from '../events/store.js';
import { recordOutcome } from '../outcomes/record.js';
import { buildVideoSeries } from './series.js';
import { resolveThresholds } from './thresholds.js';

const HOUR = 3_600_000;
export const HORIZONS = Object.freeze({ '24h': 24, '7d': 168 });
export const OUTCOME_TYPE = 'youtube.metadata_change.measured';
const at = (v) => new Date(v).getTime();

function sampleAtOrBefore(video, t, toleranceHours) {
  const list = video.samples.filter((s) => typeof s.viewCount === 'number' && at(s.sampledAt) <= t);
  const s = list[list.length - 1];
  return s && t - at(s.sampledAt) <= toleranceHours * HOUR ? s : null;
}

function rate(video, a, b, tol) {
  const s0 = sampleAtOrBefore(video, a, tol);
  const s1 = sampleAtOrBefore(video, b, tol);
  if (!s0 || !s1 || at(s1.sampledAt) <= at(s0.sampledAt)) return null;
  const days = (at(s1.sampledAt) - at(s0.sampledAt)) / (24 * HOUR);
  const views = s1.viewCount - s0.viewCount;
  return { perDay: views / days, views, days, s0, s1 };
}

export function measureOne({ series, videoId, appliedAt, horizonHours, now, thresholds }) {
  const tol = thresholds.windowToleranceHours;
  const t = at(appliedAt);
  const start = t - horizonHours * HOUR;
  const end = t + horizonHours * HOUR;
  if (at(now) < end) return { skipped: true, reason: `not enough time has passed (needs ${horizonHours}h after the change)` };
  const video = series.find((v) => v.videoId === videoId);
  if (!video) return { skipped: true, reason: 'video has no samples' };
  const before = rate(video, start, t, tol);
  const after = rate(video, t, end, tol);
  if (!before || !after) return { skipped: true, reason: 'no samples close enough to the change time to measure both windows' };
  if (before.views + after.views < thresholds.measureMinViews) {
    return { skipped: true, reason: `only ${before.views + after.views} views across both windows (minimum ${thresholds.measureMinViews}); too noisy to call` };
  }
  if (before.perDay <= 0) return { skipped: true, reason: 'the video had no views in the before window' };

  let controlBefore = 0;
  let controlAfter = 0;
  let controlVideos = 0;
  for (const other of series) {
    if (other.videoId === videoId || other.privacyStatus === 'private') continue;
    const b = rate(other, start, t, tol);
    const a = rate(other, t, end, tol);
    if (b && a) { controlBefore += b.perDay; controlAfter += a.perDay; controlVideos += 1; }
  }
  const ratio = after.perDay / before.perDay;
  const controlRatio = controlVideos > 0 && controlBefore > 0 ? controlAfter / controlBefore : null;
  const relativeLift = controlRatio ? ratio / controlRatio : ratio;
  const min = thresholds.measureMinRelativeChange;
  const verdict = relativeLift >= 1 + min ? 'improved' : relativeLift <= 1 - min ? 'declined' : 'inconclusive';
  const caveats = ['correlation_not_causation', 'views_per_day_decays_with_video_age'];
  if (controlRatio === null) caveats.push('no_control_videos_so_channel_wide_movement_is_not_removed');
  if (controlVideos > 0 && controlVideos < 3) caveats.push('few_control_videos');
  return {
    skipped: false,
    result: {
      beforeViewsPerDay: before.perDay, afterViewsPerDay: after.perDay, ratio,
      controlRatio, controlVideos, relativeLift, verdict, caveats,
      beforeViews: before.views, afterViews: after.views,
      evidenceSampleEventIds: [before.s0.eventId, before.s1.eventId, after.s1.eventId]
    }
  };
}

// Records one Outcome (and so one Experience) per applied change per horizon that has fully elapsed, once.
export function measureAppliedChanges(dataDir, { instanceConfig, now = new Date() } = {}) {
  const thresholds = resolveThresholds(instanceConfig?.research?.youtube?.thresholds);
  const series = buildVideoSeries(dataDir);
  const recorded = [];
  const skipped = [];
  for (const applied of queryEvents(dataDir, { type: 'youtube-metadata-change.applied' })) {
    for (const [label, hours] of Object.entries(HORIZONS)) {
      const outcomeId = `youtube-measure:${applied.payload.proposalId}:${label}`;
      if (queryEvents(dataDir, { subject: { type: 'outcome', id: outcomeId } }).length > 0) continue;
      const m = measureOne({ series, videoId: applied.payload.videoId, appliedAt: applied.payload.appliedAt, horizonHours: hours, now, thresholds });
      if (m.skipped) { skipped.push({ proposalId: applied.payload.proposalId, videoId: applied.payload.videoId, horizon: label, reason: m.reason }); continue; }
      const { outcome, experience } = recordOutcome(dataDir, {
        id: outcomeId,
        correlationId: applied.correlationId,
        type: OUTCOME_TYPE,
        source: 'youtube.measure',
        causationId: applied.id,
        occurredAt: now.toISOString(),
        payload: {
          proposalId: applied.payload.proposalId, videoId: applied.payload.videoId, horizon: label,
          appliedAt: applied.payload.appliedAt, changedFields: Object.keys(applied.payload.after ?? {}),
          ...m.result
        }
      });
      recorded.push({ outcome, experience });
    }
  }
  return { recorded, skipped };
}
