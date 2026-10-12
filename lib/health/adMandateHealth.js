// docs/futco-ad-mandate-spec.md Phase 3 (circuit breaker): pure evaluation
// logic, deliberately separate from ops/reports/checkAdMandateHealth.js's
// I/O (loading the instance, querying events, acting on a breach) so it can
// be unit-tested against hand-built rows with no event log at all.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Only metrics this codebase can actually compute from real Meta data today
// (lib/research/metaInsights.js only extracts landing_page_view/
// cost_per_action_type for "landing_page_view" - no lead-level action is
// pulled yet). "cpl_usd"/"cost_per_lead" are accepted as aliases for
// cost-per-landing-page-view because every ad_mandate fixture and example in
// docs/futco-ad-mandate-spec.md names the constraint that way, but this is an
// approximation until real lead-level attribution exists (section 7 of that
// spec) - any other metric name is refused as unsupported rather than
// silently computed wrong or guessed.
const METRIC_REGISTRY = Object.freeze({
  cost_per_landing_page_view: { numerator: 'spend', denominator: 'landingPageViews', direction: 'lower_is_better' },
  cpl_usd: { numerator: 'spend', denominator: 'landingPageViews', direction: 'lower_is_better' },
  cost_per_lead: { numerator: 'spend', denominator: 'landingPageViews', direction: 'lower_is_better' },
  landing_page_view_rate: { numerator: 'landingPageViews', denominator: 'clicks', direction: 'higher_is_better' }
});

function normalizeMetricName(metric) {
  return typeof metric === 'string' ? metric.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

// Resolves which Meta campaignIds a mandate's pause_on_metric_degradation
// rules should actually be evaluated against. allowed_campaign_ids, when
// set, is authoritative (the mandate already names exact campaigns). When
// null ("any campaign under the allowed products"), this falls back to
// research.meta.campaigns[].product - a mapping that must be filled in by a
// human in instance config (lib/config.js validates its shape but never
// invents values). No mapping yet means no campaigns resolve, which the
// caller must treat as "insufficient data," never as "no degradation."
export function resolveCampaignIdsForMandate(mandate, metaConfig) {
  if (!isPlainObject(mandate)) return [];
  const allowedCampaignIds = mandate.constraints?.allowed_campaign_ids;
  if (Array.isArray(allowedCampaignIds) && allowedCampaignIds.length > 0) {
    return [...allowedCampaignIds];
  }

  const allowedProducts = new Set(mandate.constraints?.allowed_products ?? []);
  const campaigns = Array.isArray(metaConfig?.campaigns) ? metaConfig.campaigns : [];
  return campaigns.filter((campaign) => isPlainObject(campaign) && allowedProducts.has(campaign.product)).map((campaign) => campaign.campaignId);
}

function sumField(rows, field) {
  let total = 0;
  let sawAny = false;
  for (const row of rows) {
    const value = row?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      sawAny = true;
    }
  }
  return sawAny ? total : null;
}

// Aggregates as a ratio of summed totals (sum(spend)/sum(landingPageViews)),
// not an average of each row's own ratio - sound the same way a blended CPL
// across several days should be, and avoids being skewed by a single
// low-volume day with an extreme per-row ratio.
function aggregateRatio(rows, numeratorField, denominatorField) {
  if (rows.length === 0) return null;
  const numerator = sumField(rows, numeratorField);
  const denominator = sumField(rows, denominatorField);
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

function parseRowDate(row) {
  const time = Date.parse(row?.date ?? '');
  return Number.isNaN(time) ? null : time;
}

function rowsInWindow(rows, startMs, endMs) {
  return rows.filter((row) => {
    const time = parseRowDate(row);
    return time !== null && time >= startMs && time < endMs;
  });
}

// Evaluates one pause_on_metric_degradation rule against the full set of
// resolved evidence rows for a mandate's campaigns. `rows` need not be
// pre-filtered to a time range - the current/prior windows are both derived
// here from `now` and `rule.window_days`, comparing the most recent window
// against the one immediately before it (so a rule only fires on a real
// trend, not a one-day blip against some arbitrary historical baseline).
export function evaluateDegradationRule(rows, rule, now = new Date()) {
  const metricKey = normalizeMetricName(rule?.metric);
  const metricConfig = METRIC_REGISTRY[metricKey];
  const base = { metric: rule?.metric, windowDays: rule?.window_days, threshold: rule?.degradation_pct };

  if (!metricConfig) {
    return { ...base, insufficientData: true, breached: false, reason: `unsupported metric "${rule?.metric}" - no evaluator registered` };
  }

  const windowDays = Number(rule?.window_days);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    return { ...base, insufficientData: true, breached: false, reason: 'rule has no valid window_days' };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const currentRows = rowsInWindow(Array.isArray(rows) ? rows : [], nowMs - windowMs, nowMs);
  const priorRows = rowsInWindow(Array.isArray(rows) ? rows : [], nowMs - 2 * windowMs, nowMs - windowMs);

  const currentValue = aggregateRatio(currentRows, metricConfig.numerator, metricConfig.denominator);
  const priorValue = aggregateRatio(priorRows, metricConfig.numerator, metricConfig.denominator);

  if (currentValue === null || priorValue === null || priorValue === 0) {
    return { ...base, insufficientData: true, breached: false, reason: 'not enough evidence rows in the current and/or prior window' };
  }

  const degradationPct =
    metricConfig.direction === 'lower_is_better' ? (currentValue - priorValue) / priorValue : (priorValue - currentValue) / priorValue;
  const breached = degradationPct >= base.threshold;

  return { ...base, insufficientData: false, currentValue, priorValue, degradationPct, breached };
}

// Runs every pause_on_metric_degradation rule on an ad_mandate's own
// constraints against the supplied rows, returning one result per rule.
export function evaluateAdMandateHealth(mandate, { rows, now = new Date() } = {}) {
  const rules = mandate?.constraints?.pause_on_metric_degradation ?? [];
  return rules.map((rule) => evaluateDegradationRule(rows, rule, now));
}
