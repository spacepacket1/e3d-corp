import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { evaluateDegradationRule } from '../health/adMandateHealth.js';

const SIGNAL_EVENT_TYPE = 'ad-performance.degradation_signal.detected';

// The default "is this worth asking a human to look at" bar when
// research.meta.opportunitySignalRules isn't set. Unlike adRiskPolicy (a
// real dollar ceiling that gates spend), getting this slightly wrong only
// changes *when* a human gets asked to review something - it never commits
// money - so a documented engineering default is fine here, the same way
// lib/opportunities/engine.js's own DEDUP_LOOKBACK_DAYS is.
const DEFAULT_OPPORTUNITY_SIGNAL_RULES = [{ metric: 'cost_per_landing_page_view', window_days: 7, degradation_pct: 0.3 }];

function windowAnchor(windowDays, now) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return Math.floor(now.getTime() / windowMs);
}

// One signal per (campaign, metric, window) per window period - so an
// ongoing week-long degradation raises exactly one Opportunity candidate for
// that week, not one on every scan, but a problem that persists past the
// window (or recurs after being marked no-value) is free to surface again in
// the next window period rather than being silenced forever.
function signalId(campaignId, rule, now) {
  return `${campaignId}:${rule.metric}:${rule.window_days}:${windowAnchor(rule.window_days, now)}`;
}

// A signal only counts as "already handled" once it actually produced an
// Opportunity (an opportunity.created event whose causationId is that exact
// signal event's id - engine.js always sets this to triggerEvent.id). If
// opportunity.prospect fails after the signal was recorded (a transient
// provider error, a misconfigured role - this is a real failure mode, not
// hypothetical: it happened on the very first real run against futco's live
// data), the signal must stay retryable on the next scan rather than being
// silently lost forever just because its own event exists.
export function alreadySignaledIds(dataDir) {
  const signalEvents = queryEvents(dataDir, { type: SIGNAL_EVENT_TYPE });
  const handledCausationIds = new Set(
    queryEvents(dataDir, { type: 'opportunity.created' }).map((event) => event.causationId).filter(Boolean)
  );
  const handled = new Set();
  for (const signalEvent of signalEvents) {
    if (handledCausationIds.has(signalEvent.id) && signalEvent.subject?.id) {
      handled.add(signalEvent.subject.id);
    }
  }
  return handled;
}

function rowsByCampaign(dataDir) {
  const byCampaign = new Map();
  const insightEvents = queryEvents(dataDir, { type: 'evidence.gathered' }).filter(
    (event) => event.source === 'research.metaInsights'
  );
  for (const event of insightEvents) {
    for (const row of event.payload?.result?.rows ?? []) {
      if (!row?.campaignId) continue;
      if (!byCampaign.has(row.campaignId)) byCampaign.set(row.campaignId, []);
      byCampaign.get(row.campaignId).push(row);
    }
  }
  return byCampaign;
}

// The ad-outcome loop's own Diagnose-stage trigger (docs/futco-ad-mandate-spec.md
// in e3d-pilot) - mirrors lib/event-sources/oppscanFitSignal.js's shape:
// re-derives its candidate set from the full evidence history every run
// (same crash-safety property - a crash partway through promoting one batch
// can never strand a campaign), scoped to Meta insights only for now. GA4's
// rows have no campaign/product dimension to key degradation off (a
// separate, not-yet-designed problem - see docs), so this never touches GA4
// evidence.
export function collectDegradationCandidates(dataDir, { campaigns, rules, now = new Date() } = {}) {
  const resolvedRules = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_OPPORTUNITY_SIGNAL_RULES;
  const alreadySignaled = alreadySignaledIds(dataDir);
  const byCampaign = rowsByCampaign(dataDir);

  const candidates = [];
  for (const campaign of campaigns ?? []) {
    const rows = byCampaign.get(campaign.campaignId) ?? [];
    for (const rule of resolvedRules) {
      const id = signalId(campaign.campaignId, rule, now);
      if (alreadySignaled.has(id)) continue;
      const result = evaluateDegradationRule(rows, rule, now);
      if (result.insufficientData || !result.breached) continue;
      candidates.push({ id, campaign, rule, result });
    }
  }
  return candidates;
}

// Same two-event shape as recordFitSignal: a fresh, standalone
// evidence.gathered event (its own correlationId) carrying the actual
// numbers, then the signal event referencing it - so when opportunity.prospect
// (via runOpportunityEngine) reconstructs the chain for this correlationId it
// already has concrete, grounded evidence to cite, not just a bare claim.
export function recordDegradationSignal(dataDir, { id, campaign, rule, result }) {
  const correlationId = crypto.randomUUID();

  const evidenceEvent = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.metaInsights',
    subject: { type: 'research', id: crypto.randomUUID() },
    payload: {
      kind: 'ad-performance-degradation',
      query: { campaignId: campaign.campaignId, metric: rule.metric, windowDays: rule.window_days },
      resultSummary:
        `${campaign.label ?? campaign.campaignId}: ${rule.metric} degraded ${(result.degradationPct * 100).toFixed(1)}% ` +
        `over ${rule.window_days}d (prior=${result.priorValue.toFixed(2)} current=${result.currentValue.toFixed(2)})`,
      result: {
        status: 'ok',
        campaignId: campaign.campaignId,
        campaignLabel: campaign.label ?? null,
        product: campaign.product ?? null,
        metric: rule.metric,
        windowDays: rule.window_days,
        threshold: rule.degradation_pct,
        degradationPct: result.degradationPct,
        priorValue: result.priorValue,
        currentValue: result.currentValue
      },
      degraded: true
    },
    correlationId
  });

  const signalEvent = appendEvent(dataDir, {
    type: SIGNAL_EVENT_TYPE,
    source: 'ad-performance.degradationSignal',
    subject: { type: 'ad-performance-signal', id },
    payload: {
      campaignId: campaign.campaignId,
      campaignLabel: campaign.label ?? null,
      product: campaign.product ?? null,
      metric: rule.metric,
      windowDays: rule.window_days,
      threshold: rule.degradation_pct,
      degradationPct: result.degradationPct,
      priorValue: result.priorValue,
      currentValue: result.currentValue
    },
    causationId: evidenceEvent.id,
    correlationId
  });

  return { evidenceEvent, signalEvent };
}
