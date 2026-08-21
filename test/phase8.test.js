import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createProposal } from '../lib/proposals/create.js';
import { getProposal } from '../lib/proposals/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { createResearchAdapter } from '../lib/research/adapter.js';
import { loadInstance } from '../lib/config.js';
import { writeHandoffArtifact } from '../lib/pilot/handoffArtifact.js';
import { proposePilotHandoff } from '../lib/proposals/pilotHandoff.js';
import { pilotHandoff } from '../lib/actions/pilotHandoff.js';
import { checkCapabilityShipped } from '../lib/pilot/checkShipped.js';
import { createRequestListener } from '../lib/web/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilot-'));
}

function makeTempTargetRepo(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilot-target-'));
  fs.mkdirSync(path.join(dir, '.e3d-pilot'), { recursive: true });
  const config = {
    verify: [],
    protected_paths: [],
    research_topics: 'existing hint',
    pr: { base_branch: 'main', draft: true, labels: [], backend: 'local' },
    providers: { discover: 'claude', ideate: 'claude', draft: 'codex', negotiate: ['claude', 'codex'], review: 'claude' },
    max_diff_files: 25,
    max_diff_lines: 600,
    ...overrides
  };
  fs.writeFileSync(path.join(dir, '.e3d-pilot', 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

function makeTempInstance(extra = {}) {
  const name = `phase8-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  const config = {
    name,
    dataDir,
    llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
    research: {
      knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
      knowledgeBaseMcpServerPath: '../futco-mcp/server.js',
      webSearchProvider: 'disabled'
    },
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

function proposedBy(overrides = {}) {
  return { role: 'operator', provider: 'human', model: 'n/a', ...overrides };
}

function seedPursuingProductOpportunity(dataDir, { opportunityId = 'opp-pilot' } = {}) {
  const correlationId = `phase8-${opportunityId}`;
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
      title: 'A self-serve export feature',
      description: 'Customers keep asking for CSV export in the reporting dashboard.',
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
    type: 'opportunity.scored',
    source: 'opportunity.engine',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { id: opportunityId, score: { value: 0.7, rationale: 'clear demand' }, status: 'scored' },
    causationId: created.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth building', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });

  return {
    correlationId,
    opportunity: {
      id: opportunityId,
      type: 'product-opportunity',
      title: 'A self-serve export feature',
      description: 'Customers keep asking for CSV export in the reporting dashboard.',
      status: 'pursuing',
      score: { value: 0.7, rationale: 'clear demand' },
      correlationId
    }
  };
}

test('writeHandoffArtifact appends research_topics (idempotently) and writes an audit file', () => {
  const targetRepo = makeTempTargetRepo();
  try {
    const { opportunity } = { opportunity: {
      id: 'opp-artifact',
      title: 'Self-serve CSV export',
      description: 'Customers keep asking for CSV export.',
      type: 'product-opportunity',
      score: { value: 0.7, rationale: 'clear demand' },
      correlationId: 'phase8-artifact-chain'
    } };
    const chain = [{ id: 'e1', type: 'opportunity.created', occurredAt: '2026-01-01T00:00:00.000Z', causationId: null }];

    const first = writeHandoffArtifact({ targetRepoPath: targetRepo, opportunity, chain, reason: 'clear demand signal' });
    assert.equal(first.researchTopicsUpdated, true);
    assert.ok(fs.existsSync(first.auditPath));

    const configAfterFirst = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    assert.ok(configAfterFirst.research_topics.includes('existing hint'));
    assert.ok(configAfterFirst.research_topics.includes('Self-serve CSV export'));
    assert.equal(typeof configAfterFirst.research_topics, 'string');

    const auditContent = fs.readFileSync(first.auditPath, 'utf8');
    assert.ok(auditContent.includes('opp-artifact'));
    assert.ok(auditContent.includes('clear demand signal'));
    assert.ok(auditContent.includes('opportunity.created'));

    // Re-running the same handoff does not grow research_topics unboundedly.
    const second = writeHandoffArtifact({ targetRepoPath: targetRepo, opportunity, chain, reason: 'clear demand signal' });
    assert.equal(second.researchTopicsUpdated, false);
    const configAfterSecond = JSON.parse(fs.readFileSync(second.configPath, 'utf8'));
    assert.equal(configAfterSecond.research_topics, configAfterFirst.research_topics);
  } finally {
    fs.rmSync(targetRepo, { recursive: true, force: true });
  }
});

test('writeHandoffArtifact refuses when the target repo has no .e3d-pilot/config.json', () => {
  const targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilot-noconfig-'));
  try {
    assert.throws(
      () =>
        writeHandoffArtifact({
          targetRepoPath: targetRepo,
          opportunity: { id: 'x', title: 't', description: 'd', type: 'product-opportunity', correlationId: 'c' },
          chain: [],
          reason: 'r'
        }),
      /No \.e3d-pilot\/config\.json found/
    );
  } finally {
    fs.rmSync(targetRepo, { recursive: true, force: true });
  }
});

test('proposePilotHandoff requires a "pursuing" opportunity and derives authorityLevel 2 from the policy table', () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir);

    assert.throws(
      () =>
        proposePilotHandoff(dataDir, {
          opportunity: { ...opportunity, status: 'scored' },
          targetRepo: '/tmp/whatever',
          reason: 'test'
        }),
      /not "pursuing"/
    );

    const { proposal, event } = proposePilotHandoff(dataDir, {
      opportunity,
      targetRepo: '/tmp/whatever',
      reason: 'Clear customer demand'
    });

    assert.equal(proposal.type, 'pilot-handoff');
    assert.equal(proposal.authorityLevel, 2);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.opportunityId, opportunity.id);
    assert.equal(proposal.payload.targetRepo, '/tmp/whatever');
    assert.equal(event.correlationId, opportunity.correlationId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('pilotHandoff refuses a non-approved proposal, and against an approved one writes the artifact and emits pilot-handoff.created', async () => {
  const dataDir = makeTempDataDir();
  const targetRepo = makeTempTargetRepo();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir, { opportunityId: 'opp-exec' });
    const { proposal } = proposePilotHandoff(dataDir, { opportunity, targetRepo, reason: 'Clear demand' });

    await assert.rejects(pilotHandoff(proposal, { dataDir }), /not approved \(status: pending\)/);

    const approvalEvent = appendEvent(dataDir, {
      type: 'proposal.approved',
      source: 'decision:cli',
      subject: { type: 'proposal', id: proposal.id },
      payload: { decision: 'approved' },
      causationId: null,
      correlationId: proposal.correlationId
    });

    const approved = { ...proposal, status: 'approved' };
    const result = await pilotHandoff(approved, {
      dataDir,
      causationId: approvalEvent.id,
      correlationId: proposal.correlationId
    });

    assert.equal(result.handedOff, true);
    assert.ok(fs.existsSync(result.auditPath));
    assert.equal(result.event.type, 'pilot-handoff.created');
    assert.equal(result.event.causationId, approvalEvent.id);
    assert.equal(result.event.correlationId, opportunity.correlationId);
    assert.equal(result.event.payload.opportunityId, 'opp-exec');

    const events = queryEvents(dataDir, { type: 'pilot-handoff.created' });
    assert.equal(events.length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(targetRepo, { recursive: true, force: true });
  }
});

test('checkCapabilityShipped appends capability.shipped for a plausibly-related repo, and reports no match without a false event', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir, { opportunityId: 'opp-shipped' });
    const handoffEvent = appendEvent(dataDir, {
      type: 'pilot-handoff.created',
      source: 'action:pilot-handoff',
      subject: { type: 'proposal', id: 'proposal-shipped' },
      payload: { opportunityId: 'opp-shipped', targetRepo: '/tmp/x' },
      causationId: null,
      correlationId: opportunity.correlationId
    });

    const matchResult = await checkCapabilityShipped({
      dataDir,
      opportunityId: 'opp-shipped',
      listRepos: async () => ({
        status: 'ok',
        repos: [
          { name: 'unrelated-repo', one_liner: 'A completely different tool for something else' },
          { name: 'reporting-exports', one_liner: 'Adds self-serve CSV export to the reporting dashboard' }
        ]
      })
    });

    assert.equal(matchResult.matched, true);
    assert.equal(matchResult.repo.name, 'reporting-exports');
    assert.equal(matchResult.event.type, 'capability.shipped');
    assert.equal(matchResult.event.causationId, handoffEvent.id);
    assert.equal(matchResult.event.correlationId, opportunity.correlationId);
    assert.equal(queryEvents(dataDir, { type: 'capability.shipped' }).length, 1);

    const noMatchResult = await checkCapabilityShipped({
      dataDir,
      opportunityId: 'opp-shipped',
      listRepos: async () => ({ status: 'ok', repos: [{ name: 'unrelated-repo', one_liner: 'Nothing relevant here' }] })
    });
    assert.equal(noMatchResult.matched, false);
    // Still only the one real event from the match above - no false event appended.
    assert.equal(queryEvents(dataDir, { type: 'capability.shipped' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('checkCapabilityShipped refuses when no pilot-handoff.created event exists yet for the opportunity', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingProductOpportunity(dataDir, { opportunityId: 'opp-no-handoff' });
    await assert.rejects(
      checkCapabilityShipped({ dataDir, opportunityId: opportunity.id, listRepos: async () => ({ status: 'ok', repos: [] }) }),
      /no pilot-handoff\.created event yet/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('knowledge-base listRepos: real integration returns real repos and records evidence', async () => {
  const { name, dataDir } = makeTempInstance();
  const instance = { instanceDir: path.join(ROOT, '.e3d-corp', 'instance', name), name };
  try {
    const { config } = loadInstance(name);
    const adapter = createResearchAdapter(config, { dataDir });
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-listrepos' },
      payload: {},
      correlationId: 'phase8-listrepos-chain'
    });

    const result = await adapter.listRepos({ causationId: trigger.id, correlationId: trigger.correlationId });

    assert.equal(result.status, 'ok');
    assert.ok(Array.isArray(result.repos));
    assert.ok(result.repos.length > 0);
    assert.ok(result.repos.some((repo) => repo.name === 'e3d-pilot' || repo.name === 'e3d-corp'));

    const evidenceEvents = queryEvents(dataDir, { type: 'evidence.gathered', correlationId: trigger.correlationId });
    assert.equal(evidenceEvents.length, 1);
    assert.equal(evidenceEvents[0].payload.kind, 'list-repos');
  } finally {
    fs.rmSync(instance.instanceDir, { recursive: true, force: true });
  }
});

test('a hand-crafted product-opportunity marked pursuing: proposing and approving a pilot-handoff via the web UI produces a well-formed artifact and pilot-handoff.created with correct correlationId', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE8_WEB_USER', authPassEnvVar: 'PHASE8_WEB_PASS', port: 3999 }
  });
  process.env.PHASE8_WEB_USER = 'chris';
  process.env.PHASE8_WEB_PASS = 'secret';
  const targetRepo = makeTempTargetRepo();
  registerActionExecutor('pilot-handoff', pilotHandoff);
  let server;
  try {
    const { opportunity } = seedPursuingProductOpportunity(instance.dataDir, { opportunityId: 'opp-web-handoff' });

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

    const getRes = await request(`/opportunities/${opportunity.id}`);
    const cookieMatch = (getRes.headers['set-cookie'] ?? []).join(';').match(/e3d_csrf=([0-9a-f]+)/);
    const fieldMatch = getRes.body.match(/name="_csrf" value="([0-9a-f]+)"/);
    const csrfToken = cookieMatch[1];
    assert.equal(fieldMatch[1], csrfToken);

    const proposeBody = new URLSearchParams({ repo: targetRepo, reason: 'Clear customer demand', _csrf: csrfToken }).toString();
    const proposeRes = await request(`/opportunities/${opportunity.id}/propose-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(proposeBody), Cookie: `e3d_csrf=${csrfToken}` },
      body: proposeBody
    });
    assert.equal(proposeRes.statusCode, 200);
    assert.match(proposeRes.body, /Proposed pilot-handoff/);
    const proposalIdMatch = proposeRes.body.match(/Proposed pilot-handoff ([0-9a-f-]+)/);
    const proposalId = proposalIdMatch[1];

    const proposalGetRes = await request(`/proposals/${proposalId}`);
    const approveCookieMatch = (proposalGetRes.headers['set-cookie'] ?? []).join(';').match(/e3d_csrf=([0-9a-f]+)/);
    const approveFieldMatch = proposalGetRes.body.match(/name="_csrf" value="([0-9a-f]+)"/);
    const approveCsrf = approveCookieMatch ? approveCookieMatch[1] : csrfToken;
    assert.equal(approveFieldMatch[1], approveCsrf);

    const approveBody = new URLSearchParams({ reason: 'Go build it', _csrf: approveCsrf }).toString();
    const approveRes = await request(`/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(approveBody), Cookie: `e3d_csrf=${approveCsrf}` },
      body: approveBody
    });
    assert.equal(approveRes.statusCode, 200);
    assert.match(approveRes.body, /Action executed/);
    assert.equal(getProposal(instance.dataDir, proposalId).status, 'approved');

    const events = queryEvents(instance.dataDir, { type: 'pilot-handoff.created' });
    assert.equal(events.length, 1);
    assert.equal(events[0].correlationId, opportunity.correlationId);
    assert.ok(fs.existsSync(events[0].payload.auditPath));

    const config = JSON.parse(fs.readFileSync(path.join(targetRepo, '.e3d-pilot', 'config.json'), 'utf8'));
    assert.ok(config.research_topics.includes('A self-serve export feature'));
  } finally {
    if (server) server.close();
    clearActionExecutor('pilot-handoff');
    delete process.env.PHASE8_WEB_USER;
    delete process.env.PHASE8_WEB_PASS;
    cleanupTempInstance(instance);
    fs.rmSync(targetRepo, { recursive: true, force: true });
  }
});
