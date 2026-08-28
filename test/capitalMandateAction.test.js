import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { submitCapitalMandate } from '../lib/actions/capitalMandate.js';
import { listExecutedActions } from '../lib/actions/log.js';
import { createE3dTradeClient } from '../lib/trade/client.js';
import { decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { proposeCapitalMandate } from '../lib/proposals/capitalMandate.js';
import { getProposal } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-capital-mandate-action-'));
}

function proposedBy() {
  return { role: 'opportunity.investing', provider: 'local', model: 'test-model' };
}

function validMandate(overrides = {}) {
  return {
    owner: 'futco',
    expires_at: '2026-12-31T00:00:00.000Z',
    thesis_refs: ['thesis-btc-liquidity'],
    story_refs: ['story-wallet-accumulation'],
    objective: 'Constrain paper allocation to high-conviction E3D signals.',
    constraints: {
      max_position_pct: 0.12,
      max_gross_exposure_pct: 0.35,
      allowed_assets: ['BTC', 'ETH'],
      paper_only: true,
      live_execution_allowed: false,
      risk_sovereign: true
    },
    preferences: {
      discovery_bias: ['confirmed on-chain story flow']
    },
    horizon: { min_days: 14, max_days: 90 },
    confidence: 0.73,
    invalidation: 'Invalidate if story activity breaks down.',
    ...overrides
  };
}

function seedPursuingInvestingOpportunity(dataDir) {
  const correlationId = 'capital-mandate-action-chain';
  const signal = appendEvent(dataDir, {
    type: 'investment.signal.detected',
    source: 'manual',
    subject: { type: 'market-signal', id: 'btc' },
    payload: { topic: 'BTC liquidity' },
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.investing',
    subject: { type: 'opportunity', id: 'opp-investing' },
    payload: {
      id: 'opp-investing',
      type: 'long-idea',
      title: 'BTC liquidity mandate',
      description: 'E3D thesis and story evidence support a constrained paper allocation.',
      view: 'bullish',
      confidence: 0.73,
      thesisRefs: ['thesis-btc-liquidity'],
      storyRefs: ['story-wallet-accumulation'],
      invalidationCondition: 'Invalidate if story activity breaks down.',
      status: 'candidate',
      sourceEventIds: [signal.id],
      correlationId,
      createdAt: signal.occurredAt,
      proposedBy: proposedBy()
    },
    causationId: signal.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: 'opp-investing' },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Mandate-worthy', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });

  return {
    id: 'opp-investing',
    type: 'long-idea',
    title: 'BTC liquidity mandate',
    status: 'pursuing',
    confidence: 0.73,
    thesisRefs: ['thesis-btc-liquidity'],
    storyRefs: ['story-wallet-accumulation'],
    invalidationCondition: 'Invalidate if story activity breaks down.',
    correlationId,
    proposedBy: proposedBy()
  };
}

async function approvedCapitalMandateProposal(dataDir) {
  const opportunity = seedPursuingInvestingOpportunity(dataDir);
  const { proposal } = proposeCapitalMandate(dataDir, {
    opportunity,
    mandate: validMandate()
  });
  await decideProposal(dataDir, proposal.id, 'approved', 'Delegate constrained paper authority', 'chris', 'cli');
  return getProposal(dataDir, proposal.id);
}

test('capital_mandate action refuses an unapproved proposal before contacting e3d-trade', async () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunity = seedPursuingInvestingOpportunity(dataDir);
    const { proposal } = proposeCapitalMandate(dataDir, { opportunity, mandate: validMandate() });
    let calls = 0;

    await assert.rejects(
      submitCapitalMandate(proposal, {
        dataDir,
        tradeClient: {
          async submitCapitalMandate() {
            calls += 1;
          }
        }
      }),
      /not approved/
    );

    assert.equal(calls, 0);
    assert.equal(queryEvents(dataDir, { type: 'capital-mandate.submitted' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('confirming an approved capital_mandate submits active payload and records activation only after accepted ack', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('capital_mandate', (proposal, ctx) =>
    submitCapitalMandate(proposal, {
      ...ctx,
      tradeClient: {
        async submitCapitalMandate(mandate) {
          assert.equal(mandate.status, 'active');
          assert.match(mandate.effective_at, /^\d{4}-\d{2}-\d{2}T/);
          assert.equal(mandate.decision_id, getProposal(dataDir, proposal.id).payload.decision_id);
          return { accepted: true, mandate_id: mandate.mandate_id, status: 'active', ack_id: 'ack-1' };
        }
      }
    })
  );

  try {
    const approved = await approvedCapitalMandateProposal(dataDir);
    const result = await confirmAndExecute(dataDir, approved.id, 'chris', 'cli', {});

    assert.equal(result.executionResult.submitted, true);
    assert.equal(result.executionResult.status, 'active');

    const submittedEvents = queryEvents(dataDir, { type: 'capital-mandate.submitted' });
    assert.equal(submittedEvents.length, 1);
    assert.equal(submittedEvents[0].causationId, queryEvents(dataDir, { type: 'proposal.approved' })[0].id);
    assert.equal(submittedEvents[0].correlationId, approved.correlationId);
    assert.equal(submittedEvents[0].payload.tradeStatus, 'active');
    assert.equal(getProposal(dataDir, approved.id).payload.status, 'active');

    const actions = listExecutedActions(dataDir);
    assert.equal(actions[0].type, 'capital-mandate.submitted');
    assert.match(actions[0].summary, /submitted to e3d-trade/);
  } finally {
    clearActionExecutor('capital_mandate');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unconfirmed e3d-trade acknowledgement leaves mandate approved, not active', async () => {
  const dataDir = makeTempDataDir();
  try {
    const approved = await approvedCapitalMandateProposal(dataDir);

    await assert.rejects(
      submitCapitalMandate(approved, {
        dataDir,
        tradeClient: {
          async submitCapitalMandate() {
            throw new Error('Timed out submitting capital_mandate to e3d-trade; delivery is unconfirmed');
          }
        }
      }),
      /delivery is unconfirmed/
    );

    assert.equal(queryEvents(dataDir, { type: 'capital-mandate.submitted' }).length, 0);
    assert.equal(getProposal(dataDir, approved.id).payload.status, 'approved');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('duplicate confirm of the same mandate is idempotent in e3d-corp and does not resubmit', async () => {
  const dataDir = makeTempDataDir();
  let calls = 0;
  registerActionExecutor('capital_mandate', (proposal, ctx) =>
    submitCapitalMandate(proposal, {
      ...ctx,
      tradeClient: {
        async submitCapitalMandate(mandate) {
          calls += 1;
          return { accepted: true, mandate_id: mandate.mandate_id, status: 'active', ack_id: `ack-${calls}` };
        }
      }
    })
  );

  try {
    const approved = await approvedCapitalMandateProposal(dataDir);
    const first = await confirmAndExecute(dataDir, approved.id, 'chris', 'cli', {});
    const second = await confirmAndExecute(dataDir, approved.id, 'chris', 'cli', {});

    assert.equal(first.executionResult.submitted, true);
    assert.equal(second.executionResult.submitted, false);
    assert.equal(second.executionResult.idempotent, true);
    assert.equal(calls, 1);
    assert.equal(queryEvents(dataDir, { type: 'capital-mandate.submitted' }).length, 1);
  } finally {
    clearActionExecutor('capital_mandate');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('trade client retries timeout/5xx safely and surfaces conflicts without retrying', async () => {
  let attempts = 0;
  const client = createE3dTradeClient(
    { baseUrl: 'http://trade.local', timeoutMs: 50, maxAttempts: 3 },
    {
      async fetchImpl(url, options) {
        attempts += 1;
        assert.equal(url, 'http://trade.local/api/mandates/capital');
        assert.equal(options.headers['Idempotency-Key'], 'mandate_test');
        if (attempts === 1) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        if (attempts === 2) {
          return new Response(JSON.stringify({ message: 'temporary' }), { status: 503 });
        }
        return new Response(JSON.stringify({ accepted: true, mandate_id: 'mandate_test', status: 'active' }), { status: 200 });
      }
    }
  );

  const ack = await client.submitCapitalMandate({ mandate_id: 'mandate_test' });
  assert.equal(ack.status, 'active');
  assert.equal(attempts, 3);

  let conflictAttempts = 0;
  const conflictClient = createE3dTradeClient(
    { baseUrl: 'http://trade.local', maxAttempts: 3 },
    {
      async fetchImpl() {
        conflictAttempts += 1;
        return new Response(JSON.stringify({ message: 'mandate conflict' }), { status: 409 });
      }
    }
  );

  await assert.rejects(conflictClient.submitCapitalMandate({ mandate_id: 'mandate_test' }), /mandate conflict/);
  assert.equal(conflictAttempts, 1);
});
