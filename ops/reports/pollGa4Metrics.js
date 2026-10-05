#!/usr/bin/env node
// Pulls a rolling session/landing-page report from GA4 for each configured
// property and lands each as an evidence.gathered event via the research
// adapter (lib/research/ga4.js). Unlike the oppscan feed this is not
// cursor-paged - every run re-pulls the trailing N-day window, which
// intentionally overlaps prior pulls (GA4's own numbers get revised for a
// few days after the fact, so there is no stable "new since last time" to
// resume from). Run by cron a few times a day, not every 15 minutes.

import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const ga4 = config.research?.ga4;
  if (!ga4?.properties?.length) {
    throw new Error('Instance config has no "research.ga4.properties" configured');
  }

  const credentialsEnvVar = ga4.credentialsEnvVar ?? 'GOOGLE_APPLICATION_CREDENTIALS';
  const credentialsKeyFile = process.env[credentialsEnvVar];
  if (!credentialsKeyFile) {
    throw new Error(`Env var "${credentialsEnvVar}" (research.ga4.credentialsEnvVar) is not set`);
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });
  const startDate = `${ga4.lookbackDays ?? 7}daysAgo`;

  let failures = 0;
  for (const property of ga4.properties) {
    const label = property.label ?? property.key;
    const result = await researchAdapter.pullGa4Report({
      credentialsKeyFile,
      propertyId: property.propertyId,
      label,
      dimensions: ga4.dimensions,
      metrics: ga4.metrics,
      startDate,
      endDate: 'today'
    });

    if (result.status !== 'ok') {
      process.stderr.write(`GA4 pull degraded for ${label}: ${result.reason ?? result.summary}\n`);
      failures += 1;
      continue;
    }

    process.stdout.write(`evidence.gathered ${result.evidenceEventId}: ${label} - ${result.rowCount} row(s)\n`);
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`GA4 metrics poll failed: ${error.message}\n`);
  process.exitCode = 1;
});
