#!/usr/bin/env node
// Promotes new "strong fit" oppscan reports into opportunity.prospect
// candidates. The feed already computes fitTier server-side (an internal
// qualification signal, never shown to the prospect) - this only decides
// which tier is interesting enough to raise as a signal at all (currently
// "strong" only, configurable via research.oppscanFeed.opportunitySignalFitTiers)
// and hands each one, with its own fresh correlationId, through the same
// opportunity.prospect role every other trigger in this instance uses -
// drafting the actual title/description/counterparty stays the role's job,
// not a deterministic shortcut.
//
// Re-derives its candidate set from the full evidence history every run
// (lib/event-sources/oppscanFitSignal.js) rather than tracking "new since
// last run", so a crash partway through promoting one batch can never
// strand a report. Run by cron less often than the raw feed pull - a new
// strong-fit report doesn't need a same-minute reaction, and this avoids
// firing the LLM role when there's nothing new to promote.

import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { runOpportunityEngine } from '../../lib/opportunities/engine.js';
import { collectCandidateReports, recordFitSignal } from '../../lib/event-sources/oppscanFitSignal.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);
  const fitTiers = config.research?.oppscanFeed?.opportunitySignalFitTiers ?? ['strong'];

  const candidates = collectCandidateReports(dataDir, { fitTiers });
  if (candidates.length === 0) {
    process.stdout.write('No new oppscan fit signals to promote.\n');
    return;
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });

  for (const { report, batchEventId } of candidates) {
    const { signalEvent } = recordFitSignal(dataDir, report, batchEventId);
    process.stdout.write(
      `oppscan.fit_signal.detected ${signalEvent.id} (report ${report.id}, fitTier=${report.data?.fitTier})\n`
    );

    try {
      const { opportunities } = await runOpportunityEngine({
        instanceConfig: config,
        dataDir,
        triggerEvent: signalEvent,
        researchAdapter,
        researchQuery: report.data?.company ?? report.data?.product ?? null
      });
      for (const opportunity of opportunities) {
        process.stdout.write(`  -> opportunity ${opportunity.id} "${opportunity.title}" (score=${opportunity.score.value})\n`);
      }
    } catch (error) {
      process.stderr.write(`  opportunity.prospect failed for report ${report.id}: ${error.message}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`Oppscan fit-signal promotion failed: ${error.message}\n`);
  process.exitCode = 1;
});
