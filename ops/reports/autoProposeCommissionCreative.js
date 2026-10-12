#!/usr/bin/env node
// The other loop-closing half of docs/futco-ad-mandate-spec.md Phase 2
// (e3d-pilot), upstream of ops/reports/autoDecideCommissionCreative.js:
// without this running on a schedule, a creative.brief draft
// (creative-brief.drafted event) just sits there until a human manually
// turns it into a commission-creative proposal. Same "poll on a schedule"
// shape as the Meta/Stripe pulls and the auto-decide scan, not a one-off CLI
// action.

import { loadInstance } from '../../lib/config.js';
import { autoProposeFromBriefs } from '../../lib/proposals/autoProposeFromBrief.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const results = autoProposeFromBriefs(dataDir, { instanceConfig: config });

  if (results.length === 0) {
    process.stdout.write('No creative-brief.drafted events found.\n');
    return;
  }

  let proposed = 0;
  let skipped = 0;
  let alreadyProposed = 0;

  for (const result of results) {
    if (result.status === 'proposed') {
      proposed += 1;
      process.stdout.write(`Proposed ${result.proposalId} from brief draft ${result.draftedEventId}\n`);
    } else if (result.status === 'already-proposed') {
      alreadyProposed += 1;
    } else {
      skipped += 1;
      process.stdout.write(`Skipped brief draft ${result.draftedEventId}: ${result.reason}\n`);
    }
  }

  process.stdout.write(
    `Done: ${proposed} proposed, ${skipped} skipped, ${alreadyProposed} already proposed.\n`
  );
}

main().catch((error) => {
  process.stderr.write(`Auto-propose-from-brief pass failed: ${error.message}\n`);
  process.exitCode = 1;
});
