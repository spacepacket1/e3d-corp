#!/usr/bin/env node
// Upstream of ops/reports/autoProposeCommissionCreative.js and
// ops/reports/autoDecideCommissionCreative.js: without this running on a
// schedule, lib/roles/creativeBrief.js's runCreativeBrief never fires except
// by a human running `opportunities draft-creative-brief <id>` one
// opportunity at a time. Same "poll on a schedule" shape as the rest of the
// autonomous loop.

import { loadInstance } from '../../lib/config.js';
import { autoDraftCreativeBriefs } from '../../lib/roles/autoDraftCreativeBriefs.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);
  const results = await autoDraftCreativeBriefs(dataDir, { instanceConfig: config });

  if (results.length === 0) {
    process.stdout.write('No pursuing opportunities found.\n');
    return;
  }

  let drafted = 0;
  let errored = 0;
  let alreadyDrafted = 0;

  for (const result of results) {
    if (result.status === 'drafted') {
      drafted += 1;
      process.stdout.write(`[${result.opportunityId}] drafted creative-brief.drafted event ${result.eventId}\n`);
    } else if (result.status === 'error') {
      errored += 1;
      process.stdout.write(`[${result.opportunityId}] error: ${result.reason}\n`);
    } else {
      alreadyDrafted += 1;
    }
  }

  process.stdout.write(`Done: ${drafted} drafted, ${errored} errored, ${alreadyDrafted} already drafted.\n`);
  if (errored > 0 && drafted === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`Auto-draft-creative-briefs pass failed: ${error.message}\n`);
  process.exitCode = 1;
});
