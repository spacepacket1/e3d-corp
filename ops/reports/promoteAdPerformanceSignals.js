#!/usr/bin/env node
// The ad-outcome loop's missing Diagnose-stage trigger
// (docs/futco-ad-mandate-spec.md in e3d-pilot): until this existed, nothing
// ever turned a degrading Meta campaign metric (rising cost per landing page
// view, etc.) into an Opportunity - evidence just piled up in the log with
// no one looking at it. Mirrors ops/reports/promoteOppscanFitSignals.js:
// detect a new breach, hand it through the same opportunity.prospect role
// every other trigger in this instance uses, let a human decide what to do
// about it (same "no autonomous mandate creation" boundary as everywhere
// else - this only raises an Opportunity, never proposes or activates
// anything).

import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { runOpportunityEngine } from '../../lib/opportunities/engine.js';
import { collectDegradationCandidates, recordDegradationSignal } from '../../lib/event-sources/adPerformanceSignal.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);
  const campaigns = config.research?.meta?.campaigns ?? [];
  if (campaigns.length === 0) {
    process.stdout.write('No Meta campaigns configured.\n');
    return;
  }

  const rules = config.research?.meta?.opportunitySignalRules;
  const candidates = collectDegradationCandidates(dataDir, { campaigns, rules });
  if (candidates.length === 0) {
    process.stdout.write('No new ad-performance degradation signals.\n');
    return;
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });

  for (const candidate of candidates) {
    const { signalEvent } = recordDegradationSignal(dataDir, candidate);
    process.stdout.write(
      `ad-performance.degradation_signal.detected ${signalEvent.id} ` +
        `(campaign ${candidate.campaign.campaignId}, metric=${candidate.rule.metric}, ` +
        `degraded ${(candidate.result.degradationPct * 100).toFixed(1)}%)\n`
    );

    try {
      const { opportunities } = await runOpportunityEngine({
        instanceConfig: config,
        dataDir,
        triggerEvent: signalEvent,
        researchAdapter,
        researchQuery: candidate.campaign.label ?? candidate.campaign.campaignId
      });
      for (const opportunity of opportunities) {
        process.stdout.write(`  -> opportunity ${opportunity.id} "${opportunity.title}" (score=${opportunity.score.value})\n`);
      }
    } catch (error) {
      process.stderr.write(`  opportunity.prospect failed for signal ${signalEvent.id}: ${error.message}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`Ad-performance signal promotion failed: ${error.message}\n`);
  process.exitCode = 1;
});
