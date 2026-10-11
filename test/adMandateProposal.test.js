import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { AUTHORITY_LEVELS, assertProposalAuthorized, getRequiredAuthorityLevel } from '../lib/authority/policy.js';
import { decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { createProposal } from '../lib/proposals/create.js';
import { proposeAdMandate } from '../lib/proposals/adMandate.js';
import {
  AD_MANDATE_STATUSES,
  normalizeAdMandatePayload,
  validateAdMandatePayload,
  validateAdMandateTransition,
  validateAdMandateConstraintsAgainstPolicy
} from '../lib/proposals/adMandateSchema.js';
import { getProposal } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-ad-mandate-'));
}

function proposedBy(overrides = {}) {
  return { role: 'operator', provider: 'human', model: 'n/a', ...overrides };
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

function seedPursuingProductOpportunity(dataDir, { opportunityId = 'opp-ad-mandate' } = {}) {
  const correlationId = `ad-mandate-${opportunityId}`;
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
    payload: {
      id: opportunityId,
      type: 'product-opportunity',
      title: 'HVAC ad CPL has crept up 40%',
      description: 'Needs a spend envelope to safely let the loop iterate on creative.',
      correlationId
    },
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

  return {
    id: opportunityId,
    type: 'product-opportunity',
    title: 'HVAC ad CPL has crept up 40%',
    status: 'pursuing',
    correlationId
  };
}

test('ad_mandate schema validates the full field set and deterministic mandate id', () => {
  const normalized = normalizeAdMandatePayload(validAdMandate(), {
    proposalId: 'proposal-1',
    correlationId: 'corr-1',
    createdAt: '2026-10-11T20:00:00.000Z'
  });

  assert.equal(normalized.version, '1.0');
  assert.equal(normalized.status, 'proposed');
  assert.equal(normalized.proposal_id, 'proposal-1');
  assert.equal(normalized.correlation_id, 'corr-1');
  assert.equal(normalized.decision_id, null);
  assert.match(normalized.mandate_id, /^ad-mandate_[0-9a-f]{24}$/);

  const again = normalizeAdMandatePayload(validAdMandate(), {
    proposalId: 'proposal-1',
    correlationId: 'corr-1',
    createdAt: '2026-10-11T20:00:00.000Z'
  });
  assert.equal(again.mandate_id, normalized.mandate_id);
  assert.equal(validateAdMandatePayload(normalized).valid, true);
});

test('ad_mandate lifecycle accepts only the declared forward path', () => {
  assert.deepEqual(AD_MANDATE_STATUSES, ['proposed', 'approved', 'active', 'completed', 'expired', 'revoked', 'suspended']);
  assert.equal(validateAdMandateTransition('proposed', 'approved').valid, true);
  assert.equal(validateAdMandateTransition('approved', 'active').valid, true);
  assert.equal(validateAdMandateTransition('active', 'suspended').valid, true);
  assert.match(validateAdMandateTransition('proposed', 'active').errors[0], /cannot transition/);
  assert.match(validateAdMandateTransition('revoked', 'active').errors[0], /cannot transition/);
});

test('ad_mandate constraints reject relaxation/override/bypass signals and disabling paper_only_creative', () => {
  assert.throws(
    () =>
      normalizeAdMandatePayload(validAdMandate({ constraints: { ...validAdMandate().constraints, override_spend_cap: true } }), {
        proposalId: 'p1',
        correlationId: 'c1'
      }),
    /constraints may only tighten/
  );
  assert.throws(
    () =>
      normalizeAdMandatePayload(validAdMandate({ constraints: { ...validAdMandate().constraints, paper_only_creative: false } }), {
        proposalId: 'p1',
        correlationId: 'c1'
      }),
    /cannot disable paper_only_creative/
  );
  assert.throws(
    () =>
      normalizeAdMandatePayload(validAdMandate({ constraints: { ...validAdMandate().constraints, note: 'bypass the spend cap' } }), {
        proposalId: 'p1',
        correlationId: 'c1'
      }),
    /must not signal/
  );
});

test('ad_mandate constraints are rejected when negative/malformed spend figures are given', () => {
  assert.throws(
    () =>
      normalizeAdMandatePayload(validAdMandate({ constraints: { ...validAdMandate().constraints, max_daily_spend_usd: -5 } }), {
        proposalId: 'p1',
        correlationId: 'c1'
      }),
    /max_daily_spend_usd: must be a positive number/
  );
});

test('validateAdMandateConstraintsAgainstPolicy fails closed with no policy, and rejects constraints above the hard ceiling', () => {
  const constraints = validAdMandate().constraints;

  const noPolicy = validateAdMandateConstraintsAgainstPolicy(constraints, undefined);
  assert.equal(noPolicy.valid, false);
  assert.match(noPolicy.errors[0], /missing or invalid/);

  const tooHigh = validateAdMandateConstraintsAgainstPolicy(constraints, { max_daily_spend_usd: 100, max_monthly_spend_usd: 3000 });
  assert.equal(tooHigh.valid, false);
  assert.match(tooHigh.errors[0], /exceeds the hard ceiling/);

  const withinCeiling = validateAdMandateConstraintsAgainstPolicy(constraints, { max_daily_spend_usd: 150, max_monthly_spend_usd: 3000 });
  assert.equal(withinCeiling.valid, true);
});

test('ad_mandate proposal uses the existing human-gated Proposal and Decision pipeline', async () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunity = seedPursuingProductOpportunity(dataDir);

    const { proposal, event } = proposeAdMandate(dataDir, {
      opportunity,
      mandate: validAdMandate(),
      proposedBy: proposedBy()
    });

    assert.equal(proposal.type, 'ad_mandate');
    assert.equal(proposal.authorityLevel, AUTHORITY_LEVELS.FINANCIAL_ACTION);
    assert.equal(getRequiredAuthorityLevel('ad_mandate'), AUTHORITY_LEVELS.FINANCIAL_ACTION);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.status, 'proposed');
    assert.equal(proposal.payload.correlation_id, opportunity.correlationId);
    assert.equal(event.type, 'proposal.created');

    assert.throws(() => assertProposalAuthorized(proposal, 'ad_mandate'), /not approved \(status: pending\)/);

    const approval = await decideProposal(dataDir, proposal.id, 'approved', 'Set a spend envelope', 'chris', 'cli');
    assert.equal(approval.executed, false);

    const approved = getProposal(dataDir, proposal.id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.payload.status, 'approved');
    assert.equal(assertProposalAuthorized(approved, 'ad_mandate'), true);

    // No executor registered in this test (lib/cli.js, which wires the real
    // one, is deliberately not imported here) - mirrors
    // capitalMandateProposal.test.js's equivalent assertion.
    await assert.rejects(confirmAndExecute(dataDir, proposal.id, 'chris', 'cli'), /No action executor registered/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createProposal rejects a malformed ad_mandate payload without a partial write', () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'research-topic', id: 'x' },
      payload: {},
      correlationId: 'bad-ad-mandate-chain'
    });

    assert.throws(
      () =>
        createProposal(dataDir, {
          type: 'ad_mandate',
          payload: validAdMandate({ status: 'active' }),
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
