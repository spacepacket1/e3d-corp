#!/usr/bin/env node
// The loop-closing half of docs/futco-ad-mandate-spec.md Phase 2 (e3d-pilot):
// without this running on a schedule, autoDecideUnderMandate is just a
// function nobody calls and every commission-creative proposal still waits
// for a human click. This scans pending commission-creative proposals against
// active ad_mandate proposals and auto-decides every match - same "poll on a
// schedule" shape as the Meta/Stripe pulls, not a one-off CLI action.

import { loadInstance } from '../../lib/config.js';
import { listProposals } from '../../lib/proposals/store.js';
import { autoDecideUnderMandate, evaluateMandateCoverage } from '../../lib/decisions/autoDecideUnderMandate.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const pendingCommissions = listProposals(dataDir, { status: 'pending', type: 'commission-creative' });
  if (pendingCommissions.length === 0) {
    process.stdout.write('No pending commission-creative proposals.\n');
    return;
  }

  const mandateProposals = listProposals(dataDir, { type: 'ad_mandate' });

  let decided = 0;
  let skipped = 0;

  for (const proposal of pendingCommissions) {
    const coveringMandate = mandateProposals.find(
      (mandateProposal) => evaluateMandateCoverage(mandateProposal.payload, proposal).covered
    );

    if (!coveringMandate) {
      skipped += 1;
      continue;
    }

    const result = await autoDecideUnderMandate(dataDir, proposal.id, coveringMandate.id, config);
    decided += 1;
    process.stdout.write(
      `Auto-decided ${proposal.id} under ad_mandate ${result.mandateId}${result.executed ? ' (action executed)' : ''}\n`
    );
  }

  process.stdout.write(`Done: ${decided} auto-decided, ${skipped} left pending (no covering active mandate).\n`);
}

main().catch((error) => {
  process.stderr.write(`Auto-decide-under-mandate pass failed: ${error.message}\n`);
  process.exitCode = 1;
});
