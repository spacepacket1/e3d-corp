#!/usr/bin/env node
// Pulls oppscan.futco.ai's ops feed for new report-completed events and
// lands each batch as an evidence.gathered event via the research adapter
// (lib/research/oppscanFeed.js), resuming from the cursor recorded on the
// last successful pull - no separate state file, same "the event log is
// the source of truth" convention the calendar poll uses for dedup. This is
// evidence, not a lead: the feed deliberately omits contact info, so unlike
// the calendar/e3d-applied event sources this never runs the opportunity
// engine per item. Run by cron every ~15 minutes.

import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { lastOppscanCursor } from '../../lib/research/oppscanFeed.js';

const MAX_PULLS_PER_RUN = 20;

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const feed = config.research?.oppscanFeed;
  if (!feed?.url) {
    throw new Error('Instance config has no "research.oppscanFeed.url" configured');
  }

  const tokenEnvVar = feed.tokenEnvVar ?? 'OPPSCAN_OPS_FEED_TOKEN';
  const token = process.env[tokenEnvVar];
  if (!token) {
    throw new Error(`Env var "${tokenEnvVar}" (research.oppscanFeed.tokenEnvVar) is not set`);
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });

  let cursor = lastOppscanCursor(dataDir);
  let pulls = 0;
  let totalEvents = 0;

  for (;;) {
    const result = await researchAdapter.pullOppscanFeed({
      feedUrl: feed.url,
      token,
      cursor,
      limit: feed.limit
    });
    pulls += 1;

    if (result.status !== 'ok') {
      process.stderr.write(`Oppscan feed pull degraded: ${result.reason ?? result.summary}\n`);
      process.exitCode = 1;
      break;
    }

    totalEvents += result.events.length;
    process.stdout.write(
      `evidence.gathered ${result.evidenceEventId}: ${result.events.length} event(s), cursor ${cursor ?? '(start)'} -> ${result.nextCursor}\n`
    );

    cursor = result.nextCursor;

    if (!result.hasMore) {
      break;
    }
    if (pulls >= MAX_PULLS_PER_RUN) {
      process.stdout.write(
        `Stopping after ${MAX_PULLS_PER_RUN} pulls this run; remaining backlog continues next run.\n`
      );
      break;
    }
  }

  process.stdout.write(`Oppscan feed poll complete: ${pulls} pull(s), ${totalEvents} event(s).\n`);
}

main().catch((error) => {
  process.stderr.write(`Oppscan feed poll failed: ${error.message}\n`);
  process.exitCode = 1;
});
