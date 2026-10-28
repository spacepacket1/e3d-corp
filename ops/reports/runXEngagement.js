#!/usr/bin/env node
// Finds relevant public X posts and drafts a FutCo reply grounded in a real
// e3d.ai data point - then stops. Deliberately does NOT post anything: X's
// automation rules restrict unsolicited automated replies, and a suspension
// of FutCo's account would cost the thing this feature exists to build.
// Instead each accepted draft is queued as an x.draftQueued event for a
// human to review and post by hand (see ops/reports/xEngagementDigest.js for
// the review email). Run by cron every couple of hours.
//
// Pipeline per search query: X search (read-only, app-auth bearer token) ->
// spam/reply_settings pre-filter -> engagement floor (skip thin/bot-feeling
// posts nobody has engaged with) -> Jev relevance check against configured
// topics -> a real e3d.ai finding for the matched topic -> reply draft
// (skipped with no LLM call if there's no finding) -> queue.

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGrowthFacts } from '../../lib/pilot/growthFacts.js';
import { loadInstance } from '../../lib/config.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { queryEvents, appendEvent } from '../../lib/events/store.js';
import { isLikelySpam, hasEnoughEngagement, DEFAULT_MIN_ENGAGEMENT } from '../../lib/research/xSpamFilter.js';
import { checkPostRelevance } from '../../lib/research/jevRelevance.js';
import { gatherFindings } from '../../lib/research/e3dFindings.js';
import { draftEngagementReply, draftPilotEngagementReply } from '../../lib/roles/xEngagementReply.js';

const DEFAULT_DRAFTS_PER_RUN = 5;
const DEFAULT_MAX_RESULTS_PER_QUERY = 10;

function resolveMatchedTopicText(matchedTopic, topics) {
  const match = /^topic_(\d+)$/.exec(matchedTopic ?? '');
  if (!match) return null;
  const index = Number(match[1]);
  const topic = topics[index];
  return typeof topic === 'string' ? topic : topic?.description ?? topic?.key ?? null;
}

function alreadyQueuedIds(dataDir) {
  return new Set(queryEvents(dataDir, { type: 'x.draftQueued' }).map((event) => event.subject.id));
}

export const GROUNDINGS = ['pilot', 'e3d-findings'];

// Unset keeps the original e3d-findings behaviour; the Pilot migration sets
// research.x.grounding = 'pilot' explicitly.
export function resolveGrounding(xConfig) {
  const value = xConfig?.grounding ?? 'e3d-findings';
  if (!GROUNDINGS.includes(value)) throw new Error(`research.x.grounding must be one of ${GROUNDINGS.join(', ')}`);
  return value;
}

export async function runXEngagement({
  config,
  dataDir,
  env = process.env,
  researchAdapter = createResearchAdapter(config, { dataDir }),
  relevanceCheck = checkPostRelevance,
  findingsGatherer = gatherFindings,
  llmClient,
  log = (line) => process.stdout.write(`${line}\n`),
  warn = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  const xConfig = config.research?.x;
  if (!xConfig) {
    throw new Error('Instance config has no "research.x" configured');
  }
  const grounding = resolveGrounding(xConfig);

  const bearerToken = env[xConfig.bearerTokenEnvVar];
  // Fallback credentials: lib/research/xSearchClient.js derives an app-only
  // bearer in memory from the OAuth1 consumer pair when the bearer is missing or 401s.
  const consumerKey = env.X_OAUTH1_CONSUMER_KEY;
  const consumerSecret = env.X_OAUTH1_CONSUMER_SECRET;
  if (!bearerToken && !(consumerKey && consumerSecret)) {
    throw new Error(`Env var "${xConfig.bearerTokenEnvVar}" (research.x.bearerTokenEnvVar) is not set, and no X_OAUTH1_CONSUMER_KEY/SECRET fallback`);
  }

  let pilotFacts = null;
  if (grounding === 'pilot') {
    const loaded = loadGrowthFacts(config);
    loaded.warnings.forEach((w) => warn(`warning: ${w}`));
    pilotFacts = loaded.facts;
  }

  const draftsPerRun = xConfig.draftsPerRun ?? DEFAULT_DRAFTS_PER_RUN;
  const queuedIds = alreadyQueuedIds(dataDir);

  let draftsQueued = 0;
  let candidatesSeen = 0;
  const usedFindingTexts = new Set();

  for (const query of xConfig.searchQueries) {
    if (draftsQueued >= draftsPerRun) break;

    const searchResult = await researchAdapter.pullXSearch({
      bearerToken,
      consumerKey,
      consumerSecret,
      query,
      maxResults: DEFAULT_MAX_RESULTS_PER_QUERY
    });
    if (searchResult.status !== 'ok') {
      warn(`X search degraded for "${query}": ${searchResult.reason ?? searchResult.summary}`);
      continue;
    }

    for (const tweet of searchResult.tweets) {
      if (draftsQueued >= draftsPerRun) break;
      if (queuedIds.has(tweet.id)) continue;
      candidatesSeen += 1;

      const spamCheck = isLikelySpam(tweet);
      if (spamCheck.spam) continue;

      const engagementCheck = hasEnoughEngagement(tweet, xConfig.minEngagement ?? DEFAULT_MIN_ENGAGEMENT);
      if (!engagementCheck.enough) continue;

      const relevance = await relevanceCheck({ text: tweet.text, topics: xConfig.topics });
      if (!relevance.relevant) continue;

      const topicText = resolveMatchedTopicText(relevance.matchedTopic, xConfig.topics);
      let draft;
      let finding;
      if (grounding === 'pilot') {
        draft = await draftPilotEngagementReply({ instanceConfig: config, postText: tweet.text, topic: topicText, facts: pilotFacts, llmClient });
        if (!draft.reply) continue;
        finding = { source: `pilot facts: ${draft.citedFacts.join(', ')}`, text: draft.citedFactTexts.join(' | '), factIds: draft.citedFacts };
      } else {
        const findingsResult = await findingsGatherer({
          topic: topicText,
          postText: tweet.text,
          serverPath: xConfig.e3dMcpServerPath,
          excludeFindingTexts: usedFindingTexts
        });
        if (findingsResult.findings.length === 0) continue;
        usedFindingTexts.add(findingsResult.findings[0].text);
        draft = await draftEngagementReply({
          instanceConfig: config,
          postText: tweet.text,
          topic: topicText,
          findings: findingsResult.findings,
          llmClient
        });
        if (!draft.reply) continue;
        finding = findingsResult.findings[0];
      }

      appendEvent(dataDir, {
        type: 'x.draftQueued',
        source: 'ops.runXEngagement',
        subject: { type: 'xDraft', id: tweet.id },
        payload: {
          tweetId: tweet.id,
          tweetUrl: `https://twitter.com/i/web/status/${tweet.id}`,
          postText: tweet.text,
          matchedTopic: topicText,
          finding,
          draftReply: draft.reply,
          searchQuery: query,
          grounding
        },
        correlationId: crypto.randomUUID()
      });
      queuedIds.add(tweet.id);
      draftsQueued += 1;
      log(`Queued draft for tweet ${tweet.id} (topic: ${topicText})`);
    }
  }

  log(`X engagement run complete: ${candidatesSeen} candidate(s) seen, ${draftsQueued} draft(s) queued.`);
  return { candidatesSeen, draftsQueued, grounding };
}

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';
  const { config, dataDir } = loadInstance(instanceName);
  await runXEngagement({ config, dataDir });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`X engagement run failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
