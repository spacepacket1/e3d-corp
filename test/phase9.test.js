import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createProposal } from '../lib/proposals/create.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { assertProposalAuthorized } from '../lib/authority/policy.js';
import { OUTCOME_TYPES } from '../lib/outcomes/schema.js';
import { recordOutcome } from '../lib/outcomes/record.js';
import { listOutcomes } from '../lib/outcomes/store.js';
import { assembleExperience } from '../lib/experience/assemble.js';
import { readExperience, listExperience } from '../lib/experience/store.js';
import { createRequestListener } from '../lib/web/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-experience-'));
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeTempInstance(extra = {}) {
  const name = `phase9-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  const config = {
    name,
    dataDir,
    llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
    research: { futcoMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
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

// Builds a full, real Event -> Opportunity -> Proposal -> Decision -> Action
// chain (mirroring Phase 5/7's own fixture chains) so assemble.js has every
// field to populate.
function seedFullChain(dataDir, { opportunityId = 'opp-full', correlationId = 'phase9-full-chain' } = {}) {
  const originating = appendEvent(dataDir, {
    type: 'lead.received',
    source: 'e3d-applied.contact-delivery',
    subject: { type: 'lead', id: 'lead-full' },
    payload: { submission: { email: 'prospect@example.com', workflowProblem: 'manual reporting' } },
    correlationId
  });
  const evidence = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.futcoMcp',
    subject: { type: 'research', id: 'ev-1' },
    payload: { kind: 'knowledge-base-search', query: 'reporting', resultSummary: '3 matches' },
    causationId: originating.id,
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id: opportunityId },
    payload: {
      id: opportunityId,
      type: 'consulting-engagement',
      title: 'Automate reporting for Prospect Co',
      description: 'They spend 10 hrs/week on manual reporting.',
      evidence: [evidence.id],
      score: null,
      status: 'candidate',
      sourceEventIds: [originating.id, evidence.id],
      correlationId,
      createdAt: originating.occurredAt
    },
    causationId: evidence.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.scored',
    source: 'opportunity.engine',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { id: opportunityId, score: { value: 0.8, rationale: 'strong fit' }, status: 'scored' },
    causationId: created.id,
    correlationId
  });
  const reviewed = appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth pursuing', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });
  const { proposal, event: proposalEvent } = createProposal(dataDir, {
    type: 'send-outreach',
    payload: { to: 'prospect@example.com', subject: 'Hello', body: 'Body', opportunityId },
    proposedBy: { role: 'opportunity.communicator', provider: 'local', model: 'qwen2.5' },
    causationId: reviewed.id,
    correlationId
  });
  const approved = appendEvent(dataDir, {
    type: 'proposal.approved',
    source: 'decision:cli',
    subject: { type: 'proposal', id: proposal.id },
    payload: { decision: 'approved', reason: 'Go', decidedBy: 'chris', via: 'cli' },
    causationId: proposalEvent.id,
    correlationId
  });
  const sent = appendEvent(dataDir, {
    type: 'outreach.sent',
    source: 'action:send-outreach',
    subject: { type: 'proposal', id: proposal.id },
    payload: { proposalId: proposal.id, opportunityId, to: 'prospect@example.com', subject: 'Hello', body: 'Body' },
    causationId: approved.id,
    correlationId
  });

  return { correlationId, opportunityId, proposal, events: { originating, evidence, created, reviewed, approved, sent } };
}

test('OUTCOME_TYPES includes the spec-documented starter list, distinguishable from Phase 5 Decision event types', () => {
  for (const type of ['prospect.replied', 'meeting.booked', 'deal.won', 'deal.lost', 'invoice.paid', 'capability.shipped', 'customer.adopted', 'opportunity.no-value']) {
    assert.ok(OUTCOME_TYPES.includes(type));
  }
  // proposal.rejected as an Outcome (an external party rejecting our quote)
  // must not collide with proposal.rejected as a Decision (Phase 5).
  assert.ok(!OUTCOME_TYPES.includes('proposal.rejected'));
  assert.ok(OUTCOME_TYPES.includes('outcome.proposal.rejected'));
});

test('recordOutcome requires a real chain and a known type, and appends an outcome event plus an experience.jsonl snapshot', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(
      () => recordOutcome(dataDir, { correlationId: 'does-not-exist', type: 'deal.won', payload: {} }),
      /No events found for correlationId/
    );

    const { correlationId } = seedFullChain(dataDir, { opportunityId: 'opp-record', correlationId: 'phase9-record' });

    assert.throws(
      () => recordOutcome(dataDir, { correlationId, type: 'not-a-real-type', payload: {} }),
      /Unknown outcome type/
    );

    const { outcome, event, experience } = recordOutcome(dataDir, {
      correlationId,
      type: 'meeting.booked',
      payload: { with: 'prospect@example.com', when: '2026-08-20' }
    });

    assert.equal(outcome.type, 'meeting.booked');
    assert.equal(event.type, 'meeting.booked');
    assert.equal(event.correlationId, correlationId);
    assert.equal(event.payload.with, 'prospect@example.com');
    assert.equal(experience.outcome.type, 'meeting.booked');

    const persisted = readExperience(dataDir, correlationId);
    assert.ok(persisted);
    assert.equal(persisted.outcome.type, 'meeting.booked');
    assert.equal(listExperience(dataDir).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('listOutcomes folds recorded outcome events from the log', () => {
  const dataDir = makeTempDataDir();
  try {
    const { correlationId } = seedFullChain(dataDir, { opportunityId: 'opp-list', correlationId: 'phase9-list' });
    recordOutcome(dataDir, { correlationId, type: 'deal.won', payload: { amount: 500 } });

    const outcomes = listOutcomes(dataDir);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].type, 'deal.won');
    assert.equal(outcomes[0].correlationId, correlationId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('assembleExperience against a full fixture chain (event -> opportunity -> proposal -> decision -> action -> outcome) produces a complete record with no missing required field', () => {
  const dataDir = makeTempDataDir();
  try {
    const { correlationId, proposal } = seedFullChain(dataDir, { opportunityId: 'opp-assemble', correlationId: 'phase9-assemble' });
    recordOutcome(dataDir, { correlationId, type: 'deal.won', payload: { amount: 1200 } });

    const experience = assembleExperience(dataDir, correlationId);

    for (const field of [
      'correlationId', 'context', 'originatingEvent', 'evidence', 'role', 'model',
      'proposal', 'decision', 'action', 'outcome', 'latencyMs', 'costEstimate'
    ]) {
      assert.ok(field in experience, `missing field: ${field}`);
    }

    assert.equal(experience.correlationId, correlationId);
    assert.match(experience.context, /Automate reporting/);
    assert.equal(experience.originatingEvent.type, 'lead.received');
    assert.equal(experience.evidence.length, 1);
    assert.equal(experience.role, 'opportunity.communicator');
    assert.equal(experience.model, 'local:qwen2.5');
    assert.equal(experience.proposal.id, proposal.id);
    assert.equal(experience.decision.decision, 'approved');
    assert.equal(experience.action.type, 'outreach.sent');
    assert.equal(experience.outcome.type, 'deal.won');
    assert.equal(typeof experience.latencyMs, 'number');
    assert.ok(experience.latencyMs >= 0);
    assert.equal(experience.costEstimate, null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('assembleExperience on a bare chain (just a trigger event, nothing else) still returns every field, with unpopulated fields explicitly null', () => {
  const dataDir = makeTempDataDir();
  try {
    const correlationId = 'phase9-bare';
    appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'discovery.scheduled',
      subject: { type: 'research-topic', id: 'x' },
      payload: { topic: 'x' },
      correlationId
    });

    const experience = assembleExperience(dataDir, correlationId);
    assert.equal(experience.proposal, null);
    assert.equal(experience.decision, null);
    assert.equal(experience.action, null);
    assert.equal(experience.outcome, null);
    assert.equal(experience.latencyMs, null);
    assert.equal(experience.role, null);
    assert.equal(experience.model, null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('outcomes record against a real chain from Phase 7 (a sent outreach) correctly appends an outcome event, reflected in reconstructChain regardless of which surface recorded it', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE9_WEB_USER', authPassEnvVar: 'PHASE9_WEB_PASS', port: 3999 }
  });
  process.env.PHASE9_WEB_USER = 'chris';
  process.env.PHASE9_WEB_PASS = 'secret';

  const { executor } = (() => {
    let calls = 0;
    const fn = async (proposal) => {
      assertProposalAuthorized(proposal, 'send-outreach');
      calls += 1;
      return { fired: true };
    };
    return { executor: fn, callCount: () => calls };
  })();
  registerActionExecutor('send-outreach', executor);

  let server;
  try {
    const { correlationId } = seedFullChain(instance.dataDir, { opportunityId: 'opp-cli-outcome', correlationId: 'phase9-cli-outcome' });

    // Record via the CLI.
    const cliOutput = runCli([
      'outcomes',
      'record',
      '--correlation',
      correlationId,
      '--type',
      'meeting.booked',
      '--payload',
      JSON.stringify({ with: 'prospect@example.com' }),
      '--instance',
      instance.name
    ]);
    assert.match(cliOutput, /Recorded outcome/);

    // Record a second, different outcome via the web UI, same correlationId.
    const listener = createRequestListener({ config: instance.config, dataDir: instance.dataDir });
    server = http.createServer(listener);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const auth = `Basic ${Buffer.from('chris:secret').toString('base64')}`;

    function request(urlPath, opts = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}${urlPath}`,
          { method: opts.method ?? 'GET', headers: { Authorization: auth, ...(opts.headers ?? {}) } },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          }
        );
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
      });
    }

    const getRes = await request('/opportunities/opp-cli-outcome');
    const cookieToken = (getRes.headers['set-cookie'] ?? []).join(';').match(/e3d_csrf=([0-9a-f]+)/)[1];
    const formToken = getRes.body.match(/name="_csrf" value="([0-9a-f]+)"/)[1];

    const body = new URLSearchParams({ type: 'deal.won', payload: JSON.stringify({ amount: 900 }), _csrf: formToken }).toString();
    const postRes = await request('/opportunities/opp-cli-outcome/outcomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Cookie: `e3d_csrf=${cookieToken}` },
      body
    });
    assert.equal(postRes.statusCode, 200);
    assert.match(postRes.body, /Recorded outcome/);

    const chain = queryEvents(instance.dataDir, { correlationId });
    const types = chain.map((e) => e.type);
    assert.ok(types.includes('meeting.booked'));
    assert.ok(types.includes('deal.won'));

    const experienceRes = await request('/opportunities/opp-cli-outcome/experience');
    assert.equal(experienceRes.statusCode, 200);
    assert.match(experienceRes.body, /deal\.won/);

    const outcomesListRes = await request('/outcomes');
    assert.equal(outcomesListRes.statusCode, 200);
    assert.match(outcomesListRes.body, /meeting\.booked/);
    assert.match(outcomesListRes.body, /deal\.won/);
  } finally {
    if (server) server.close();
    clearActionExecutor('send-outreach');
    delete process.env.PHASE9_WEB_USER;
    delete process.env.PHASE9_WEB_PASS;
    cleanupTempInstance(instance);
  }
});

test('CLI: experience show renders a full experience record', () => {
  const instance = makeTempInstance();
  try {
    const { correlationId } = seedFullChain(instance.dataDir, { opportunityId: 'opp-exp-show', correlationId: 'phase9-exp-show' });
    recordOutcome(instance.dataDir, { correlationId, type: 'deal.won', payload: { amount: 100 } });

    const output = runCli(['experience', 'show', correlationId, '--instance', instance.name]);
    assert.match(output, new RegExp(correlationId));
    assert.match(output, /outcome:\s+deal\.won/);
    assert.match(output, /role:\s+opportunity\.communicator/);
  } finally {
    cleanupTempInstance(instance);
  }
});
