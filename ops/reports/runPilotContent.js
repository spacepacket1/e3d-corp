#!/usr/bin/env node
// Weekly Pilot content run: drafts X/LinkedIn posts (pilot.contentDraft) and,
// with --with-ads, one ad-campaign proposal (pilot.adCopy). Everything lands as
// a pending Proposal for an owner Decision; nothing is posted or spent here.
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadInstance } from '../../lib/config.js';
import { appendEvent, queryEvents } from '../../lib/events/store.js';
import { loadGrowthFacts } from '../../lib/pilot/growthFacts.js';
import { draftPilotContent } from '../../lib/roles/pilotContentDraft.js';
import { draftPilotAdCopy } from '../../lib/roles/pilotAdCopy.js';
import { proposeXPost, proposeLinkedinPost } from '../../lib/proposals/socialPost.js';
import { proposePilotAdCampaign, DEFAULT_MONTHLY_CEILING_USD } from '../../lib/proposals/pilotAdCampaign.js';

export async function runPilotContent({ config, dataDir, withAds = false, llmClient, adLlmClient, log = () => {} } = {}) {
  const { facts, warnings } = loadGrowthFacts(config);
  warnings.forEach((w) => log(`warning: ${w}`));
  const maxDrafts = config.pilotGrowth?.draftsPerWeek ?? 4;
  const summary = { drafts: 0, proposals: [], dropped: 0, adProposal: null, degraded: warnings };

  const existing = new Set(queryEvents(dataDir, { type: 'pilot.contentDraftQueued' }).map((e) => e.payload?.text));
  const result = await draftPilotContent({ instanceConfig: config, facts, maxDrafts, llmClient });
  if (!result.ok) {
    log(`content draft failed: ${result.reason}`);
    summary.degraded.push(result.reason);
  }
  summary.dropped += (result.dropped ?? []).length;

  for (const draft of result.drafts ?? []) {
    if (existing.has(draft.text)) continue;
    const correlationId = crypto.randomUUID();
    const proposedBy = { role: 'pilot.contentDraft', provider: result.provider, model: result.model };
    const draftEvent = appendEvent(dataDir, {
      type: 'pilot.contentDraftQueued',
      source: 'ops.runPilotContent',
      subject: { type: 'pilotDraft', id: crypto.randomUUID() },
      payload: { platform: draft.platform, text: draft.text, citedFacts: draft.citedFacts, citedFactTexts: draft.citedFactTexts, angle: draft.angle },
      correlationId
    });
    const propose = draft.platform === 'x' ? proposeXPost : proposeLinkedinPost;
    const { proposal } = propose(dataDir, {
      text: draft.text,
      citedFacts: draft.citedFactTexts,
      draftId: draftEvent.subject.id,
      proposedBy,
      causationId: draftEvent.id,
      correlationId,
      instanceConfig: config
    });
    summary.drafts += 1;
    summary.proposals.push({ id: proposal.id, type: proposal.type });
  }

  if (withAds) {
    const ceiling = config.pilotGrowth?.adMonthlyCeilingUsd ?? DEFAULT_MONTHLY_CEILING_USD;
    const ad = await draftPilotAdCopy({ instanceConfig: config, facts, monthlyCeilingUsd: ceiling, llmClient: adLlmClient ?? llmClient });
    if (!ad.ok) {
      log(`ad copy failed: ${ad.reason}`);
      summary.degraded.push(`ad copy: ${ad.reason}`);
    } else {
      const { proposal } = proposePilotAdCampaign(dataDir, {
        variants: ad.variants,
        audience: ad.audience,
        budget: ad.budget,
        killRule: ad.killRule,
        rationale: ad.rationale,
        proposedBy: { role: 'pilot.adCopy', provider: ad.provider, model: ad.model },
        instanceConfig: config
      });
      summary.adProposal = proposal.id;
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const instanceName = args.includes('--instance') ? args[args.indexOf('--instance') + 1] : 'futco';
  const { config, dataDir } = loadInstance(instanceName);
  const summary = await runPilotContent({ config, dataDir, withAds: args.includes('--with-ads'), log: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(`Pilot content run: ${summary.drafts} draft proposal(s) queued, ${summary.dropped} draft(s) dropped${summary.adProposal ? ', 1 ad proposal' : ''}.\n`);
  if (summary.degraded.length) process.stdout.write(`Degraded: ${summary.degraded.join(' | ')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Pilot content run failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
