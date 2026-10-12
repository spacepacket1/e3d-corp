import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { getMetaCampaignStatus, setMetaCampaignStatus } from '../research/metaCampaignControl.js';

const META_CAMPAIGN_CHANGE_TYPE = 'meta-campaign-change';

function existingApplicationEvent(dataDir, proposalId) {
  const events = queryEvents(dataDir, { type: 'meta-campaign-change.applied' });
  return events.find((event) => event.payload?.proposalId === proposalId) ?? null;
}

// The real Meta-write executor docs/futco-ad-mandate-spec.md's Phase 4
// section described and deliberately left unauthorized, built 2026-10-12 on
// Chris Bloom's explicit, separate go-ahead ("build it into the ability for
// e3d-corp futco to pause and start ads"). Authority level is
// FINANCIAL_ACTION (lib/authority/policy.js's "meta-campaign-change" entry,
// defined since before this session specifically for this executor) - so
// approving the proposal never fires this on its own; confirmAndExecute's
// separate, explicit second step is the only way it runs, exactly the
// friction the authority ladder requires for a real-money action. The
// narrowest possible write: only the campaign's top-level ACTIVE/PAUSED
// status, nothing about budget, targeting, or creative.
export async function changeMetaCampaignStatus(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, META_CAMPAIGN_CHANGE_TYPE);

  const { dataDir, causationId = null, correlationId, instanceConfig } = ctx;
  if (!dataDir) {
    throw new Error('changeMetaCampaignStatus requires a dataDir');
  }

  const priorEvent = existingApplicationEvent(dataDir, proposal.id);
  if (priorEvent) {
    return { applied: false, idempotent: true, event: priorEvent };
  }

  const { campaignId, campaignLabel, toStatus } = proposal.payload ?? {};
  if (typeof campaignId !== 'string' || campaignId.trim() === '') {
    throw new Error(`Proposal ${proposal.id} is missing campaignId; refusing to change a Meta campaign`);
  }

  const metaConfig = instanceConfig?.research?.meta;
  const tokenEnvVar = metaConfig?.tokenEnvVar ?? 'META_ADS_READ_TOKEN';
  const token = (ctx.token ?? process.env[tokenEnvVar]) || null;
  if (!token) {
    throw new Error(`Cannot change Meta campaign status: env var "${tokenEnvVar}" (research.meta.tokenEnvVar) is not set`);
  }

  const getStatus = ctx.getMetaCampaignStatus ?? getMetaCampaignStatus;
  const setStatus = ctx.setMetaCampaignStatus ?? setMetaCampaignStatus;

  const before = await getStatus({ token, campaignId });
  const result = await setStatus({ token, campaignId, status: toStatus });

  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const event = append({
    type: 'meta-campaign-change.applied',
    source: 'action:meta-campaign-change',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      campaignId,
      campaignLabel: campaignLabel ?? before.name ?? null,
      fromStatus: before.status,
      toStatus: result.status,
      appliedAt: new Date().toISOString()
    },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });

  return { applied: true, idempotent: false, fromStatus: before.status, toStatus: result.status, event };
}
