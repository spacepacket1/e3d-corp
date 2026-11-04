import { samplePilotMetrics } from '../event-sources/pilotMetrics.js';
import { scanPilotSignals } from '../opportunities/pilotOpportunities.js';
import { recordPilotRevenueOutcome } from './revenue.js';
import { fetchLatestStripeChargeAt } from './stripeActivity.js';

// The scheduled pass: sample -> scan -> revenue outcome. No LLM, and nothing here writes to Pilot or anywhere else.
export async function runPilotPoll({ dataDir, instanceConfig, transport, now = new Date(), force = false, stripeLatestChargeAt }) {
  const sample = await samplePilotMetrics({ dataDir, instanceConfig, transport, now, force });
  const stripeAt = stripeLatestChargeAt !== undefined ? stripeLatestChargeAt : await fetchLatestStripeChargeAt({ instanceConfig });
  const scan = scanPilotSignals({ dataDir, instanceConfig, now, stripeLatestChargeAt: stripeAt });
  const revenue = recordPilotRevenueOutcome(dataDir);
  return { sample, scan, revenue };
}
