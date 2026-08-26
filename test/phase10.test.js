import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent } from '../lib/events/store.js';
import { createProposal } from '../lib/proposals/create.js';
import { recordOutcome } from '../lib/outcomes/record.js';
import { computeMetrics, formatMetricsReport, POSITIVE_OUTCOME_TYPES } from '../lib/evaluation/metrics.js';
import { loadInstance } from '../lib/config.js';
import { createRequestListener } from '../lib/web/server.js';
import { computeBudgetStatus } from '../lib/llm/budget.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-metrics-'));
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeTempInstance(extra = {}) {
  const name = `phase10-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  const config = {
    name,
    dataDir,
    llm: {
      providers: {
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      }
    },
    research: { knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
    eventSources: [],
    roles: {},
    ...extra
  };
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify(config, null, 2));
  return { name, instanceDir, config, dataDir: path.join(ROOT, dataDir) };
}

function cleanupTempInstance(instance) {
  fs.rmSync(instance.instanceDir, { recursive: true, force: true });
}

async function invokeGet(listener, url, headers = {}) {
  const req = new PassThrough();
  req.method = 'GET';
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  req.end();

  let body = '';
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headersToSet = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headersToSet)) {
        this.headers[name.toLowerCase()] = value;
      }
    },
    end(chunk = '') {
      body += chunk;
      resolveDone();
    }
  };

  await listener(req, res);
  await done;
  return { statusCode: res.statusCode, body, headers: res.headers };
}

function seedOpportunity(dataDir, { id, type, correlationId, decision }) {
  const signal = appendEvent(dataDir, {
    type: 'market.signal.detected',
    source: 'discovery.scheduled',
    subject: { type: 'research-topic', id },
    payload: {},
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id },
    payload: {
      id,
      type,
      title: `Opportunity ${id}`,
      description: 'desc',
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
  let reviewed = null;
  if (decision) {
    reviewed = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'decision:cli',
      subject: { type: 'opportunity', id },
      payload: { decision, status: decision, reason: 'test', decidedBy: 'chris', via: 'cli' },
      causationId: created.id,
      correlationId
    });
  }
  return { created, reviewed };
}

// Builds a small, fully known fixture: 3 opportunities (2 consulting-
// engagement, 1 product-opportunity); 2 reviewed pursuing, 1 no-value; 2
// proposals (1 approved+fired, 1 rejected); 2 outreach.sent actions; chain 1
// gets prospect.replied -> meeting.booked -> deal.won (with a $500
// invoice.paid outcome too), chain 2 gets nothing further. Every expected
// metric below is hand-computed from exactly this setup.
function seedFixture(dataDir) {
  const chain1 = 'phase10-chain-1';
  const chain2 = 'phase10-chain-2';
  const chain3 = 'phase10-chain-3';

  seedOpportunity(dataDir, { id: 'opp-1', type: 'consulting-engagement', correlationId: chain1, decision: 'pursuing' });
  seedOpportunity(dataDir, { id: 'opp-2', type: 'consulting-engagement', correlationId: chain2, decision: 'pursuing' });
  seedOpportunity(dataDir, { id: 'opp-3', type: 'product-opportunity', correlationId: chain3, decision: 'no-value' });

  appendEvent(dataDir, {
    type: 'role.provider.completed',
    source: 'role:opportunity.communicator',
    subject: { type: 'role', id: 'opportunity.communicator' },
    payload: {
      role: 'opportunity.communicator',
      provider: 'local',
      model: 'qwen2.5',
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      costUsd: 0.25,
      latencyMs: 1200
    },
    correlationId: chain1
  });
  appendEvent(dataDir, {
    type: 'role.provider.completed',
    source: 'role:opportunity.communicator',
    subject: { type: 'role', id: 'opportunity.communicator' },
    payload: {
      role: 'opportunity.communicator',
      provider: 'local',
      model: 'qwen2.5',
      usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
      costUsd: 0.15,
      latencyMs: 800
    },
    correlationId: chain2
  });
  appendEvent(dataDir, {
    type: 'role.provider.failed',
    source: 'role:opportunity.communicator',
    subject: { type: 'role', id: 'opportunity.communicator' },
    payload: {
      role: 'opportunity.communicator',
      provider: 'local',
      model: 'qwen2.5',
      usage: null,
      costUsd: null,
      latencyMs: 200,
      reason: 'LLM request timed out after 50ms'
    },
    correlationId: chain2
  });
  appendEvent(dataDir, {
    type: 'role.provider.reserved',
    source: 'llm.budget',
    subject: { type: 'provider', id: 'local' },
    payload: {
      role: 'opportunity.communicator',
      provider: 'local',
      reservationId: 'phase10-local-outstanding',
      estimatedTokens: 40
    },
    correlationId: 'phase10-local-outstanding'
  });

  // Chain 1: approved proposal, fired outreach, full positive outcome funnel.
  const { proposal: proposal1 } = createProposal(dataDir, {
    type: 'send-outreach',
    payload: { to: 'a@example.com', subject: 's', body: 'b', opportunityId: 'opp-1' },
    proposedBy: { role: 'opportunity.communicator', provider: 'local', model: 'qwen2.5' },
    causationId: null,
    correlationId: chain1
  });
  appendEvent(dataDir, {
    type: 'proposal.approved',
    source: 'decision:cli',
    subject: { type: 'proposal', id: proposal1.id },
    payload: { decision: 'approved', decidedBy: 'chris', via: 'cli' },
    correlationId: chain1
  });
  appendEvent(dataDir, {
    type: 'outreach.sent',
    source: 'action:send-outreach',
    subject: { type: 'proposal', id: proposal1.id },
    payload: { proposalId: proposal1.id, opportunityId: 'opp-1', to: 'a@example.com', subject: 's', body: 'b' },
    correlationId: chain1
  });
  recordOutcome(dataDir, { correlationId: chain1, type: 'prospect.replied', payload: {} });
  recordOutcome(dataDir, { correlationId: chain1, type: 'meeting.booked', payload: { with: 'a@example.com' } });
  recordOutcome(dataDir, { correlationId: chain1, type: 'deal.won', payload: {} });
  recordOutcome(dataDir, { correlationId: chain1, type: 'invoice.paid', payload: { amount: 500 } });

  // Chain 2: rejected proposal, outreach still fired on a *different* level-2
  // action just to exercise "sent" without a reply (no outcome recorded).
  const { proposal: proposal2 } = createProposal(dataDir, {
    type: 'send-outreach',
    payload: { to: 'b@example.com', subject: 's2', body: 'b2', opportunityId: 'opp-2' },
    proposedBy: { role: 'opportunity.communicator', provider: 'local', model: 'qwen2.5' },
    causationId: null,
    correlationId: chain2
  });
  appendEvent(dataDir, {
    type: 'outreach.sent',
    source: 'action:send-outreach',
    subject: { type: 'proposal', id: proposal2.id },
    payload: { proposalId: proposal2.id, opportunityId: 'opp-2', to: 'b@example.com', subject: 's2', body: 'b2' },
    correlationId: chain2
  });

  const { proposal: proposal3 } = createProposal(dataDir, {
    type: 'issue-invoice',
    payload: { amount: 200 },
    proposedBy: { role: 'finance.bookkeeper', provider: 'local', model: 'qwen2.5' },
    causationId: null,
    correlationId: chain3
  });
  appendEvent(dataDir, {
    type: 'proposal.rejected',
    source: 'decision:cli',
    subject: { type: 'proposal', id: proposal3.id },
    payload: { decision: 'rejected', decidedBy: 'chris', via: 'cli' },
    correlationId: chain3
  });

  return { chain1, chain2, chain3 };
}

test('computeMetrics against a fixture with a known mix of outcomes matches hand-computed expected values for every metric', () => {
  const dataDir = makeTempDataDir();
  try {
    seedFixture(dataDir);
    const metrics = computeMetrics(dataDir);

    assert.equal(metrics.opportunitiesDiscovered.total, 3);
    assert.deepEqual(metrics.opportunitiesDiscovered.byType, { 'consulting-engagement': 2, 'product-opportunity': 1 });

    assert.equal(metrics.opportunityAcceptance.pursuing, 2);
    assert.equal(metrics.opportunityAcceptance.noValue, 1);
    assert.equal(metrics.opportunityAcceptance.rate, 2 / 3);

    assert.equal(metrics.proposalRejection.approved, 1);
    assert.equal(metrics.proposalRejection.rejected, 1);
    assert.equal(metrics.proposalRejection.rate, 0.5);

    assert.equal(metrics.outreach.sent, 2);
    assert.equal(metrics.outreach.replied, 1);
    assert.equal(metrics.outreach.responseRate, 0.5);
    assert.equal(metrics.outreach.meetingsBooked, 1);
    assert.equal(metrics.outreach.meetingBookedRate, 0.5);
    assert.equal(metrics.outreach.dealsWon, 1);
    assert.equal(metrics.outreach.dealWinRate, 0.5);

    assert.equal(metrics.revenueAttributable, 500);

    // Chain 1 recorded 4 outcomes over time (append-only); the latest
    // snapshot's outcome is invoice.paid (positive) - counted once, not 4x.
    assert.equal(metrics.usefulOpportunityCount, 1);
    assert.equal(metrics.costPerUsefulOpportunity, 0.25);
    assert.deepEqual(metrics.costByRoleModel, { 'opportunity.communicator:local:qwen2.5': 0.2 });

    assert.ok('opportunity.communicator:local:qwen2.5' in metrics.latencyByRoleModel);
    assert.equal(metrics.latencyByRoleModel['opportunity.communicator:local:qwen2.5'], (1200 + 800 + 200) / 3);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('computeMetrics --since filters out opportunities/events before the cutoff', () => {
  const dataDir = makeTempDataDir();
  try {
    seedFixture(dataDir);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const metrics = computeMetrics(dataDir, { since: future });
    assert.equal(metrics.opportunitiesDiscovered.total, 0);
    assert.equal(metrics.outreach.sent, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('formatMetricsReport renders human-readable rates and honestly reports "no data" rather than a fabricated 0%/number', () => {
  const dataDir = makeTempDataDir();
  try {
    const report = formatMetricsReport(computeMetrics(dataDir));
    assert.match(report, /Opportunities discovered: 0/);
    assert.match(report, /n\/a \(no data\)/);
    assert.match(report, /n\/a \(no cost data recorded yet\)/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: evaluate report renders the same fixture metrics as computeMetrics', () => {
  const instance = makeTempInstance({
    llm: {
      providers: {
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      },
      budget: {
        period: 'daily',
        limits: {
          local: { tokens: 500 }
        }
      }
    }
  });
  try {
    seedFixture(instance.dataDir);
    const direct = computeBudgetStatus(instance.dataDir, instance.config, 'local');
    const output = runCli(['evaluate', 'report', '--instance', instance.name]);
    assert.match(output, /Opportunities discovered: 3/);
    assert.match(output, /pursuing=2 no-value=1/);
    assert.match(output, /approved=1 rejected=1/);
    assert.match(output, /Revenue attributable: 500/);
    assert.match(
      output,
      new RegExp(`local: spent=${direct.settled} allocated=${direct.limit} outstanding=${direct.outstanding} remaining=${direct.remaining}`)
    );
  } finally {
    cleanupTempInstance(instance);
  }
});

test('web /metrics renders the same fixture metrics as computeMetrics', async () => {
  const instance = makeTempInstance({
    llm: {
      providers: {
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      },
      budget: {
        period: 'daily',
        limits: {
          local: { tokens: 500 }
        }
      }
    },
    web: { authUserEnvVar: 'PHASE10_WEB_USER', authPassEnvVar: 'PHASE10_WEB_PASS', port: 3999 }
  });
  process.env.PHASE10_WEB_USER = 'chris';
  process.env.PHASE10_WEB_PASS = 'secret';
  try {
    seedFixture(instance.dataDir);
    const listener = createRequestListener({ config: instance.config, dataDir: instance.dataDir });
    const direct = computeBudgetStatus(instance.dataDir, instance.config, 'local');
    const res = await invokeGet(listener, '/metrics', {
      authorization: `Basic ${Buffer.from('chris:secret').toString('base64')}`
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Total: 3/);
    assert.match(res.body, /pursuing=2 no-value=1/);
    assert.match(res.body, /Revenue attributable: 500/);
    assert.match(
      res.body,
      new RegExp(`local: spent=${direct.settled} allocated=${direct.limit} outstanding=${direct.outstanding} remaining=${direct.remaining}`)
    );
  } finally {
    delete process.env.PHASE10_WEB_USER;
    delete process.env.PHASE10_WEB_PASS;
    cleanupTempInstance(instance);
  }
});

test('computeMetrics includes the same budget status objects computeBudgetStatus returns directly', () => {
  const instance = makeTempInstance({
    llm: {
      providers: {
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      },
      budget: {
        period: 'daily',
        limits: {
          local: { tokens: 500 }
        }
      }
    }
  });
  try {
    seedFixture(instance.dataDir);
    const metrics = computeMetrics(instance.dataDir, { instanceConfig: instance.config });
    assert.deepEqual(metrics.budget, [computeBudgetStatus(instance.dataDir, instance.config, 'local')]);
  } finally {
    cleanupTempInstance(instance);
  }
});

test('Phase 10 real-data bar: evaluate report against real (even sparse) FutCo data produces a real, non-fabricated report', () => {
  const { dataDir } = loadInstance('futco');
  const metrics = computeMetrics(dataDir);

  // Whatever the real numbers are, structural honesty is what's asserted:
  // real counts (not NaN/undefined), rates either a real fraction or an
  // explicit null (never a fabricated placeholder), and no crash walking
  // real FutCo data end to end through every metric this phase defines.
  assert.equal(typeof metrics.opportunitiesDiscovered.total, 'number');
  assert.ok(metrics.opportunitiesDiscovered.total >= 6, 'expected at least the real Phase 4 opportunities to be counted');
  assert.ok(
    metrics.opportunityAcceptance.rate === null || (metrics.opportunityAcceptance.rate >= 0 && metrics.opportunityAcceptance.rate <= 1)
  );
  assert.ok(metrics.costPerUsefulOpportunity === null || typeof metrics.costPerUsefulOpportunity === 'number');
  assert.equal(typeof metrics.revenueAttributable, 'number');
  assert.ok(!Number.isNaN(metrics.revenueAttributable));

  const report = formatMetricsReport(metrics);
  assert.match(report, /Opportunities discovered: \d+/);
  assert.ok(POSITIVE_OUTCOME_TYPES.length > 0);
});
