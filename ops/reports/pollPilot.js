#!/usr/bin/env node
// Scheduled Pilot pass: fetch the aggregate metrics over ssh (read-only), scan for signals, record the revenue Outcome.
// No LLM, no write to Pilot or anywhere else. Exit 0 ok, 2 degraded (Pilot unreachable / bad output - recorded as
// degraded evidence, never as numbers), 1 misconfigured. A repeat run inside research.pilot.minPollIntervalMinutes makes
// no ssh call. Install nothing automatically: see docs/pilot-monitor.md.
import { loadInstance } from '../../lib/config.js';
import { isPilotConfigured } from '../../lib/pilot/config.js';
import { runPilotPoll } from '../../lib/pilot/poll.js';

async function main() {
  const instanceName = process.argv.includes('--instance') ? process.argv[process.argv.indexOf('--instance') + 1] : 'futco';
  const { config, dataDir } = loadInstance(instanceName);
  if (!isPilotConfigured(config)) throw new Error('Instance config has no "research.pilot" configured (see docs/pilot-monitor.md)');

  const { sample, scan, revenue } = await runPilotPoll({ dataDir, instanceConfig: config, force: process.argv.includes('--force') });
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    skipped: sample.skipped ?? null,
    degraded: sample.degraded === true,
    error: sample.error?.message ?? null,
    newOpportunities: scan.created.map((o) => ({ id: o.id, type: o.type, title: o.title })),
    revenueOutcomeRecorded: revenue.recorded === true
  }));
  if (sample.degraded) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
