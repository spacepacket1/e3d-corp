#!/usr/bin/env node
// Phase 3 of docs/futco-ad-mandate-spec.md (e3d-pilot): the circuit breaker.
// Evaluates every active ad_mandate's pause_on_metric_degradation rules
// against the Meta-insights evidence already being polled
// (ops/reports/pollMetaInsights.js). Ships in two modes, controlled by
// instanceConfig.adMandateHealthCheck.autoSuspendEnabled (default false):
//   - observe-only (default): logs a breach, never suspends anything - lets
//     a human confirm the signal is trustworthy first.
//   - enabled: on a confirmed breach, auto-suspends the mandate via the same
//     kill switch a human can trigger manually (lib/actions/adMandateLifecycle.js),
//     tagged with the distinct "ad-mandate.auto-suspended" event type so the
//     log always shows this wasn't a human decision.
// Run by cron, same shape as the other polls/scans. The actual logic lives
// in lib/health/runAdMandateHealthCheck.js - this is just the CLI entry
// point onto it.

import { loadInstance } from '../../lib/config.js';
import { runAdMandateHealthCheck } from '../../lib/health/runAdMandateHealthCheck.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);
  const outcomes = await runAdMandateHealthCheck(dataDir, config);

  for (const outcome of outcomes) {
    process.stdout.write(`${outcome.message}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Ad-mandate health check failed: ${error.message}\n`);
  process.exitCode = 1;
});
