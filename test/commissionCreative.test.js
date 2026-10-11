import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { proposeCommissionCreative } from '../lib/proposals/commissionCreative.js';
import { commissionCreative } from '../lib/actions/commissionCreative.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-commission-creative-'));
}

function seedPursuingProductOpportunity(dataDir, { opportunityId = 'opp-creative' } = {}) {
  const correlationId = `commission-creative-${opportunityId}`;
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
      title: 'HVAC ad is underperforming on landing-page views',
      description: 'CPL has crept up 40% over two weeks on the HVAC campaign.',
      evidence: [],
      score: null,
      status: 'candidate',
      sourceEventIds: [signal.id],
      correlationId,
      createdAt: signal.occurredAt
    },
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

  return {
    correlationId,
    opportunity: {
      id: opportunityId,
      type: 'product-opportunity',
      title: 'HVAC ad is underperforming on landing-page views',
      status: 'pursuing',
      correlationId
    }
  };
}

function sampleBrief() {
  return {
    product: 'oppscan',
    audience: 'HVAC business owners in NorCal',
    objective: 'landing_page_view',
    constraints: { maxDurationSeconds: 30 }
  };
}

test('proposeCommissionCreative requires a "pursuing" opportunity and derives authorityLevel 2 from the policy table', () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir);

    assert.throws(
      () =>
        proposeCommissionCreative(dataDir, {
          opportunity: { ...opportunity, status: 'scored' },
          brief: sampleBrief(),
          reason: 'test'
        }),
      /not "pursuing"/
    );

    const { proposal, event } = proposeCommissionCreative(dataDir, {
      opportunity,
      brief: sampleBrief(),
      reason: 'CPL has crept up, try a new creative direction'
    });

    assert.equal(proposal.type, 'commission-creative');
    assert.equal(proposal.authorityLevel, 2);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.opportunityId, opportunity.id);
    assert.deepEqual(proposal.payload.brief, sampleBrief());
    assert.equal(event.correlationId, opportunity.correlationId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('commissionCreative refuses a non-approved proposal, and against an approved one runs the engine and emits creative-commission.created', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir, { opportunityId: 'opp-creative-exec' });
    const { proposal } = proposeCommissionCreative(dataDir, {
      opportunity,
      brief: sampleBrief(),
      reason: 'CPL has crept up'
    });

    const instanceConfig = {
      creative: {
        enginePath: '/fake/e3d-creative',
        outDir: 'creative-commissions',
        defaultProviders: { conceptGeneration: 'claude', critique: 'claude', qa: 'claude' }
      }
    };

    await assert.rejects(
      commissionCreative(proposal, { dataDir, instanceConfig }),
      /not approved \(status: pending\)/
    );

    const approvalEvent = appendEvent(dataDir, {
      type: 'proposal.approved',
      source: 'decision:cli',
      subject: { type: 'proposal', id: proposal.id },
      payload: { decision: 'approved' },
      causationId: null,
      correlationId: proposal.correlationId
    });

    const approved = { ...proposal, status: 'approved' };
    const runEngineCalls = [];
    const result = await commissionCreative(approved, {
      dataDir,
      instanceConfig,
      causationId: approvalEvent.id,
      correlationId: proposal.correlationId,
      runEngine: async (args) => {
        runEngineCalls.push(args);
        return { stdout: 'run complete: 3 directions, 1 keep verdicts, 1 packaged directions\n' };
      }
    });

    assert.equal(result.commissioned, true);
    assert.equal(runEngineCalls.length, 1);
    assert.equal(runEngineCalls[0].enginePath, '/fake/e3d-creative');
    assert.deepEqual(runEngineCalls[0].providerFlags, [
      '--concept-provider', 'claude',
      '--critique-provider', 'claude',
      '--qa-provider', 'claude'
    ]);
    assert.ok(fs.existsSync(runEngineCalls[0].briefPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(runEngineCalls[0].briefPath, 'utf8')), sampleBrief());

    assert.equal(result.event.type, 'creative-commission.created');
    assert.equal(result.event.causationId, approvalEvent.id);
    assert.equal(result.event.correlationId, opportunity.correlationId);
    assert.equal(result.event.payload.opportunityId, 'opp-creative-exec');
    assert.match(result.event.payload.summary, /run complete/);

    const events = queryEvents(dataDir, { type: 'creative-commission.created' });
    assert.equal(events.length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('commissionCreative refuses when instance config has no creative.enginePath', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir, { opportunityId: 'opp-creative-noconfig' });
    const { proposal } = proposeCommissionCreative(dataDir, {
      opportunity,
      brief: sampleBrief(),
      reason: 'test'
    });
    const approved = { ...proposal, status: 'approved' };

    await assert.rejects(
      commissionCreative(approved, { dataDir, instanceConfig: {} }),
      /no "creative.enginePath"/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
