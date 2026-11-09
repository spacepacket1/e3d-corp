#!/usr/bin/env node
// Re-runs the X engagement pipeline (spam filter -> engagement floor -> relevance -> Pilot-grounded draft -> queue) on the
// search results ALREADY STORED as evidence, instead of searching X again. No X call is made, so it costs no X credits.
// Use it after a run that fetched posts but queued nothing, or after fixing a filter, to backfill the morning's drafts.
// Prints how many posts each filter removed, so "0 drafts" can be explained.
// Usage: node ops/reports/replayXEngagement.js --instance futco [--hours 24] [--min-engagement N]
// --min-engagement overrides research.x.minEngagement for this run only (the config file is not changed).
import { loadInstance } from '../../lib/config.js';
import { queryEvents } from '../../lib/events/store.js';
import { isLikelySpam, hasEnoughEngagement, DEFAULT_MIN_ENGAGEMENT } from '../../lib/research/xSpamFilter.js';
import { checkPostRelevance } from '../../lib/research/jevRelevance.js';
import { runXEngagement } from './runXEngagement.js';

// query -> the newest ok result stored for it within the window
export function storedSearchResults(dataDir, { now = new Date(), hours = 24 } = {}) {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const byQuery = new Map();
  for (const e of queryEvents(dataDir, { type: 'evidence.gathered', since })) {
    const p = e.payload ?? {};
    if (p.kind !== 'x-search' || p.result?.status !== 'ok' || !Array.isArray(p.result.tweets)) continue;
    byQuery.set(p.query, p.result); // later events overwrite earlier ones: newest wins
  }
  return byQuery;
}

export async function replayXEngagement({ config: baseConfig, dataDir, hours = 24, now = new Date(), minEngagementOverride = null, relevanceCheck = checkPostRelevance, ...rest }) {
  const config = minEngagementOverride == null ? baseConfig : { ...baseConfig, research: { ...baseConfig.research, x: { ...baseConfig.research.x, minEngagement: minEngagementOverride } } };
  const stored = storedSearchResults(dataDir, { now, hours });
  const minEngagement = config.research?.x?.minEngagement ?? DEFAULT_MIN_ENGAGEMENT;
  const stats = { queries: stored.size, posts: 0, spam: 0, thin: 0, relevant: 0, notRelevant: 0 };
  for (const result of stored.values()) {
    for (const tweet of result.tweets) {
      stats.posts += 1;
      if (isLikelySpam(tweet).spam) stats.spam += 1;
      else if (!hasEnoughEngagement(tweet, minEngagement).enough) stats.thin += 1;
    }
  }
  const researchAdapter = { pullXSearch: async ({ query }) => stored.get(query) ?? { status: 'unavailable', reason: 'no stored result for this query', tweets: [] } };
  const countingRelevance = async (args) => { const r = await relevanceCheck(args); if (r.relevant) stats.relevant += 1; else stats.notRelevant += 1; return r; };
  const run = await runXEngagement({ config, dataDir, researchAdapter, relevanceCheck: countingRelevance, ...rest });
  return { ...run, stats, minEngagement };
}

async function main() {
  const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
  const { config, dataDir } = loadInstance(arg('--instance') ?? 'futco');
  const me = arg('--min-engagement');
  const out = await replayXEngagement({ config, dataDir, hours: Number(arg('--hours') ?? 24), minEngagementOverride: me == null ? null : Number(me) });
  const s = out.stats;
  console.log(`Stored searches: ${s.queries} queries, ${s.posts} posts. Removed as spam: ${s.spam}; under ${out.minEngagement} engagements: ${s.thin}; ` +
    `asked about relevance: ${s.relevant + s.notRelevant} (relevant ${s.relevant}, not relevant ${s.notRelevant}). Drafts queued: ${out.draftsQueued}.`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`Replay failed: ${e.message}`); process.exitCode = 1; });
