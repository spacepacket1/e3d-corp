import { samplePilotMetrics } from '../event-sources/pilotMetrics.js';
import { scanPilotSignals } from '../opportunities/pilotOpportunities.js';
import { recordPilotRevenueOutcome } from './revenue.js';

// The scheduled pass: sample -> scan -> revenue outcome. No LLM, and nothing here writes to Pilot or anywhere else.
export async function runPilotPoll({ dataDir, instanceConfig, transport, now = new Date(), force = false }) {
  const sample = await samplePilotMetrics({ dataDir, instanceConfig, transport, now, force });
  const scan = scanPilotSignals({ dataDir, instanceConfig, now });
  const revenue = recordPilotRevenueOutcome(dataDir);
  return { sample, scan, revenue };
}
