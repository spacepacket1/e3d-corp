import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent } from '../lib/events/store.js';
import { autoProposeFromBriefs } from '../lib/proposals/autoProposeFromBrief.js';
import { listProposals } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-auto-propose-brief-'));
}

function sampleBrief(overrides = {}) {
  return {
    product: 'oppscan',
    audience: 'HVAC business owners in NorCal',
    objective: 'landing_page_view',
    baselineRef: null,
    constraints: [],
    spendCeiling: null,
    metric: 'cost per landing page view',
    threshold: 'below $4.50',
    ...overrides
  };
}

function seedOpportunity(dataDir, { opportunityId, status = 'pursuing' } = {}) {
  const correlationId = `auto-propose-${opportunityId}`;
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
      description: 'CPL has crept up over two weeks on the HVAC campaign.',
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

  if (status !== 'candidate') {
    appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'decision:cli',
      subject: { type: 'opportunity', id: opportunityId },
      payload: { decision: status, status, reason: 'test setup', decidedBy: 'chris', via: 'cli' },
      causationId: created.id,
      correlationId
    });
  }

  return correlationId;
}

function seedDraftedBrief(dataDir, { opportunityId, correlationId, briefOverrides = {} } = {}) {
  return appendEvent(dataDir, {
    type: 'creative-brief.drafted',
    source: 'role:creative.brief',
    subject: { type: 'opportunity', id: opportunityId },
    payload: {
      opportunityId,
      opportunityTitle: 'HVAC ad is underperforming on landing-page views',
      brief: sampleBrief(briefOverrides),
      rationale: 'CPL on the HVAC campaign has crept up 40% over two weeks per evidence ev-1.',
      evidenceEventIds: ['ev-1'],
      role: 'creative.brief',
      provider: 'claude',
      model: 'claude-test-model'
    },
    correlationId
  });
}

test('a drafted brief for a pursuing opportunity is auto-proposed exactly once', () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunityId = 'opp-auto-1';
    const correlationId = seedOpportunity(dataDir, { opportunityId });
    const drafted = seedDraftedBrief(dataDir, { opportunityId, correlationId });

    const firstPass = autoProposeFromBriefs(dataDir, { instanceConfig: {} });
    assert.equal(firstPass.length, 1);
    assert.equal(firstPass[0].status, 'proposed');
    assert.equal(firstPass[0].draftedEventId, drafted.id);

    const proposals = listProposals(dataDir, { type: 'commission-creative' });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].payload.sourceBriefEventId, drafted.id);
    assert.equal(proposals[0].payload.opportunityId, opportunityId);
    assert.deepEqual(proposals[0].payload.brief, sampleBrief());
    assert.equal(proposals[0].proposedBy.role, 'creative.brief');
    assert.equal(proposals[0].proposedBy.provider, 'claude');
    assert.equal(proposals[0].proposedBy.model, 'claude-test-model');
    assert.match(proposals[0].payload.reason, /CPL on the HVAC campaign/);

    // Running the scan again must not create a duplicate proposal.
    const secondPass = autoProposeFromBriefs(dataDir, { instanceConfig: {} });
    assert.equal(secondPass.length, 1);
    assert.equal(secondPass[0].status, 'already-proposed');
    assert.equal(listProposals(dataDir, { type: 'commission-creative' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a drafted brief whose opportunity is not "pursuing" is skipped cleanly, with no proposal and no error', () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunityId = 'opp-auto-2';
    const correlationId = seedOpportunity(dataDir, { opportunityId, status: 'candidate' });
    const drafted = seedDraftedBrief(dataDir, { opportunityId, correlationId });

    const results = autoProposeFromBriefs(dataDir, { instanceConfig: {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'skipped');
    assert.equal(results[0].draftedEventId, drafted.id);
    assert.match(results[0].reason, /not "pursuing"/);
    assert.equal(listProposals(dataDir, { type: 'commission-creative' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a drafted brief whose opportunity no longer exists is skipped cleanly', () => {
  const dataDir = makeTempDataDir();
  try {
    const drafted = appendEvent(dataDir, {
      type: 'creative-brief.drafted',
      source: 'role:creative.brief',
      subject: { type: 'opportunity', id: 'opp-does-not-exist' },
      payload: {
        opportunityId: 'opp-does-not-exist',
        opportunityTitle: 'Ghost opportunity',
        brief: sampleBrief(),
        rationale: 'test',
        evidenceEventIds: ['ev-1'],
        role: 'creative.brief',
        provider: 'claude',
        model: 'claude-test-model'
      },
      correlationId: 'corr-ghost'
    });

    const results = autoProposeFromBriefs(dataDir, { instanceConfig: {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'skipped');
    assert.equal(results[0].draftedEventId, drafted.id);
    assert.match(results[0].reason, /not found/);
    assert.equal(listProposals(dataDir, { type: 'commission-creative' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('two distinct drafted briefs for the same opportunity each get their own proposal', () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunityId = 'opp-auto-3';
    const correlationId = seedOpportunity(dataDir, { opportunityId });
    const firstDraft = seedDraftedBrief(dataDir, { opportunityId, correlationId, briefOverrides: { objective: 'landing_page_view' } });
    const secondDraft = seedDraftedBrief(dataDir, { opportunityId, correlationId, briefOverrides: { objective: 'lead_gen' } });

    const results = autoProposeFromBriefs(dataDir, { instanceConfig: {} });
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === 'proposed'));

    const proposals = listProposals(dataDir, { type: 'commission-creative' });
    assert.equal(proposals.length, 2);
    const sourceIds = proposals.map((proposal) => proposal.payload.sourceBriefEventId).sort();
    assert.deepEqual(sourceIds, [firstDraft.id, secondDraft.id].sort());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a drafted brief missing provider/model falls back to safe non-empty defaults for proposedBy', () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunityId = 'opp-auto-4';
    const correlationId = seedOpportunity(dataDir, { opportunityId });
    appendEvent(dataDir, {
      type: 'creative-brief.drafted',
      source: 'role:creative.brief',
      subject: { type: 'opportunity', id: opportunityId },
      payload: {
        opportunityId,
        opportunityTitle: 'HVAC ad is underperforming on landing-page views',
        brief: sampleBrief(),
        rationale: '',
        evidenceEventIds: ['ev-1']
        // provider/model deliberately omitted
      },
      correlationId
    });

    const results = autoProposeFromBriefs(dataDir, { instanceConfig: {} });
    assert.equal(results[0].status, 'proposed');
    const [proposal] = listProposals(dataDir, { type: 'commission-creative' });
    assert.equal(proposal.proposedBy.provider, 'unknown');
    assert.equal(proposal.proposedBy.model, 'unknown');
    assert.match(proposal.payload.reason, /Auto-proposed from creative\.brief draft/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
