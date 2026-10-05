#!/usr/bin/env node
// Pulls a rolling campaign-insights report from Meta's Graph API for each
// configured campaign and lands it as an evidence.gathered event via the
// research adapter (lib/research/metaInsights.js). Read-only - the token is
// ads_read-scoped per the ops handoff, this never writes to Meta. Same
// rolling-window shape as the GA4 poll, not cursor-based like the oppscan
// feed: Meta's own insights get revised for a short window after the fact.
// Run by cron a few times a day.

import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const meta = config.research?.meta;
  if (!meta?.campaigns?.length) {
    throw new Error('Instance config has no "research.meta.campaigns" configured');
  }

  const tokenEnvVar = meta.tokenEnvVar ?? 'META_ADS_READ_TOKEN';
  const token = process.env[tokenEnvVar];
  if (!token) {
    throw new Error(`Env var "${tokenEnvVar}" (research.meta.tokenEnvVar) is not set`);
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });
  const campaignIds = meta.campaigns.map((campaign) => campaign.campaignId);

  const result = await researchAdapter.pullMetaInsights({
    token,
    adAccountId: meta.adAccountId,
    campaignIds,
    fields: meta.fields,
    lookbackDays: meta.lookbackDays
  });

  if (result.status !== 'ok') {
    process.stderr.write(`Meta insights pull degraded: ${result.reason ?? result.summary}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`evidence.gathered ${result.evidenceEventId}: ${result.rowCount} row(s) across ${campaignIds.length} campaign(s)\n`);
}

main().catch((error) => {
  process.stderr.write(`Meta insights poll failed: ${error.message}\n`);
  process.exitCode = 1;
});
