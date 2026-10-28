import { queryEvents } from '../events/store.js';

export const PILOT_SAMPLED_EVENT = 'pilot.metrics.sampled';
const HOUR_MS = 3_600_000;

// Successful samples, oldest first. Each is { event, at (ms), metrics }.
export function listPilotSamples(dataDir) {
  return queryEvents(dataDir, { type: PILOT_SAMPLED_EVENT })
    .map((event) => ({ event, at: new Date(event.occurredAt).getTime(), metrics: event.payload?.metrics ?? {} }))
    .filter((s) => Number.isFinite(s.at))
    .sort((a, b) => a.at - b.at);
}

export function latestPilotSample(dataDir) {
  const all = listPilotSamples(dataDir);
  return all[all.length - 1] ?? null;
}

// The sample closest to `ageHours` before `reference.at`, only if it is within `toleranceHours` of that target.
// Returns null (never a guess) when the history does not reach back far enough.
export function sampleAround(samples, reference, ageHours, toleranceHours) {
  const target = reference.at - ageHours * HOUR_MS;
  let best = null;
  for (const s of samples) {
    if (s.event.id === reference.event.id) continue;
    const gap = Math.abs(s.at - target);
    if (gap <= toleranceHours * HOUR_MS && (best === null || gap < best.gap)) best = { sample: s, gap };
  }
  return best ? best.sample : null;
}

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
