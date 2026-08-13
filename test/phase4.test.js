import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createResearchAdapter } from '../lib/research/adapter.js';
import { loadInstanceConfig, validateInstanceConfig } from '../lib/config.js';
import { runOpportunityEngine, runDiscoveryPass } from '../lib/opportunities/engine.js';
import { listOpportunities, getOpportunity } from '../lib/opportunities/store.js';
import { scoreOpportunity, recencyFactor } from '../lib/opportunities/scoring.js';
import { parseCandidateJson } from '../lib/roles/opportunityProspect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-opps-'));
}

function minimalInstanceConfig(overrides = {}) {
  return {
    name: 'phase4-test',
    llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
    research: { futcoMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
    ...overrides
  };
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeTempInstance(extra = {}) {
  const name = `phase4-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify(
      {
        name,
        dataDir,
        llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
        research: { futcoMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
        eventSources: [],
        roles: { 'opportunity.prospect': { provider: 'local', model: '$LLM_MODEL' } },
        ...extra
      },
      null,
      2
    )
  );
  return { name, instanceDir, dataDir: path.join(ROOT, dataDir) };
}

function cleanupTempInstance(instanceDir) {
  fs.rmSync(instanceDir, { recursive: true, force: true });
}

function stubLlmClientReturning(candidate) {
  return async () => (typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
}

function validCandidate(overrides = {}) {
  return {
    type: 'consulting-engagement',
    title: 'Help Acme Corp adopt an AI intake workflow',
    description: 'Acme asked about automating their support-ticket triage; FutCo consulting fits.',
    confidence: 0.75,
    rationale: 'Direct inbound request matching FutCo\'s AI consulting focus.',
    evidenceEventIds: [],
    ...overrides
  };
}

test('runOpportunityEngine produces a correctly-typed opportunity and a traceable event chain from a stubbed LLM', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-1' },
      payload: { note: 'Acme Corp wants help with support triage' },
      correlationId: 'phase4-chain-1'
    });

    const { opportunity, createdEvent, scoredEvent } = await runOpportunityEngine({
      instanceConfig: minimalInstanceConfig(),
      dataDir,
      triggerEvent: trigger,
      llmClient: stubLlmClientReturning(validCandidate())
    });

    assert.equal(opportunity.type, 'consulting-engagement');
    assert.equal(opportunity.title, validCandidate().title);
    assert.equal(opportunity.status, 'scored');
    assert.equal(typeof opportunity.score.value, 'number');
    assert.equal(typeof opportunity.score.rationale, 'string');
    assert.equal(opportunity.correlationId, trigger.correlationId);
    assert.ok(opportunity.sourceEventIds.includes(trigger.id));

    assert.equal(createdEvent.type, 'opportunity.created');
    assert.equal(createdEvent.causationId, trigger.id);
    assert.equal(createdEvent.correlationId, trigger.correlationId);
    assert.equal(createdEvent.subject.id, opportunity.id);

    assert.equal(scoredEvent.type, 'opportunity.scored');
    assert.equal(scoredEvent.causationId, createdEvent.id);
    assert.equal(scoredEvent.correlationId, trigger.correlationId);
    assert.equal(scoredEvent.payload.status, 'scored');

    const stored = getOpportunity(dataDir, opportunity.id);
    assert.equal(stored.status, 'scored');
    assert.equal(stored.score.value, opportunity.score.value);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('malformed role output (invalid JSON) is rejected and appends no opportunity.created event', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-2' },
      payload: { note: 'garbled response test' },
      correlationId: 'phase4-chain-2'
    });

    await assert.rejects(
      runOpportunityEngine({
        instanceConfig: minimalInstanceConfig(),
        dataDir,
        triggerEvent: trigger,
        llmClient: stubLlmClientReturning('this is not json')
      }),
      /invalid JSON/
    );

    assert.equal(queryEvents(dataDir, { type: 'opportunity.created' }).length, 0);
    assert.equal(queryEvents(dataDir, { type: 'opportunity.scored' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('malformed role output (missing required fields) is rejected and appends no opportunity.created event', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-3' },
      payload: { note: 'incomplete response test' },
      correlationId: 'phase4-chain-3'
    });

    await assert.rejects(
      runOpportunityEngine({
        instanceConfig: minimalInstanceConfig(),
        dataDir,
        triggerEvent: trigger,
        llmClient: stubLlmClientReturning({ title: 'missing everything else' })
      }),
      /Invalid opportunity candidate/
    );

    assert.equal(queryEvents(dataDir, { type: 'opportunity.created' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parseCandidateJson strips a markdown fence but still rejects genuinely broken JSON', () => {
  const candidate = validCandidate();
  const fenced = '```json\n' + JSON.stringify(candidate) + '\n```';
  assert.deepEqual(parseCandidateJson(fenced), candidate);
  assert.throws(() => parseCandidateJson('```\nnot json\n```'), /invalid JSON/);
  assert.throws(() => parseCandidateJson(''), /empty output/);
});

test('scoreOpportunity is a deterministic, documented combination of confidence/evidence/recency/type weight', () => {
  const now = Date.parse('2026-08-13T00:00:00.000Z');

  const fresh = scoreOpportunity({
    confidence: 1,
    evidenceCount: 5,
    triggerOccurredAt: new Date(now).toISOString(),
    type: 'consulting-engagement',
    typeWeights: { 'consulting-engagement': 1.5 },
    now
  });
  assert.equal(fresh.value, 1.5);

  const stale = scoreOpportunity({
    confidence: 1,
    evidenceCount: 5,
    triggerOccurredAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    type: 'consulting-engagement',
    typeWeights: { 'consulting-engagement': 1.5 },
    now
  });
  assert.ok(stale.value < fresh.value);

  const noEvidence = scoreOpportunity({
    confidence: 1,
    evidenceCount: 0,
    triggerOccurredAt: new Date(now).toISOString(),
    type: 'other',
    now
  });
  assert.ok(noEvidence.value < 1);
  assert.equal(recencyFactor(new Date(now).toISOString(), now), 1);
  assert.equal(recencyFactor(new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(), now), 0);
});

test('runDiscoveryPass processes each research topic independently and tolerates a per-topic failure', async () => {
  const dataDir = makeTempDataDir();
  try {
    const instanceConfig = minimalInstanceConfig({
      researchTopics: ['topic-a-good', 'topic-b-bad']
    });

    const researchAdapter = {
      async webSearch(query, { causationId, correlationId } = {}) {
        return appendEvent(dataDir, {
          type: 'evidence.gathered',
          source: 'test.stub.webSearch',
          subject: { type: 'research', id: crypto.randomUUID() },
          payload: { kind: 'web-search', query, resultSummary: `stub web results for ${query}`, degraded: false },
          causationId: causationId ?? null,
          correlationId
        });
      },
      async searchKnowledgeBase(query, { causationId, correlationId } = {}) {
        return appendEvent(dataDir, {
          type: 'evidence.gathered',
          source: 'test.stub.kb',
          subject: { type: 'research', id: crypto.randomUUID() },
          payload: { kind: 'knowledge-base-search', query, resultSummary: `stub kb results for ${query}`, degraded: false },
          causationId: causationId ?? null,
          correlationId
        });
      }
    };

    const llmClient = async ({ userPrompt }) => {
      const { triggerEvent } = JSON.parse(userPrompt);
      if (triggerEvent.payload.topic === 'topic-b-bad') {
        return 'not valid json';
      }
      return JSON.stringify(validCandidate({ type: 'market-trend', title: `Trend for ${triggerEvent.payload.topic}` }));
    };

    const results = await runDiscoveryPass({ instanceConfig, dataDir, researchAdapter, llmClient });

    assert.equal(results.length, 2);
    const good = results.find((r) => r.topic === 'topic-a-good');
    const bad = results.find((r) => r.topic === 'topic-b-bad');

    assert.equal(good.error, undefined);
    assert.equal(good.opportunity.type, 'market-trend');
    assert.match(bad.error, /invalid JSON/);

    const scored = listOpportunities(dataDir, { status: 'scored' });
    assert.equal(scored.length, 1);
    assert.equal(scored[0].title, 'Trend for topic-a-good');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('opportunity engine grounds candidates in real futco-mcp evidence with correct causation/correlation', async () => {
  const { instanceDir, dataDir } = makeTempInstance();
  try {
    const config = loadInstanceConfig(path.join(instanceDir, 'instance.json'));
    const researchAdapter = createResearchAdapter(config, { dataDir });

    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-real-kb' },
      payload: { note: 'e3d-pilot' },
      correlationId: 'phase4-real-kb-chain'
    });

    const { opportunity, createdEvent } = await runOpportunityEngine({
      instanceConfig: config,
      dataDir,
      triggerEvent: trigger,
      researchAdapter,
      researchQuery: 'e3d-pilot',
      llmClient: stubLlmClientReturning(
        validCandidate({ type: 'product-opportunity', title: 'Package e3d-pilot output for FutCo clients' })
      )
    });

    assert.equal(opportunity.type, 'product-opportunity');
    assert.equal(createdEvent.causationId, trigger.id);

    const evidenceEvents = queryEvents(dataDir, { type: 'evidence.gathered', correlationId: trigger.correlationId });
    assert.ok(evidenceEvents.length > 0);
    assert.equal(evidenceEvents[0].payload.kind, 'knowledge-base-search');
    assert.ok(opportunity.sourceEventIds.includes(evidenceEvents[0].id));
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

test('opportunities list and show CLI commands render ranked opportunities and their causal chain', () => {
  const { name, instanceDir, dataDir } = makeTempInstance();
  try {
    const triggerA = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-cli-a' },
      payload: {},
      correlationId: 'phase4-cli-chain-a'
    });
    const createdA = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-cli-a' },
      payload: {
        id: 'opp-cli-a',
        type: 'consulting-engagement',
        title: 'High score opportunity',
        description: 'desc a',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [triggerA.id],
        correlationId: triggerA.correlationId,
        createdAt: triggerA.occurredAt
      },
      causationId: triggerA.id,
      correlationId: triggerA.correlationId
    });
    appendEvent(dataDir, {
      type: 'opportunity.scored',
      source: 'opportunity.engine',
      subject: { type: 'opportunity', id: 'opp-cli-a' },
      payload: { id: 'opp-cli-a', score: { value: 0.9, rationale: 'high' }, status: 'scored' },
      causationId: createdA.id,
      correlationId: triggerA.correlationId
    });

    const triggerB = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-cli-b' },
      payload: {},
      correlationId: 'phase4-cli-chain-b'
    });
    const createdB = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-cli-b' },
      payload: {
        id: 'opp-cli-b',
        type: 'market-trend',
        title: 'Low score opportunity',
        description: 'desc b',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [triggerB.id],
        correlationId: triggerB.correlationId,
        createdAt: triggerB.occurredAt
      },
      causationId: triggerB.id,
      correlationId: triggerB.correlationId
    });
    appendEvent(dataDir, {
      type: 'opportunity.scored',
      source: 'opportunity.engine',
      subject: { type: 'opportunity', id: 'opp-cli-b' },
      payload: { id: 'opp-cli-b', score: { value: 0.2, rationale: 'low' }, status: 'scored' },
      causationId: createdB.id,
      correlationId: triggerB.correlationId
    });

    const listOutput = runCli(['opportunities', 'list', '--instance', name]);
    const lines = listOutput.trim().split('\n');
    assert.ok(lines[0].includes('opp-cli-a'));
    assert.ok(lines[1].includes('opp-cli-b'));

    const filteredOutput = runCli(['opportunities', 'list', '--instance', name, '--min-score', '0.5']);
    assert.match(filteredOutput, /opp-cli-a/);
    assert.doesNotMatch(filteredOutput, /opp-cli-b/);

    const showOutput = runCli(['opportunities', 'show', 'opp-cli-a', '--instance', name]);
    assert.match(showOutput, /Opportunity opp-cli-a/);
    assert.match(showOutput, /High score opportunity/);
    assert.match(showOutput, /score:\s+0\.9/);
    assert.match(showOutput, /causal chain/);
    assert.match(showOutput, new RegExp(triggerA.id));
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

test('opportunities show reports a clear error for an unknown id', () => {
  const { name, instanceDir } = makeTempInstance();
  try {
    assert.throws(
      () => runCli(['opportunities', 'show', 'does-not-exist', '--instance', name]),
      (error) => {
        assert.match(error.stderr.toString(), /Opportunity not found: does-not-exist/);
        return true;
      }
    );
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

test('instance config validation accepts researchTopics/scoring and rejects malformed values', () => {
  const valid = minimalInstanceConfig({
    name: 'valid',
    dataDir: '.e3d-corp/instance/valid',
    eventSources: [],
    roles: {},
    researchTopics: ['AI utilities for technical businesses'],
    scoring: { weights: { confidence: 0.6, evidenceCount: 0.25, recency: 0.15 }, typeWeights: { 'consulting-engagement': 1.2 } }
  });
  assert.equal(validateInstanceConfig(valid).valid, true);

  const badTopics = { ...valid, researchTopics: 'not-an-array' };
  const badTopicsResult = validateInstanceConfig(badTopics);
  assert.equal(badTopicsResult.valid, false);
  assert.ok(badTopicsResult.errors.some((e) => e.startsWith('researchTopics:')));

  const badWeight = { ...valid, scoring: { weights: { confidence: 'high' } } };
  const badWeightResult = validateInstanceConfig(badWeight);
  assert.equal(badWeightResult.valid, false);
  assert.ok(badWeightResult.errors.some((e) => e.startsWith('scoring.weights.confidence:')));
});

test('futco instance config declares the opportunity.prospect role and real research topics', () => {
  const config = loadInstanceConfig(path.join(ROOT, '.e3d-corp', 'instance', 'futco', 'instance.json'));
  assert.deepEqual(config.roles['opportunity.prospect'], { provider: 'local', model: '$LLM_MODEL' });
  assert.ok(Array.isArray(config.researchTopics) && config.researchTopics.length > 0);
});
