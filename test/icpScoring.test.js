import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreIcpFit, MAX_SCORE, TIER_A_MIN, TIER_B_MIN } from '../lib/research/icpScoring.js';

const IDEAL_SIGNALS = {
  revenueEstimate: 3_000_000,
  employeeCount: 15,
  avgJobValue: 2500,
  monthlyLeadsEstimate: 80,
  yearsInBusiness: 12,
  activeAdvertising: true,
  weakLeadCaptureObserved: true,
  largeDatabaseLikely: true,
  weakCrm: true,
  reputationOpportunity: true,
  ownerIdentifiable: true,
  ownerAccessible: true,
  growthMindsetEvidence: true
};

test('a prospect matching every ideal signal scores the full 90 and lands Tier A', () => {
  const result = scoreIcpFit(IDEAL_SIGNALS);
  assert.equal(result.score, 90);
  assert.equal(result.maxScore, MAX_SCORE);
  assert.equal(result.tier, 'A');
});

test('an empty signals object scores 0 and archives, rather than guessing', () => {
  const result = scoreIcpFit({});
  assert.equal(result.score, 0);
  assert.equal(result.tier, 'archive');
  assert.ok(result.breakdown.every((c) => c.points === 0 && c.rationale === 'no data'));
});

test('revenue in the acceptable-but-not-ideal range earns half points', () => {
  const result = scoreIcpFit({ ...IDEAL_SIGNALS, revenueEstimate: 750_000 });
  const revenue = result.breakdown.find((c) => c.key === 'revenueEstimate');
  assert.equal(revenue.points, 5);
  assert.equal(result.score, 85);
});

test('revenue outside the acceptable range entirely earns zero', () => {
  const result = scoreIcpFit({ ...IDEAL_SIGNALS, revenueEstimate: 100_000 });
  const revenue = result.breakdown.find((c) => c.key === 'revenueEstimate');
  assert.equal(revenue.points, 0);
});

test('job value and lead volume use a floor, not a range, so a higher value still earns full points', () => {
  const result = scoreIcpFit({ ...IDEAL_SIGNALS, avgJobValue: 50_000, monthlyLeadsEstimate: 500 });
  assert.equal(result.breakdown.find((c) => c.key === 'avgJobValue').points, 10);
  assert.equal(result.breakdown.find((c) => c.key === 'monthlyLeadsEstimate').points, 10);
});

test('a score of exactly 80 lands Tier A and 79 lands Tier B, matching the doc thresholds', () => {
  assert.equal(scoreIcpFit({ ...IDEAL_SIGNALS, revenueEstimate: 100_000, employeeCount: 1, avgJobValue: 0 }).tier, 'B'); // 90 - 25 = 65, the Tier B floor
  const tierBSignals = { ...IDEAL_SIGNALS, largeDatabaseLikely: false, weakCrm: false }; // 90 - 10 = 80
  assert.equal(scoreIcpFit(tierBSignals).score, 80);
  assert.equal(scoreIcpFit(tierBSignals).tier, 'A');
  const justBelowA = { ...IDEAL_SIGNALS, largeDatabaseLikely: false, weakCrm: false, reputationOpportunity: false }; // 75
  assert.equal(scoreIcpFit(justBelowA).score, 75);
  assert.equal(scoreIcpFit(justBelowA).tier, 'B');
  assert.ok(TIER_A_MIN > TIER_B_MIN);
});

test('estimatedFields marks which inputs were inferred rather than confirmed, without changing the score', () => {
  const confirmed = scoreIcpFit(IDEAL_SIGNALS);
  const estimated = scoreIcpFit(IDEAL_SIGNALS, { estimatedFields: ['revenueEstimate', 'monthlyLeadsEstimate'] });
  assert.equal(confirmed.score, estimated.score);
  assert.equal(estimated.breakdown.find((c) => c.key === 'revenueEstimate').estimated, true);
  assert.equal(estimated.breakdown.find((c) => c.key === 'employeeCount').estimated, false);
});

test('criteria sum to the documented section maxes: business 40, opportunity 35, buyer fit 15', () => {
  const result = scoreIcpFit(IDEAL_SIGNALS);
  const maxByCategory = result.breakdown.reduce((acc, c) => {
    acc[c.category] = (acc[c.category] ?? 0) + c.maxPoints;
    return acc;
  }, {});
  assert.equal(maxByCategory.businessFit, 40);
  assert.equal(maxByCategory.opportunity, 35);
  assert.equal(maxByCategory.buyerFit, 15);
});
