// Deterministic ICP scorer for the Itera Works HVAC/plumbing beachhead -
// "ICP scoring calculations" from the ICP and Go-to-Market Strategy v1 doc's
// own automate-now (P0) list. Not an LLM call: the doc's scoring rubric is
// exact point values against thresholds, so this is arithmetic, not
// judgment. The judgment (deciding e.g. whether a site shows "weak lead
// capture") belongs in prospectResearchBrief.js, which produces the boolean/
// numeric signals this function consumes.
//
// Known inconsistency in the source doc, resolved here rather than silently
// picked: the doc states "Opportunity (Max 35)" and "Buyer fit (Max 15)" as
// section headers, but its own detailed scoring table lists criteria that
// sum to 40 and 20 respectively (an extra "Website conversion issues" (5pt)
// under Opportunity, and an extra "Marketing investment or history" (5pt)
// under Buyer fit, both absent from the doc's own summary slide). This
// scorer uses the criteria list that actually sums to the stated section
// maxes (Business 40 + Opportunity 35 + Buyer fit 15 = 90), since the Tier
// A/B thresholds below are calibrated against that total. The two dropped
// criteria are real, useful signals - capture them in the research brief's
// free-text leak hypothesis, just not in the score, until the team resolves
// the doc's own internal mismatch (this is exactly the "ICP hard filters,
// scoring weights, and Tier A standard" item already on their open-decisions
// list).

// Exported so prospectResearchBrief.js (the role that produces these
// signals) validates against the same key list this scorer actually reads,
// rather than two files drifting apart on what a "signal" is.
const NUMERIC_SIGNAL_KEYS = ['revenueEstimate', 'employeeCount', 'avgJobValue', 'monthlyLeadsEstimate', 'yearsInBusiness'];
const BOOLEAN_SIGNAL_KEYS = [
  'activeAdvertising',
  'weakLeadCaptureObserved',
  'largeDatabaseLikely',
  'weakCrm',
  'reputationOpportunity',
  'ownerIdentifiable',
  'ownerAccessible',
  'growthMindsetEvidence'
];

const MAX_SCORE = 90;

const TIER_A_MIN = 80;
const TIER_B_MIN = 65;

function floorScore(value, idealMin, maxPoints) {
  if (typeof value !== 'number' || Number.isNaN(value)) return { points: 0, rationale: 'no data' };
  if (value >= idealMin) return { points: maxPoints, rationale: `${value} >= ideal floor ${idealMin}` };
  return { points: 0, rationale: `${value} below ideal floor ${idealMin}` };
}

function tieredFloorScore(value, idealMin, acceptableMin, maxPoints) {
  if (typeof value !== 'number' || Number.isNaN(value)) return { points: 0, rationale: 'no data' };
  if (value >= idealMin) return { points: maxPoints, rationale: `${value} >= ideal floor ${idealMin}` };
  if (value >= acceptableMin) return { points: maxPoints / 2, rationale: `${value} >= acceptable floor ${acceptableMin}, below ideal ${idealMin}` };
  return { points: 0, rationale: `${value} below acceptable floor ${acceptableMin}` };
}

function rangeScore(value, idealMin, idealMax, acceptableMin, acceptableMax, maxPoints) {
  if (typeof value !== 'number' || Number.isNaN(value)) return { points: 0, rationale: 'no data' };
  if (value >= idealMin && value <= idealMax) return { points: maxPoints, rationale: `${value} within ideal range ${idealMin}-${idealMax}` };
  if (value >= acceptableMin && value <= acceptableMax) return { points: maxPoints / 2, rationale: `${value} within acceptable range ${acceptableMin}-${acceptableMax}, outside ideal` };
  return { points: 0, rationale: `${value} outside acceptable range ${acceptableMin}-${acceptableMax}` };
}

function flagScore(value, maxPoints, trueLabel, falseLabel) {
  if (value === true) return { points: maxPoints, rationale: trueLabel };
  if (value === false) return { points: 0, rationale: falseLabel };
  return { points: 0, rationale: 'no data' };
}

function tierFor(score) {
  if (score >= TIER_A_MIN) return 'A';
  if (score >= TIER_B_MIN) return 'B';
  return 'archive';
}

export function scoreIcpFit(signals = {}, { estimatedFields = [] } = {}) {
  const criteria = [
    { key: 'revenueEstimate', category: 'businessFit', maxPoints: 10, ...rangeScore(signals.revenueEstimate, 1_000_000, 5_000_000, 500_000, 10_000_000, 10) },
    { key: 'employeeCount', category: 'businessFit', maxPoints: 5, ...rangeScore(signals.employeeCount, 5, 30, 3, 50, 5) },
    { key: 'avgJobValue', category: 'businessFit', maxPoints: 10, ...tieredFloorScore(signals.avgJobValue, 2000, 750, 10) },
    { key: 'monthlyLeadsEstimate', category: 'businessFit', maxPoints: 10, ...tieredFloorScore(signals.monthlyLeadsEstimate, 50, 25, 10) },
    { key: 'yearsInBusiness', category: 'businessFit', maxPoints: 5, ...floorScore(signals.yearsInBusiness, 5, 5) },
    { key: 'activeAdvertising', category: 'opportunity', maxPoints: 10, ...flagScore(signals.activeAdvertising, 10, 'active Google/Meta ads observed', 'no active ad activity observed') },
    { key: 'weakLeadCaptureObserved', category: 'opportunity', maxPoints: 10, ...flagScore(signals.weakLeadCaptureObserved, 10, 'weak lead capture/follow-up observed', 'lead capture/follow-up looks adequate') },
    { key: 'largeDatabaseLikely', category: 'opportunity', maxPoints: 5, ...flagScore(signals.largeDatabaseLikely, 5, 'large customer database likely', 'no evidence of a large database') },
    { key: 'weakCrm', category: 'opportunity', maxPoints: 5, ...flagScore(signals.weakCrm, 5, 'weak or missing CRM observed', 'CRM maturity looks adequate') },
    { key: 'reputationOpportunity', category: 'opportunity', maxPoints: 5, ...flagScore(signals.reputationOpportunity, 5, 'reputation/review opportunity observed', 'reputation looks well managed') },
    { key: 'ownerIdentifiable', category: 'buyerFit', maxPoints: 5, ...flagScore(signals.ownerIdentifiable, 5, 'owner/decision-maker identified by name', 'owner not identified') },
    { key: 'ownerAccessible', category: 'buyerFit', maxPoints: 5, ...flagScore(signals.ownerAccessible, 5, 'credible path to reach the owner', 'no credible path to the owner') },
    { key: 'growthMindsetEvidence', category: 'buyerFit', maxPoints: 5, ...flagScore(signals.growthMindsetEvidence, 5, 'evidence of growth mindset (hiring, expansion, new services)', 'no growth-mindset evidence found') }
  ];

  const score = Math.round(criteria.reduce((sum, c) => sum + c.points, 0) * 100) / 100;

  return {
    score,
    maxScore: MAX_SCORE,
    tier: tierFor(score),
    breakdown: criteria.map(({ key, category, maxPoints, points, rationale }) => ({
      key,
      category,
      maxPoints,
      points,
      estimated: estimatedFields.includes(key),
      rationale
    })),
    estimatedFields
  };
}

export { MAX_SCORE, TIER_A_MIN, TIER_B_MIN, NUMERIC_SIGNAL_KEYS, BOOLEAN_SIGNAL_KEYS };
