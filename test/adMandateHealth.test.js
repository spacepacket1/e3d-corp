import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCampaignIdsForMandate, evaluateDegradationRule, evaluateAdMandateHealth, evaluateSpendCeilings } from '../lib/health/adMandateHealth.js';

function row({ date, campaignId = 'camp-1', spend, landingPageViews, clicks = null }) {
  return { date, campaignId, campaignName: 'test', impressions: null, clicks, spend, cpm: null, landingPageViews, costPerLandingPageView: null, actions: [], costPerActionType: [] };
}

function daysAgo(n, from = new Date('2026-10-11T00:00:00.000Z')) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const NOW = new Date('2026-10-11T00:00:00.000Z');

test('resolveCampaignIdsForMandate prefers explicit allowed_campaign_ids over product mapping', () => {
  const mandate = { constraints: { allowed_campaign_ids: ['camp-x'], allowed_products: ['oppscan'] } };
  const metaConfig = { campaigns: [{ campaignId: 'camp-y', product: 'oppscan' }] };
  assert.deepEqual(resolveCampaignIdsForMandate(mandate, metaConfig), ['camp-x']);
});

test('resolveCampaignIdsForMandate falls back to product mapping when allowed_campaign_ids is null', () => {
  const mandate = { constraints: { allowed_campaign_ids: null, allowed_products: ['oppscan'] } };
  const metaConfig = { campaigns: [{ campaignId: 'camp-1', product: 'oppscan' }, { campaignId: 'camp-2', product: 'free-summary' }] };
  assert.deepEqual(resolveCampaignIdsForMandate(mandate, metaConfig), ['camp-1']);
});

test('resolveCampaignIdsForMandate returns no campaigns when nothing is mapped yet (never guesses)', () => {
  const mandate = { constraints: { allowed_campaign_ids: null, allowed_products: ['oppscan'] } };
  const metaConfig = { campaigns: [{ campaignId: 'camp-1' }] }; // no .product set
  assert.deepEqual(resolveCampaignIdsForMandate(mandate, metaConfig), []);
});

test('evaluateDegradationRule reports insufficientData for an unsupported metric name', () => {
  const result = evaluateDegradationRule([], { metric: 'something_unheard_of', window_days: 7, degradation_pct: 0.4 }, NOW);
  assert.equal(result.insufficientData, true);
  assert.match(result.reason, /unsupported metric/);
});

test('evaluateDegradationRule reports insufficientData when a window has no rows', () => {
  const rows = [row({ date: daysAgo(3, NOW), spend: 100, landingPageViews: 50 })];
  const result = evaluateDegradationRule(rows, { metric: 'cost_per_landing_page_view', window_days: 7, degradation_pct: 0.4 }, NOW);
  assert.equal(result.insufficientData, true);
});

test('evaluateDegradationRule detects a real cost degradation (breach) using summed-ratio aggregation', () => {
  const rows = [
    // prior window (7-14 days ago): $2/LPV
    row({ date: daysAgo(10, NOW), spend: 100, landingPageViews: 50 }),
    row({ date: daysAgo(12, NOW), spend: 100, landingPageViews: 50 }),
    // current window (last 7 days): $4/LPV - a 100% increase
    row({ date: daysAgo(2, NOW), spend: 200, landingPageViews: 50 }),
    row({ date: daysAgo(4, NOW), spend: 200, landingPageViews: 50 })
  ];
  const result = evaluateDegradationRule(rows, { metric: 'cpl_usd', window_days: 7, degradation_pct: 0.4 }, NOW);
  assert.equal(result.insufficientData, false);
  assert.equal(result.priorValue, 2);
  assert.equal(result.currentValue, 4);
  assert.ok(Math.abs(result.degradationPct - 1) < 1e-9);
  assert.equal(result.breached, true);
});

test('evaluateDegradationRule does not breach on a stable or improving metric', () => {
  const rows = [
    row({ date: daysAgo(10, NOW), spend: 100, landingPageViews: 50 }),
    row({ date: daysAgo(3, NOW), spend: 95, landingPageViews: 50 })
  ];
  const result = evaluateDegradationRule(rows, { metric: 'cpl_usd', window_days: 7, degradation_pct: 0.4 }, NOW);
  assert.equal(result.insufficientData, false);
  assert.equal(result.breached, false);
});

test('evaluateDegradationRule treats a falling landing_page_view_rate as degradation (higher_is_better direction)', () => {
  const rows = [
    // prior: 50/100 = 0.5 rate
    row({ date: daysAgo(10, NOW), landingPageViews: 50, clicks: 100 }),
    // current: 20/100 = 0.2 rate - a real drop
    row({ date: daysAgo(2, NOW), landingPageViews: 20, clicks: 100 })
  ];
  const result = evaluateDegradationRule(rows, { metric: 'landing_page_view_rate', window_days: 7, degradation_pct: 0.4 }, NOW);
  assert.equal(result.insufficientData, false);
  assert.ok(result.degradationPct > 0);
  assert.equal(result.breached, true);
});

test('evaluateAdMandateHealth runs every pause_on_metric_degradation rule plus the two always-on spend-ceiling checks', () => {
  const mandate = {
    constraints: {
      max_daily_spend_usd: 20,
      max_monthly_spend_usd: 400,
      pause_on_metric_degradation: [
        { metric: 'cpl_usd', window_days: 7, degradation_pct: 0.4 },
        { metric: 'unsupported_metric', window_days: 7, degradation_pct: 0.4 }
      ]
    }
  };
  const results = evaluateAdMandateHealth(mandate, { rows: [], now: NOW });
  assert.equal(results.length, 4);
  assert.equal(results[0].metric, 'cpl_usd');
  assert.equal(results[0].kind, 'metric_degradation');
  assert.equal(results[1].insufficientData, true);
  const spendResults = results.filter((result) => result.kind === 'spend_ceiling');
  assert.equal(spendResults.length, 2);
  assert.deepEqual(spendResults.map((result) => result.metric).sort(), ['max_daily_spend_usd', 'max_monthly_spend_usd']);
  assert.ok(spendResults.every((result) => result.insufficientData === true));
});

test('evaluateSpendCeilings flags a breach of either ceiling using real summed spend, and is never configurable-off', () => {
  const rows = [row({ date: daysAgo(0, NOW), spend: 25, landingPageViews: 10 })];
  const results = evaluateSpendCeilings(rows, { max_daily_spend_usd: 20, max_monthly_spend_usd: 400 }, NOW);
  const daily = results.find((result) => result.metric === 'max_daily_spend_usd');
  assert.equal(daily.insufficientData, false);
  assert.equal(daily.actual, 25);
  assert.equal(daily.breached, true);

  const monthly = results.find((result) => result.metric === 'max_monthly_spend_usd');
  assert.equal(monthly.insufficientData, false);
  assert.equal(monthly.actual, 25);
  assert.equal(monthly.breached, false);
});

test('evaluateSpendCeilings reports insufficientData, never a false "ok", when there is no evidence for today/this month', () => {
  const results = evaluateSpendCeilings([], { max_daily_spend_usd: 20, max_monthly_spend_usd: 400 }, NOW);
  assert.ok(results.every((result) => result.insufficientData === true && result.breached === false));
});
