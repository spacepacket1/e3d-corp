import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMandateScoutBias,
  currentMandateStatus,
  getActiveCapitalMandate,
  submitCapitalMandate as submitTradeCapitalMandate,
  validateCapitalMandatePayload as validateTradeCapitalMandatePayload,
  validateMandateConstraintsAgainstPolicy
} from '../../e3d-trade/scripts/capitalMandates.js';
import { evaluateRiskDecision } from '../../e3d-trade/scripts/riskEngine.js';
import { mapCorpOutcomeCallbacks, mapTradeOutcomeEvent } from '../../e3d-trade/scripts/e3dActionOutcomeExport.js';
import { appendEvent, queryEvents, verifyEventChain, eventsFilePath } from '../lib/events/store.js';
import { recordTradeOutcomeReturn } from '../lib/outcomes/tradeReturn.js';
import { readExperience } from '../lib/experience/store.js';

const RISK_POLICY = {
  max_position_size_pct: 0.12,
  max_token_exposure_pct: 0.12,
  max_category_exposure_pct: 0.70,
  max_strategy_exposure_pct: 0.75,
  max_open_positions: 6,
  max_daily_turnover_usd: 250000,
  min_liquidity_usd: 100000,
  max_spread_bps: 150,
  max_slippage_bps: 150
};

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function activeMandate(overrides = {}) {
  return {
    mandate_id: 'mandate-acceptance-1',
    version: '1.0',
    owner: 'futco',
    status: 'active',
    created_at: '2026-08-27T12:00:00.000Z',
    approved_at: '2026-08-27T12:01:00.000Z',
    effective_at: '2026-08-27T12:02:00.000Z',
    expires_at: '2026-09-27T12:02:00.000Z',
    correlation_id: 'corr-acceptance-1',
    proposal_id: 'proposal-acceptance-1',
    decision_id: 'decision-acceptance-1',
    thesis_refs: ['thesis-acceptance'],
    story_refs: ['story-acceptance'],
    objective: 'Bias toward liquid AI infrastructure tokens while preserving Risk limits.',
    constraints: {
      max_position_size_pct: 0.08,
      max_token_exposure_pct: 0.08,
      max_open_positions: 4,
      min_liquidity_usd: 250000,
      allowed_categories: ['ai'],
      max_trade_notional_usd: 6000
    },
    preferences: {
      preferred_categories: ['ai']
    },
    horizon: '30d',
    confidence: 0.7,
    invalidation: 'Thesis invalidates on liquidity collapse.',
    ...overrides
  };
}

function portfolioFixture(overrides = {}) {
  return {
    cash_usd: 95000,
    positions: {
      ETH: {
        symbol: 'ETH',
        contract_address: '0xeth',
        category: 'layer1',
        strategy_version: 'paper-pipeline-v1',
        market_value_usd: 5000
      }
    },
    action_history: [],
    closed_trades: [],
    settings: {
      paper_mode: true,
      max_position_pct: 0.12,
      category_cap_pct: 0.70,
      max_open_positions: 6,
      risk_engine: {
        max_token_exposure_pct: 0.12,
        max_strategy_exposure_pct: 0.75,
        max_daily_turnover_usd: 250000,
        min_liquidity_usd: 100000,
        max_spread_bps: 150,
        max_slippage_bps: 150
      }
    },
    stats: { market_regime: 'neutral' },
    ...overrides
  };
}

function riskInput(capitalMandate = null, overrides = {}) {
  return {
    mode: 'paper',
    enforcement_mode: 'enforced',
    evaluated_at: '2026-08-27T13:00:00.000Z',
    portfolio: portfolioFixture(overrides.portfolio),
    capital_mandate: capitalMandate,
    analytics: {
      evaluated_at: '2026-08-27T13:00:00.000Z',
      market_regime: 'neutral',
      day_start_equity_usd: 100000,
      review_stats: { setup_expectancy: [] }
    },
    intent: {
      side: 'buy',
      symbol: 'AI',
      contract_address: '0xai',
      category: 'ai',
      strategy_version: 'paper-pipeline-v1',
      setup_type: 'breakout',
      requested_notional_usd: 5000,
      requested_quantity: 100,
      liquidity_usd: 500000,
      spread_bps: 20,
      slippage_bps: 30,
      ...overrides.intent
    }
  };
}

function seedSubmittedMandateChain(dataDir, correlationId = 'corr-acceptance-1', mandateId = 'mandate-acceptance-1') {
  const signal = appendEvent(dataDir, {
    type: 'investment.signal.detected',
    source: 'manual',
    subject: { type: 'market-signal', id: 'signal-acceptance' },
    payload: { topic: 'AI infrastructure' },
    correlationId
  });
  const proposal = appendEvent(dataDir, {
    type: 'proposal.created',
    source: 'proposal.capital_mandate',
    subject: { type: 'proposal', id: 'proposal-acceptance-1' },
    payload: {
      id: 'proposal-acceptance-1',
      type: 'capital_mandate',
      status: 'approved',
      correlationId,
      createdAt: signal.occurredAt,
      payload: {
        mandate_id: mandateId,
        version: 1,
        owner: 'futco',
        status: 'approved',
        created_at: signal.occurredAt,
        approved_at: signal.occurredAt,
        correlation_id: correlationId,
        proposal_id: 'proposal-acceptance-1',
        decision_id: 'decision-acceptance-1',
        objective: 'Constrain paper trades.'
      }
    },
    causationId: signal.id,
    correlationId
  });
  const approved = appendEvent(dataDir, {
    type: 'proposal.approved',
    source: 'decision:cli',
    subject: { type: 'proposal', id: 'proposal-acceptance-1' },
    payload: { decision: 'approved', reason: 'Go', decidedBy: 'chris', decisionId: 'decision-acceptance-1', via: 'cli' },
    causationId: proposal.id,
    correlationId
  });
  return appendEvent(dataDir, {
    type: 'capital-mandate.submitted',
    source: 'action:capital_mandate',
    subject: { type: 'proposal', id: 'proposal-acceptance-1' },
    payload: {
      proposalId: 'proposal-acceptance-1',
      mandateId,
      owner: 'futco',
      previousStatus: 'approved',
      submittedStatus: 'active',
      tradeStatus: 'active',
      submittedAt: approved.occurredAt
    },
    causationId: approved.id,
    correlationId
  });
}

test('acceptance 1, 3, and 6: inactive or absent mandates do not influence e3d-trade behavior', () => {
  const baseline = evaluateRiskDecision(riskInput(null));

  for (const mandate of [
    activeMandate({ status: 'proposed' }),
    activeMandate({ status: 'revoked' }),
    activeMandate({ status: 'suspended' }),
    activeMandate({ expires_at: '2026-08-27T12:30:00.000Z' })
  ]) {
    assert.deepEqual(evaluateRiskDecision(riskInput(mandate)), baseline);
    assert.equal(applyMandateScoutBias([{ token: { symbol: 'AI', category: 'ai' }, opportunity_score: 50 }], mandate)[0].mandate_trace, undefined);
  }
});

test('acceptance 2 and 5: malformed or risk-relaxing mandates are rejected by intake validation', () => {
  const malformed = validateTradeCapitalMandatePayload({ mandate_id: 'bad' }, { riskPolicy: RISK_POLICY });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.length > 0);

  const relaxing = validateMandateConstraintsAgainstPolicy({
    max_position_size_pct: 0.50,
    min_liquidity_usd: 1000
  }, RISK_POLICY);
  assert.equal(relaxing.valid, false);
  assert.ok(relaxing.errors.some((error) => /relax/.test(error)));

  assert.throws(
    () => submitTradeCapitalMandate(activeMandate({ constraints: { max_position_size_pct: 0.50 } }), { riskPolicy: RISK_POLICY }),
    /INVALID_CAPITAL_MANDATE/
  );
});

test('acceptance 4: duplicate mandate submission is idempotent with no duplicate state', () => {
  const dir = tempDir('e3d-corp-acceptance-mandates-');
  const stateFile = path.join(dir, 'capital-mandates.json');
  try {
    const mandate = activeMandate();
    const first = submitTradeCapitalMandate(mandate, { stateFile, riskPolicy: RISK_POLICY });
    const second = submitTradeCapitalMandate(mandate, { stateFile, riskPolicy: RISK_POLICY });

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).mandates.length, 1);
    assert.equal(getActiveCapitalMandate({ stateFile, now: '2026-08-27T13:00:00.000Z' }).mandate_id, mandate.mandate_id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance 7 and 8: active mandate biases Scout, constrains Risk, and carries audit trace', () => {
  const mandate = activeMandate();
  const biased = applyMandateScoutBias([
    { token: { symbol: 'AI', category: 'ai' }, opportunity_score: 50 },
    { token: { symbol: 'SOL', category: 'layer1' }, opportunity_score: 50 }
  ], mandate);

  assert.equal(biased[0].opportunity_score, 55);
  assert.equal(biased[0].mandate_trace.mandate_id, mandate.mandate_id);
  assert.equal(biased[0].mandate_trace.correlation_id, mandate.correlation_id);
  assert.equal(biased[1].mandate_trace, undefined);

  const riskDecision = evaluateRiskDecision(riskInput(mandate, {
    intent: { requested_notional_usd: 7000 }
  }));
  assert.equal(riskDecision.decision, 'block');
  assert.ok(riskDecision.blockers.includes('mandate_max_trade_notional'));
  assert.equal(riskDecision.capital_mandate.mandate_id, mandate.mandate_id);
  assert.equal(riskDecision.capital_mandate.correlation_id, mandate.correlation_id);

  const tradeRecord = {
    event_id: 'trade-acceptance-1',
    schema_version: '1.0',
    ts: '2026-08-27T14:00:00.000Z',
    event_type: 'trade',
    actor: 'executor',
    pipeline_run_id: 'run-acceptance',
    cycle_id: 'cycle-acceptance',
    cycle_index: 1,
    market_regime: 'neutral',
    candidate_id: '0xai',
    position_id: 'pos-acceptance-1',
    trade_id: 'trade-acceptance-1',
    payload: {
      trade_id: 'trade-acceptance-1',
      position_id: 'pos-acceptance-1',
      trade: { ts: '2026-08-27T14:00:00.000Z', side: 'buy', symbol: 'AI', contract_address: '0xai', chain: 'base', avg_entry_price: 1.2 },
      mandate_trace: {
        mandate_id: mandate.mandate_id,
        correlation_id: mandate.correlation_id,
        proposal_id: mandate.proposal_id,
        decision_id: mandate.decision_id
      }
    }
  };
  const mappedAudit = mapTradeOutcomeEvent(tradeRecord);
  const callbacks = mapCorpOutcomeCallbacks([tradeRecord]);

  assert.match(mappedAudit.payload_json, /mandate-acceptance-1/);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].mandate_id, mandate.mandate_id);
  assert.equal(callbacks[0].correlation_id, mandate.correlation_id);
});

test('acceptance 9 and 10: trade outcomes return to the originating corp chain idempotently', () => {
  const dataDir = tempDir('e3d-corp-acceptance-outcome-');
  try {
    const submission = seedSubmittedMandateChain(dataDir);
    const payload = {
      outcome_id: 'outcome-acceptance-1',
      mandate_id: 'mandate-acceptance-1',
      correlation_id: submission.correlationId,
      type: 'trade.executed',
      occurred_at: '2026-08-27T15:00:00.000Z',
      trade_id: 'trade-acceptance-1',
      position_id: 'pos-acceptance-1',
      symbol: 'AI',
      chain: 'base',
      side: 'buy',
      source_event_id: 'trade-acceptance-1',
      portfolio_snapshot: { equity_usd: 101000, cash_usd: 94000, open_positions: 2 }
    };

    const first = recordTradeOutcomeReturn(dataDir, payload);
    const second = recordTradeOutcomeReturn(dataDir, payload);

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    const outcomes = queryEvents(dataDir, { type: 'trade.executed', correlationId: submission.correlationId });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].causationId, submission.id);
    assert.equal(outcomes[0].payload.mandate_id, 'mandate-acceptance-1');
    assert.equal(readExperience(dataDir, submission.correlationId).outcome.trade_id, 'trade-acceptance-1');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('acceptance 11: paper trading remains the default and mandate work does not enable live execution', () => {
  const decision = evaluateRiskDecision(riskInput(activeMandate()));
  assert.equal(decision.mode, 'paper');
  assert.equal(decision.live_submission_enabled, false);
  assert.equal(decision.live_submission_attempted, false);

  const settingsDefault = fs.readFileSync(path.join('..', 'e3d-trade', 'pipeline.js'), 'utf8');
  assert.match(settingsDefault, /paper_mode:\s*true/);
  assert.match(settingsDefault, /live_execution_allowed:\s*false/);
});

test('acceptance 12: historical decisions, mandates, and outcomes are append-only and tamper-evident', () => {
  const dataDir = tempDir('e3d-corp-acceptance-immutability-');
  try {
    const submission = seedSubmittedMandateChain(dataDir);
    recordTradeOutcomeReturn(dataDir, {
      outcome_id: 'outcome-immutability-1',
      mandate_id: 'mandate-acceptance-1',
      correlation_id: submission.correlationId,
      type: 'trade.realized',
      occurred_at: '2026-08-27T16:00:00.000Z',
      trade_id: 'trade-acceptance-1',
      pnl_usd: 42,
      outcome_label: 'profit'
    });

    assert.equal(verifyEventChain(dataDir).valid, true);

    const filePath = eventsFilePath(dataDir);
    const records = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const approved = records.find((record) => record.type === 'proposal.approved');
    approved.payload.reason = 'retroactively changed after outcome';
    fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const verification = verifyEventChain(dataDir);
    assert.equal(verification.valid, false);
    assert.match(verification.reason, /altered|hashes/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
