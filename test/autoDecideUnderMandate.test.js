import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { proposeAdMandate } from '../lib/proposals/adMandate.js';
import { activateAdMandate } from '../lib/actions/adMandate.js';
import { proposeCommissionCreative } from '../lib/proposals/commissionCreative.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { autoDecideUnderMandate, evaluateMandateCoverage } from '../lib/decisions/autoDecideUnderMandate.js';
import { getProposal } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-auto-decide-mandate-'));
}

function seedPursuingProductOpportunity(dataDir, { opportunityId = 'opp-auto-decide' } = {}) {
  const correlationId = `auto-decide-${opportunityId}`;
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
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth a new variant', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });

  return { id: opportunityId, type: 'product-opportunity', title: 'HVAC CPL creeping up', status: 'pursuing', correlationId };
}

function sampleBrief(overrides = {}) {
  return {
    product: 'oppscan',
    audience: 'HVAC business owners in NorCal',
    objective: 'landing_page_view',
    constraints: { maxDurationSeconds: 30 },
    ...overrides
  };
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

async function activeMandateProposal(dataDir, mandateOverrides = {}) {
  const opportunity = seedPursuingProductOpportunity(dataDir, { opportunityId: `opp-mandate-${Math.random().toString(36).slice(2)}` });
  const { proposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate(mandateOverrides) });
  await decideProposal(dataDir, proposal.id, 'approved', 'Set a spend envelope', 'chris', 'cli');
  const approved = getProposal(dataDir, proposal.id);
  await activateAdMandate(approved, { dataDir, instanceConfig: { adRiskPolicy } });
  return getProposal(dataDir, proposal.id);
}

function pendingCommissionCreativeProposal(dataDir, briefOverrides = {}) {
  const opportunity = seedPursuingProductOpportunity(dataDir, { opportunityId: `opp-commission-${Math.random().toString(36).slice(2)}` });
  const { proposal } = proposeCommissionCreative(dataDir, {
    opportunity,
    brief: sampleBrief(briefOverrides),
    reason: 'CPL has crept up, try a new creative direction'
  });
  return proposal;
}

test('evaluateMandateCoverage requires the mandate to be live-active (expiry is derived, never cached)', () => {
  const expiredMandate = { ...validAdMandate(), status: 'active', mandate_id: 'ad-mandate_x', expires_at: '2020-01-01T00:00:00.000Z' };
  const proposal = { id: 'p1', payload: { brief: sampleBrief() } };
  const result = evaluateMandateCoverage(expiredMandate, proposal);
  assert.equal(result.covered, false);
  assert.match(result.reason, /not active/);
});

test('evaluateMandateCoverage refuses a product the mandate does not cover', () => {
  const mandate = { ...validAdMandate(), status: 'active', mandate_id: 'ad-mandate_x' };
  const proposal = { id: 'p1', payload: { brief: sampleBrief({ product: 'different-product' }) } };
  const result = evaluateMandateCoverage(mandate, proposal);
  assert.equal(result.covered, false);
  assert.match(result.reason, /allowed_products/);
});

test('evaluateMandateCoverage fails closed when the mandate is scoped to allowed_campaign_ids', () => {
  const mandate = {
    ...validAdMandate({ constraints: { ...validAdMandate().constraints, allowed_campaign_ids: ['camp-1'] } }),
    status: 'active',
    mandate_id: 'ad-mandate_x'
  };
  const proposal = { id: 'p1', payload: { brief: sampleBrief() } };
  const result = evaluateMandateCoverage(mandate, proposal);
  assert.equal(result.covered, false);
  assert.match(result.reason, /allowed_campaign_ids/);
});

test('autoDecideUnderMandate refuses a proposal that is not pending', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    const commissionProposal = pendingCommissionCreativeProposal(dataDir);
    await decideProposal(dataDir, commissionProposal.id, 'rejected', 'no longer relevant', 'chris', 'cli');

    await assert.rejects(
      autoDecideUnderMandate(dataDir, commissionProposal.id, mandateProposal.id, {}),
      /is already rejected/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoDecideUnderMandate refuses when no covering active ad_mandate exists', async () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunity = seedPursuingProductOpportunity(dataDir);
    const { proposal: mandateProposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate() });
    // Never approved/activated - still "proposed".
    const commissionProposal = pendingCommissionCreativeProposal(dataDir);

    await assert.rejects(
      autoDecideUnderMandate(dataDir, commissionProposal.id, mandateProposal.id, {}),
      /not active/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoDecideUnderMandate approves and executes a covered proposal with no human decision, source=decision:autonomous-mandate', async () => {
  const dataDir = makeTempDataDir();
  const executorCalls = [];
  registerActionExecutor('commission-creative', async (proposal, ctx) => {
    executorCalls.push({ proposal, ctx });
    return { commissioned: true, outputDir: '/fake/out' };
  });
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    const commissionProposal = pendingCommissionCreativeProposal(dataDir);

    const result = await autoDecideUnderMandate(dataDir, commissionProposal.id, mandateProposal.id, { adRiskPolicy });

    assert.equal(result.decision.decision, 'approved');
    assert.equal(result.decision.via, 'autonomous-mandate');
    assert.equal(result.executed, true);
    assert.equal(result.mandateId, mandateProposal.payload.mandate_id);
    assert.deepEqual(result.executionResult, { commissioned: true, outputDir: '/fake/out' });
    assert.equal(executorCalls.length, 1);

    const decided = getProposal(dataDir, commissionProposal.id);
    assert.equal(decided.status, 'approved');

    const approvalEvents = queryEvents(dataDir, { type: 'proposal.approved', subject: { type: 'proposal', id: commissionProposal.id } });
    assert.equal(approvalEvents.length, 1);
    assert.equal(approvalEvents[0].source, 'decision:autonomous-mandate');
    assert.equal(approvalEvents[0].payload.decidedBy, `ad_mandate:${mandateProposal.payload.mandate_id}`);
  } finally {
    clearActionExecutor('commission-creative');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoDecideUnderMandate refuses a proposal type other than commission-creative', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    const opportunity = seedPursuingProductOpportunity(dataDir);
    const { proposal: anotherMandateProposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate() });

    await assert.rejects(
      autoDecideUnderMandate(dataDir, anotherMandateProposal.id, mandateProposal.id, {}),
      /not eligible for autonomous mandate decisions/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
