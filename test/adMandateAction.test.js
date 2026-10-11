import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { activateAdMandate } from '../lib/actions/adMandate.js';
import { decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { proposeAdMandate } from '../lib/proposals/adMandate.js';
import { getProposal } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-ad-mandate-action-'));
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

function seedPursuingProductOpportunity(dataDir, { opportunityId = 'opp-ad-mandate-action' } = {}) {
  const correlationId = `ad-mandate-action-${opportunityId}`;
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

async function approvedAdMandateProposal(dataDir, mandateOverrides = {}) {
  const opportunity = seedPursuingProductOpportunity(dataDir);
  const { proposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate(mandateOverrides) });
  await decideProposal(dataDir, proposal.id, 'approved', 'Set a spend envelope', 'chris', 'cli');
  return getProposal(dataDir, proposal.id);
}

const adRiskPolicy = { max_daily_spend_usd: 500, max_monthly_spend_usd: 10000 };

test('ad_mandate action refuses an unapproved proposal before checking any policy', async () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunity = seedPursuingProductOpportunity(dataDir);
    const { proposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate() });

    await assert.rejects(
      activateAdMandate(proposal, { dataDir, instanceConfig: { adRiskPolicy } }),
      /not approved/
    );
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.activated' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ad_mandate action fails closed when instanceConfig.adRiskPolicy is missing', async () => {
  const dataDir = makeTempDataDir();
  try {
    const approved = await approvedAdMandateProposal(dataDir);
    await assert.rejects(
      activateAdMandate(approved, { dataDir, instanceConfig: {} }),
      /missing or invalid.*hard ceiling/s
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ad_mandate action refuses activation when constraints exceed the hard ceiling', async () => {
  const dataDir = makeTempDataDir();
  try {
    const approved = await approvedAdMandateProposal(dataDir, { constraints: { ...validAdMandate().constraints, max_daily_spend_usd: 150 } });
    await assert.rejects(
      activateAdMandate(approved, { dataDir, instanceConfig: { adRiskPolicy: { max_daily_spend_usd: 50, max_monthly_spend_usd: 10000 } } }),
      /exceeds the hard ceiling/
    );
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.activated' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('confirming an approved ad_mandate within policy activates it and is idempotent on a duplicate confirm', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('ad_mandate', activateAdMandate);
  try {
    const approved = await approvedAdMandateProposal(dataDir);
    const first = await confirmAndExecute(dataDir, approved.id, 'chris', 'cli', { adRiskPolicy });

    assert.equal(first.executionResult.activated, true);
    assert.equal(first.executionResult.idempotent, false);

    const activatedEvents = queryEvents(dataDir, { type: 'ad-mandate.activated' });
    assert.equal(activatedEvents.length, 1);
    assert.equal(activatedEvents[0].correlationId, approved.correlationId);
    assert.equal(activatedEvents[0].payload.allowedProducts[0], 'oppscan');
    assert.equal(activatedEvents[0].payload.maxDailySpendUsd, 150);

    // Duplicate confirm: decide.js itself already refuses a non-approved
    // proposal, so simulate the real idempotency path by invoking the
    // executor again directly against the now-approved proposal record.
    const second = await activateAdMandate(getProposal(dataDir, approved.id), { dataDir, instanceConfig: { adRiskPolicy } });
    assert.equal(second.idempotent, true);
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.activated' }).length, 1);
  } finally {
    clearActionExecutor('ad_mandate');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
