#!/usr/bin/env node
// Pulls a rolling revenue report from Stripe's API and lands it as an
// evidence.gathered event via the research adapter (lib/research/stripeRevenue.js).
// Read-only - a GET with the secret key, never a write. Same rolling-window
// shape as the Meta/GA4 polls, not cursor-based: a short poll interval means
// overlapping reads are fine. Run by cron a few times a day.

import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { isPilotConfigured } from '../../lib/pilot/config.js';
import { recordPilotRevenueOutcome } from '../../lib/pilot/revenue.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  // e3d-corp never holds a Stripe secret key (that poll could only fail with STRIPE_SECRET_KEY unset). Once the Pilot
  // monitor is configured, revenue comes from the aggregate pilot.metrics sample instead, so this entry point derives
  // the revenue Outcome from the latest sample, exits 0, and never touches Stripe. See docs/pilot-monitor.md.
  if (isPilotConfigured(config)) {
    const result = recordPilotRevenueOutcome(dataDir);
    process.stdout.write(`Stripe poll superseded by pilot.metrics: ${result.recorded ? `recorded ${result.outcome.id}` : (result.reason ?? 'already recorded')}\n`);
    return;
  }

  const stripe = config.research?.stripe;
  if (!stripe) {
    throw new Error('Instance config has no "research.stripe" configured');
  }

  const apiKeyEnvVar = stripe.apiKeyEnvVar ?? 'STRIPE_SECRET_KEY';
  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(`Env var "${apiKeyEnvVar}" (research.stripe.apiKeyEnvVar) is not set`);
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });

  const result = await researchAdapter.pullStripeRevenue({
    apiKey,
    lookbackDays: stripe.lookbackDays
  });

  if (result.status !== 'ok') {
    process.stderr.write(`Stripe revenue pull degraded: ${result.reason ?? result.summary}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`evidence.gathered ${result.evidenceEventId}: ${result.rowCount} row(s)\n`);
}

main().catch((error) => {
  process.stderr.write(`Stripe revenue poll failed: ${error.message}\n`);
  process.exitCode = 1;
});
