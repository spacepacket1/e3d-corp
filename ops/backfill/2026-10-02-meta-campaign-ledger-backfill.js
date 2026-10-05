#!/usr/bin/env node
// One-time backfill. The Meta ad campaign switch described below (pausing
// the original HVAC/Free Summary campaigns, replacing them with
// Landing-Page-View-optimized versions) was approved by Chris Bloom and
// executed directly in Meta Ads Manager by the AWS-side e3d-oppscan Claude
// session on 2026-10-02/03 - outside e3d-corp's approval gate entirely,
// since no e3d-corp instance was wired to Oppscan yet at that time.
//
// This script records that it happened, as a Proposal -> Decision -> Action
// chain, so the ledger has no silent gap before the oppscan/ga4 evidence
// adapters (lib/research/oppscanFeed.js, lib/research/ga4.js) start landing
// evidence on top of it. It is NOT asking e3d-corp to execute anything new -
// the real-world change already happened; nothing here calls Meta's API.
// Event timestamps are left at their real append time (today) rather than
// backdated, so the hash-chained log never claims to have recorded this live
// - the real historical dates live in the payload fields instead.
//
// Safe to re-run only in the sense that running it twice creates two
// records; it is NOT idempotent by design (there's no natural dedup key for
// a hand-authored historical note), so run it once and keep this file as
// the permanent record of why those two events exist.

import crypto from 'node:crypto';
import { loadInstance } from '../../lib/config.js';
import { createProposal } from '../../lib/proposals/create.js';
import { decideProposal } from '../../lib/decisions/decide.js';
import { appendEvent } from '../../lib/events/store.js';

async function main() {
  const { dataDir } = loadInstance('futco');
  const correlationId = crypto.randomUUID();

  const { proposal, event: createdEvent } = createProposal(dataDir, {
    type: 'meta-campaign-change',
    payload: {
      summary:
        'Switched both active Meta ad sets from Conversions (Lead event) optimization to Landing Page Views, pausing the original HVAC/Free Summary campaign pair and replacing them with new versions.',
      reasoning:
        'A new pixel with no history could not exit the learning phase at $10-20/day (~50 events/week needed) and ran at $50-75 CPM under Conversions optimization. LPV is expected to raise landing-page visits per dollar; it does NOT guarantee a lower cost per lead - visit-to-lead rate may fall, to be judged after ~1 week / ~100 landing page views per campaign.',
      newCampaigns: [
        {
          name: 'HVAC Scanner - NorCal - Video v3 (LPV)',
          campaignId: '120253137168320589',
          adSetId: '120253137168880589',
          adId: '120253137169250589',
          dailyBudgetUsd: 10
        },
        {
          name: 'Free Summary - US - v2 (LPV)',
          campaignId: '120253137170600589',
          adSetId: '120253137171080589',
          adId: '120253137171590589',
          dailyBudgetUsd: 20
        }
      ],
      pausedCampaigns: [
        { name: 'HVAC v2', campaignId: '120253127787580589' },
        { name: 'Free Summary v1', campaignId: '120253115390010589' }
      ],
      metaAdAccountId: '2355627111640205',
      metaBusiness: 'FutCo LLC',
      actualChangeWindow: '2026-10-02 to 2026-10-03',
      executedExternally: true,
      executedVia: 'Meta Ads Manager, by the AWS-side e3d-oppscan Claude session at Chris Bloom\'s direction',
      backfill: true,
      backfillReason: 'No e3d-corp eventSource/evidence-provider for Oppscan/Meta existed yet when this change was made; recorded after the fact once lib/research/oppscanFeed.js and lib/research/ga4.js were wired up.'
    },
    proposedBy: { role: 'human-direct', provider: 'external', model: 'n/a' },
    causationId: null,
    correlationId
    // instanceConfig intentionally omitted: skip authorityNotify for a
    // decision that was already made and executed days ago.
  });
  process.stdout.write(`proposal.created ${proposal.id} (event ${createdEvent.id})\n`);

  const { event: decisionEvent } = await decideProposal(
    dataDir,
    proposal.id,
    'approved',
    'Approved and executed directly by Chris Bloom in Meta Ads Manager on 2026-10-02/03, outside e3d-corp\'s gate (no instance was wired to Oppscan yet). Backfilled into the ledger on 2026-10-04 so the audit trail has no gap.',
    'spacepacket@gmail.com',
    'cli'
  );
  process.stdout.write(`proposal.approved ${proposal.id} (event ${decisionEvent.id})\n`);

  // authorityLevel is FINANCIAL_ACTION, so decideProposal's approval path
  // does not auto-execute (only EXTERNAL_ACTION does) and there is no
  // registered executor for "meta-campaign-change" - intentional, since
  // confirmAndExecute is for firing a NEW action, not for recording one that
  // already happened. The action record is appended directly instead.
  const actionEvent = appendEvent(dataDir, {
    type: 'meta-campaign-change.recorded',
    source: 'backfill:cli',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      summary: proposal.payload.summary,
      recordedRetroactively: true,
      actualChangeWindow: '2026-10-02 to 2026-10-03'
    },
    causationId: decisionEvent.id,
    correlationId
  });
  process.stdout.write(`meta-campaign-change.recorded ${actionEvent.id}\n`);
}

main().catch((error) => {
  process.stderr.write(`Backfill failed: ${error.message}\n`);
  process.exitCode = 1;
});
