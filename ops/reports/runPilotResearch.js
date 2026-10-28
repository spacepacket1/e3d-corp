#!/usr/bin/env node
// Daily Pilot market research: Tavily web search over multi-model/LLM-council/
// debate tools, MCP directories and HN/Reddit mentions, summarized by
// pilot.competitorBrief into a `pilot.competitorBrief.created` event (cited URLs,
// degraded provenance when search fails). Read-only; no Proposal, no action.
import { fileURLToPath } from 'node:url';
import { loadInstance } from '../../lib/config.js';
import { appendEvent } from '../../lib/events/store.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { draftCompetitorBrief, DEFAULT_COMPETITOR_QUERIES } from '../../lib/roles/pilotCompetitorBrief.js';

export async function runPilotResearch({ config, dataDir, llmClient, researchAdapter, log = () => {} } = {}) {
  const adapter = researchAdapter ?? createResearchAdapter(config, { dataDir });
  const queries = config.pilotGrowth?.competitorQueries ?? DEFAULT_COMPETITOR_QUERIES;
  const searches = [];
  for (const query of queries) {
    const result = await adapter.webSearch(query);
    if (result.status !== 'ok') log(`web search degraded for "${query}": ${result.reason ?? result.summary}`);
    searches.push(result);
  }
  const brief = await draftCompetitorBrief({ instanceConfig: config, searches, llmClient });
  const event = appendEvent(dataDir, {
    type: 'pilot.competitorBrief.created',
    source: 'ops.runPilotResearch',
    subject: { type: 'pilotBrief', id: new Date().toISOString().slice(0, 10) },
    payload: { status: brief.status, provenance: brief.provenance, brief: brief.brief, sources: brief.sources, queries },
    correlationId: `pilot-research-${new Date().toISOString().slice(0, 10)}`
  });
  return { ...brief, event };
}

async function main() {
  const args = process.argv.slice(2);
  const instanceName = args.includes('--instance') ? args[args.indexOf('--instance') + 1] : 'futco';
  const { config, dataDir } = loadInstance(instanceName);
  const result = await runPilotResearch({ config, dataDir, log: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(`Pilot research brief: ${result.status}${result.provenance.degraded ? ` (degraded: ${result.provenance.reason})` : ''}, ${result.sources.length} source(s).\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Pilot research run failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
