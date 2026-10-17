// Engineering defaults for the YouTube monitor. None of these commit money: getting one slightly wrong only
// changes WHEN a human is asked to look at a video, so documented defaults are fine (same reasoning as
// lib/opportunities/engine.js's DEDUP_LOOKBACK_DAYS). Every one is overridable in research.youtube.thresholds.
//
// The formulas that use them are in docs/youtube-monitor.md and lib/youtube/metrics.js.
export const DEFAULT_THRESHOLDS = Object.freeze({
  // A video must be at least this old to count toward the channel's own baseline (median views/day).
  baselineMinAgeDays: 3,
  // Stall: a video this old whose last `stallWindowHours` added fewer than `stallMaxViewsInWindow` views AND whose
  // lifetime views/day is under `stallMaxRelativeToMedian` x the channel median.
  stallAfterDays: 3,
  stallWindowHours: 48,
  stallMaxViewsInWindow: 10,
  stallMaxRelativeToMedian: 0.25,
  // Breakout: views/day over the last `breakoutWindowHours` is at least `breakoutMultiple` x the channel median
  // AND at least `breakoutMinViews` views were gained in that window (an absolute floor, so tiny numbers never "break out").
  breakoutWindowHours: 24,
  breakoutMultiple: 3,
  breakoutMinViews: 50,
  // Comments: at least this many new comments since the sample ~24h ago.
  commentWindowHours: 24,
  commentMinNew: 2,
  // A delta needs a baseline sample at least this close to the window start (hours of tolerance).
  windowToleranceHours: 12,
  // Re-raise the same signal for the same video at most once per this many days.
  signalWindowDays: 7,
  // Outcome measurement: need at least this many views in the "before" window to call a change meaningful.
  measureMinViews: 30,
  // A change in views/day smaller than this fraction (relative to the channel's own movement) is "inconclusive".
  measureMinRelativeChange: 0.25
});

export function resolveThresholds(overrides = {}) {
  const merged = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key in DEFAULT_THRESHOLDS && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      merged[key] = value;
    }
  }
  return merged;
}
