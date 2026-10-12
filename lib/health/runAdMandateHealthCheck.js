import { queryEvents, appendEvent } from '../events/store.js';
import { listProposals } from '../proposals/store.js';
import { AD_MANDATE_PROPOSAL_TYPE, currentAdMandateStatus } from '../proposals/adMandateSchema.js';
import { transitionAdMandateLifecycle } from '../actions/adMandateLifecycle.js';
import { resolveCampaignIdsForMandate, evaluateAdMandateHealth, describeHealthResult } from './adMandateHealth.js';

// The full Phase 3 orchestration (docs/futco-ad-mandate-spec.md): scan every
// active ad_mandate, evaluate its pause_on_metric_degradation rules *and* its
// two always-on spend-ceiling checks (max_daily_spend_usd/max_monthly_spend_usd
// - the literal "what happens if we spend more than $X/day" answer) against
// already-polled Meta-insights evidence, and - only when
// adMandateHealthCheck.autoSuspendEnabled is true - auto-suspend on a
// confirmed breach of either kind. Pulled out of ops/reports/checkAdMandateHealth.js
// so it can be driven directly in tests against a temp dataDir, the same way
// autoDecideUnderMandate/autoProposeFromBriefs are both a library function
// first and a thin ops-script/CLI wrapper second.
export async function runAdMandateHealthCheck(dataDir, instanceConfig, { now = new Date() } = {}) {
  const autoSuspendEnabled = instanceConfig?.adMandateHealthCheck?.autoSuspendEnabled === true;
  const metaConfig = instanceConfig?.research?.meta;

  const activeMandates = listProposals(dataDir, { type: AD_MANDATE_PROPOSAL_TYPE }).filter(
    (proposal) => currentAdMandateStatus(proposal.payload) === 'active'
  );

  if (activeMandates.length === 0) {
    return [{ kind: 'no-active-mandates', message: 'No active ad_mandates to check.' }];
  }

  const insightRows = queryEvents(dataDir, { type: 'evidence.gathered' })
    .filter((event) => event.source === 'research.metaInsights')
    .flatMap((event) => event.payload?.result?.rows ?? []);

  const outcomes = [];

  for (const mandateProposal of activeMandates) {
    const mandate = mandateProposal.payload;
    const campaignIds = resolveCampaignIdsForMandate(mandate, metaConfig);

    if (campaignIds.length === 0) {
      outcomes.push({
        kind: 'insufficient-campaign-mapping',
        mandateId: mandate.mandate_id,
        message:
          `ad_mandate ${mandate.mandate_id}: insufficient data - no Meta campaigns mapped to products [${(mandate.constraints?.allowed_products ?? []).join(', ')}] ` +
          "(set research.meta.campaigns[].product in instance config, or set this mandate's allowed_campaign_ids directly)"
      });
      continue;
    }

    const rows = insightRows.filter((row) => campaignIds.includes(row?.campaignId));
    const results = evaluateAdMandateHealth(mandate, { rows, now });

    for (const result of results) {
      if (result.insufficientData) {
        outcomes.push({
          kind: 'insufficient-data',
          checkKind: result.kind,
          mandateId: mandate.mandate_id,
          metric: result.metric,
          message: `ad_mandate ${mandate.mandate_id} metric "${result.metric}": insufficient data (${result.reason})`
        });
        continue;
      }
      if (!result.breached) {
        outcomes.push({
          kind: 'ok',
          checkKind: result.kind,
          mandateId: mandate.mandate_id,
          metric: result.metric,
          message: `ad_mandate ${mandate.mandate_id}: ok (${describeHealthResult(result)})`
        });
        continue;
      }

      const reason = describeHealthResult(result);

      const breachEvent = appendEvent(dataDir, {
        type: 'ad-mandate.health-check.breach-observed',
        source: 'autonomous:ad-mandate-health-check',
        subject: { type: 'proposal', id: mandateProposal.id },
        payload: { mandateId: mandate.mandate_id, checkKind: result.kind, metric: result.metric, reason, autoSuspendEnabled },
        causationId: null,
        correlationId: mandateProposal.correlationId
      });

      if (!autoSuspendEnabled) {
        outcomes.push({
          kind: 'breach-observed',
          checkKind: result.kind,
          mandateId: mandate.mandate_id,
          metric: result.metric,
          reason,
          event: breachEvent,
          message: `ad_mandate ${mandate.mandate_id}: OBSERVE-ONLY breach - ${reason} (set adMandateHealthCheck.autoSuspendEnabled to act on this)`
        });
        continue;
      }

      const transition = await transitionAdMandateLifecycle(dataDir, {
        mandateProposalId: mandateProposal.id,
        toStatus: 'suspended',
        eventType: 'ad-mandate.auto-suspended',
        reason,
        decidedBy: 'system:ad-mandate-health-check',
        via: 'autonomous-health-check'
      });
      outcomes.push({
        kind: 'auto-suspended',
        checkKind: result.kind,
        mandateId: mandate.mandate_id,
        metric: result.metric,
        reason,
        transition,
        message: `ad_mandate ${mandate.mandate_id}: AUTO-SUSPENDED - ${reason}`
      });
    }
  }

  return outcomes;
}
