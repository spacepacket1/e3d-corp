#!/usr/bin/env node
// Scheduled YouTube pass: sample the channel, scan for signals, measure applied changes. Read-only against YouTube
// (API key), no LLM, never writes to the channel. Exit 0 ok, 2 degraded (YouTube unreachable / key bad - recorded as
// degraded evidence, not as numbers), 1 misconfigured. A repeat run inside research.youtube.minSampleIntervalMinutes
// (default 6h) makes no API calls, so a frequent cron line is safe. Install nothing automatically: see docs/youtube-monitor.md.
import { loadInstance } from '../../lib/config.js';
import { createYoutubeClientFromConfig } from '../../lib/research/youtubeConfig.js';
import { runYoutubePoll } from '../../lib/youtube/poll.js';

async function main() {
  const instanceName = process.argv.includes('--instance') ? process.argv[process.argv.indexOf('--instance') + 1] : 'futco';
  const { config, dataDir } = loadInstance(instanceName);
  if (!config.research?.youtube?.channelId) throw new Error('Instance config has no "research.youtube.channelId" configured');

  const result = await runYoutubePoll({ dataDir, instanceConfig: config, client: createYoutubeClientFromConfig(config), force: process.argv.includes('--force') });
  const { sample, scan, measure } = result;
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    sampled: sample.sampled ?? 0, skipped: sample.skipped ?? null, degraded: sample.degraded === true, quotaUnitsUsed: sample.quotaUnitsUsed ?? 0,
    newOpportunities: scan.created.map((o) => ({ id: o.id, type: o.type, title: o.title })),
    measuredOutcomes: measure.recorded.length
  }));
  if (sample.degraded) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
