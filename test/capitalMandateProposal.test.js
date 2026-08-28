import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { AUTHORITY_LEVELS, assertProposalAuthorized, getRequiredAuthorityLevel } from '../lib/authority/policy.js';
import { decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { createProposal } from '../lib/proposals/create.js';
import { proposeCapitalMandate } from '../lib/proposals/capitalMandate.js';
import {
  CAPITAL_MANDATE_STATUSES,
  normalizeCapitalMandatePayload,
  validateCapitalMandatePayload,
  validateCapitalMandateTransition
} from '../lib/proposals/capitalMandateSchema.js';
import { getProposal } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-capital-mandate-'));
}

function proposedBy(overrides = {}) {
  return { role: 'opportunity.investing', provider: 'local', model: 'test-model', ...overrides };
}

function validMandate(overrides = {}) {
  return {
    owner: 'futco',
    expires_at: '2026-12-31T00:00:00.000Z',
    thesis_refs: ['thesis-btc-liquidity'],
    story_refs: ['story-wallet-accumulation'],
    objective: {
      summary: 'Allocate paper capital only when E3D thesis and story evidence align with the current risk posture.'
    },
    constraints: {
      max_position_pct: 0.12,
      max_gross_exposure_pct: 0.35,
      allowed_assets: ['BTC', 'ETH'],
      blocked_assets: ['DOGE'],
      paper_only: true,
      live_execution_allowed: false,
      risk_sovereign: true
    },
    preferences: {
      discovery_bias: ['high-conviction thesis refs', 'confirmed on-chain story flow']
    },
    horizon: {
      min_days: 14,
      max_days: 90
    },
    confidence: 0.73,
    invalidation: 'Invalidate if story activity breaks down or risk rejects the exposure.',
    ...overrides
  };
}

function seedPursuingInvestingOpportunity(dataDir) {
  const correlationId = 'capital-mandate-chain';
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

test('capital_mandate schema validates the full lifecycle field set and deterministic mandate id', () => {
  const normalized = normalizeCapitalMandatePayload(validMandate(), {
    proposalId: 'proposal-1',
    correlationId: 'corr-1',
    createdAt: '2026-08-27T20:00:00.000Z'
  });

  assert.equal(normalized.version, '1.0');
  assert.equal(normalized.status, 'proposed');
  assert.equal(normalized.created_at, '2026-08-27T20:00:00.000Z');
  assert.equal(normalized.proposal_id, 'proposal-1');
  assert.equal(normalized.correlation_id, 'corr-1');
  assert.equal(normalized.decision_id, null);
  assert.equal(normalized.approved_at, null);
  assert.equal(normalized.revoked_at, null);
  assert.match(normalized.mandate_id, /^mandate_[0-9a-f]{24}$/);

  const again = normalizeCapitalMandatePayload(validMandate(), {
    proposalId: 'proposal-1',
    correlationId: 'corr-1',
    createdAt: '2026-08-27T20:00:00.000Z'
  });
  assert.equal(again.mandate_id, normalized.mandate_id);
  assert.equal(validateCapitalMandatePayload(normalized).valid, true);
});

test('capital_mandate lifecycle accepts only the declared forward path', () => {
  assert.deepEqual(CAPITAL_MANDATE_STATUSES, [
    'proposed',
    'approved',
    'active',
    'completed',
    'expired',
    'revoked',
    'suspended'
  ]);
  assert.equal(validateCapitalMandateTransition('proposed', 'approved').valid, true);
  assert.equal(validateCapitalMandateTransition('approved', 'active').valid, true);
  assert.equal(validateCapitalMandateTransition('active', 'completed').valid, true);
  assert.equal(validateCapitalMandateTransition('active', 'expired').valid, true);
  assert.equal(validateCapitalMandateTransition('active', 'revoked').valid, true);
  assert.equal(validateCapitalMandateTransition('active', 'suspended').valid, true);
  assert.match(validateCapitalMandateTransition('proposed', 'active').errors[0], /cannot transition/);
  assert.match(validateCapitalMandateTransition('revoked', 'active').errors[0], /cannot transition/);
});

test('capital_mandate constraints reject relaxation, override, bypass, and live-execution signals', () => {
  assert.throws(
    () =>
      normalizeCapitalMandatePayload(validMandate({ constraints: { override_risk_rejection: true } }), {
        proposalId: 'proposal-1',
        correlationId: 'corr-1',
        createdAt: '2026-08-27T20:00:00.000Z'
      }),
    /constraints may only tighten/
  );
  assert.throws(
    () =>
      normalizeCapitalMandatePayload(validMandate({ constraints: { live_execution_allowed: true } }), {
        proposalId: 'proposal-1',
        correlationId: 'corr-1',
        createdAt: '2026-08-27T20:00:00.000Z'
      }),
    /cannot enable live execution/
  );
  assert.throws(
    () =>
      normalizeCapitalMandatePayload(validMandate({ constraints: { exposure: { operator: '>=', value: 0.9 } } }), {
        proposalId: 'proposal-1',
        correlationId: 'corr-1',
        createdAt: '2026-08-27T20:00:00.000Z'
      }),
    /can signal loosening/
  );
  assert.throws(
    () =>
      normalizeCapitalMandatePayload(validMandate({ constraints: { note: 'bypass the deterministic risk gate' } }), {
        proposalId: 'proposal-1',
        correlationId: 'corr-1',
        createdAt: '2026-08-27T20:00:00.000Z'
      }),
    /must not signal/
  );
});

test('capital_mandate proposal uses the existing human-gated Proposal and Decision pipeline', async () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunity = seedPursuingInvestingOpportunity(dataDir);

    const { proposal, event } = proposeCapitalMandate(dataDir, {
      opportunity,
      mandate: validMandate()
    });

    assert.equal(proposal.type, 'capital_mandate');
    assert.equal(proposal.authorityLevel, AUTHORITY_LEVELS.FINANCIAL_ACTION);
    assert.equal(getRequiredAuthorityLevel('capital_mandate'), AUTHORITY_LEVELS.FINANCIAL_ACTION);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.status, 'proposed');
    assert.equal(proposal.payload.proposal_id, proposal.id);
    assert.equal(proposal.payload.correlation_id, opportunity.correlationId);
    assert.deepEqual(proposal.payload.thesis_refs, ['thesis-btc-liquidity']);
    assert.deepEqual(proposal.payload.story_refs, ['story-wallet-accumulation']);
    assert.equal(event.type, 'proposal.created');

    assert.throws(() => assertProposalAuthorized(proposal, 'capital_mandate'), /not approved \(status: pending\)/);

    const approval = await decideProposal(dataDir, proposal.id, 'approved', 'Delegate constrained paper authority', 'chris', 'cli');
    assert.equal(approval.executed, false);

    const approved = getProposal(dataDir, proposal.id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.payload.status, 'approved');
    assert.equal(approved.payload.decision_id, approval.decision.id);
    assert.equal(approved.payload.approved_at, approval.decision.decidedAt);
    assert.equal(assertProposalAuthorized(approved, 'capital_mandate'), true);

    await assert.rejects(confirmAndExecute(dataDir, proposal.id, 'chris', 'cli'), /No action executor registered/);

    const createdEvents = queryEvents(dataDir, { type: 'proposal.created', correlationId: opportunity.correlationId });
    assert.equal(createdEvents.length, 1);
    assert.equal(createdEvents[0].payload.payload.status, 'proposed');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createProposal rejects malformed capital_mandate payloads without a partial write', () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'investment.signal.detected',
      source: 'manual',
      subject: { type: 'market-signal', id: 'eth' },
      payload: {},
      correlationId: 'bad-mandate-chain'
    });

    assert.throws(
      () =>
        createProposal(dataDir, {
          type: 'capital_mandate',
          payload: validMandate({ status: 'active' }),
          proposedBy: proposedBy(),
          causationId: trigger.id,
          correlationId: trigger.correlationId
        }),
      /must start as proposed/
    );
    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
