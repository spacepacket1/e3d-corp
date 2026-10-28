import { latestPilotSample, num } from './series.js';
import { recordOutcome } from '../outcomes/record.js';
import { queryEvents } from '../events/store.js';

// Replaces the dead research.stripe poll (it needed STRIPE_SECRET_KEY, which e3d-corp never holds). Pilot's own server
// already aggregates revenue, so the monitor records what it reported as a `pilot.revenue.observed` Outcome on the
// sample's own chain. The windows overlap from one sample to the next, so this Outcome is deliberately NOT a positive
// outcome type and is never added into revenueAttributable: it is an observation, not a new dollar.
export function recordPilotRevenueOutcome(dataDir, { sample = latestPilotSample(dataDir) } = {}) {
  if (!sample) return { recorded: false, reason: 'no pilot.metrics.sampled event yet' };
  const r = sample.metrics.revenue ?? {};
  const fields = {
    packsSoldWindow: num(r.packsSoldWindow),
    packsRevenueUsdWindow: num(r.packsRevenueUsdWindow),
    packsRevenueUsd7d: num(r.packsRevenueUsd7d),
    mrrUsd: num(r.mrrUsd),
    plansActive: r.plansActive && typeof r.plansActive === 'object' ? r.plansActive : null,
    refundsWindow: num(r.refundsWindow)
  };
  if (Object.values(fields).every((v) => v === null)) return { recorded: false, reason: 'the sample carried no revenue figures' };

  const id = `pilot-revenue:${sample.event.id}`;
  if (queryEvents(dataDir, { subject: { type: 'outcome', id } }).length > 0) return { recorded: false, reason: 'already recorded for this sample' };

  const result = recordOutcome(dataDir, {
    id,
    correlationId: sample.event.correlationId,
    type: 'pilot.revenue.observed',
    payload: { sampleEventId: sample.event.id, windowHours: sample.metrics.windowHours ?? null, ...fields },
    occurredAt: sample.event.occurredAt,
    source: 'pilot.metrics',
    causationId: sample.event.id
  });
  return { recorded: true, outcome: result.outcome };
}
