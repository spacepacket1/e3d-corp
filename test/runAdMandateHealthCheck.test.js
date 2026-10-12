import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { proposeAdMandate } from '../lib/proposals/adMandate.js';
import { activateAdMandate } from '../lib/actions/adMandate.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { getProposal } from '../lib/proposals/store.js';
import { runAdMandateHealthCheck } from '../lib/health/runAdMandateHealthCheck.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-ad-mandate-health-'));
}

function seedPursuingProductOpportunity(dataDir, { opportunityId = `opp-${Math.random().toString(36).slice(2)}` } = {}) {
  const correlationId = `health-${opportunityId}`;
  const signal = appendEvent(dataDir, {
    type: 'market.signal.detected',
    source: 'discovery.scheduled',
    subject: { type: 'research-topic', id: 'topic' },
    payload: { topic: 'topic' },
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { id: opportunityId, type: 'product-opportunity', title: 'HVAC CPL creeping up', correlationId },
    causationId: signal.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth a mandate', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });
  return { id: opportunityId, type: 'product-opportunity', title: 'HVAC CPL creeping up', status: 'pursuing', correlationId };
}

function validAdMandate(overrides = {}) {
  return {
    owner: 'futco',
    expires_at: '2026-12-31T00:00:00.000Z',
    thesis_refs: ['thesis-hvac-cpl-creep'],
    objective: 'Keep HVAC scanner CPL under control while testing new creative variants.',
    constraints: {
      max_daily_spend_usd: 150,
      max_monthly_spend_usd: 3000,
      max_cpl_usd: 40,
      max_cac_usd: null,
      allowed_products: ['oppscan'],
      allowed_campaign_ids: null,
      pause_on_metric_degradation: [{ metric: 'cpl_usd', window_days: 7, degradation_pct: 0.4 }],
      paper_only_creative: true
    },
    preferences: {},
    confidence: 0.7,
    invalidation: 'Invalidate if CPL stabilizes without intervention.',
    ...overrides
  };
}

const adRiskPolicy = { max_daily_spend_usd: 500, max_monthly_spend_usd: 10000 };
const metaConfig = { adAccountId: 'acct-1', campaigns: [{ key: 'hvac_v3', campaignId: 'camp-1', product: 'oppscan' }] };

async function activeMandateProposal(dataDir, mandateOverrides = {}) {
  const opportunity = seedPursuingProductOpportunity(dataDir);
  const { proposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate(mandateOverrides) });
  await decideProposal(dataDir, proposal.id, 'approved', 'Set a spend envelope', 'chris', 'cli');
  const approved = getProposal(dataDir, proposal.id);
  await activateAdMandate(approved, { dataDir, instanceConfig: { adRiskPolicy } });
  return getProposal(dataDir, proposal.id);
}

function daysAgo(n, from = new Date('2026-10-11T00:00:00.000Z')) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function row({ date, campaignId = 'camp-1', spend, landingPageViews }) {
  return { date, campaignId, campaignName: 'hvac', impressions: null, clicks: null, spend, cpm: null, landingPageViews, costPerLandingPageView: null, actions: [], costPerActionType: [] };
}

function landInsightsEvidence(dataDir, rows, correlationId) {
  return appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.metaInsights',
    subject: { type: 'research', id: `evidence-${Math.random().toString(36).slice(2)}` },
    payload: { kind: 'meta-insights', query: {}, result: { status: 'ok', rows }, resultSummary: 'test', degraded: false },
    correlationId
  });
}

test('runAdMandateHealthCheck reports no-active-mandates when there are none', async () => {
  const dataDir = makeTempDataDir();
  try {
    const outcomes = await runAdMandateHealthCheck(dataDir, {});
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, 'no-active-mandates');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runAdMandateHealthCheck reports insufficient-campaign-mapping when no campaign maps to the mandate product', async () => {
  const dataDir = makeTempDataDir();
  try {
    await activeMandateProposal(dataDir);
    const outcomes = await runAdMandateHealthCheck(dataDir, { research: { meta: { campaigns: [{ campaignId: 'camp-1' }] } } });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, 'insufficient-campaign-mapping');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runAdMandateHealthCheck reports ok when the metric has not degraded, and appends no events', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    landInsightsEvidence(
      dataDir,
      [
        row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }),
        row({ date: daysAgo(2), spend: 100, landingPageViews: 50 })
      ],
      mandateProposal.correlationId
    );

    const outcomes = await runAdMandateHealthCheck(dataDir, { research: { meta: metaConfig } });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, 'ok');
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.health-check.breach-observed' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runAdMandateHealthCheck in observe-only mode (default) logs a breach but never suspends', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    landInsightsEvidence(
      dataDir,
      [
        row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }), // prior: $2/LPV
        row({ date: daysAgo(2), spend: 200, landingPageViews: 50 }) // current: $4/LPV, +100%
      ],
      mandateProposal.correlationId
    );

    const outcomes = await runAdMandateHealthCheck(dataDir, { research: { meta: metaConfig } });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, 'breach-observed');
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.health-check.breach-observed' }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.auto-suspended' }).length, 0);
    assert.equal(getProposal(dataDir, mandateProposal.id).payload.status, 'active');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runAdMandateHealthCheck with autoSuspendEnabled:true auto-suspends on a confirmed breach', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    landInsightsEvidence(
      dataDir,
      [
        row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }),
        row({ date: daysAgo(2), spend: 200, landingPageViews: 50 })
      ],
      mandateProposal.correlationId
    );

    const outcomes = await runAdMandateHealthCheck(dataDir, {
      research: { meta: metaConfig },
      adMandateHealthCheck: { autoSuspendEnabled: true }
    });

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].kind, 'auto-suspended');
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.auto-suspended' }).length, 1);
    assert.equal(getProposal(dataDir, mandateProposal.id).payload.status, 'suspended');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
