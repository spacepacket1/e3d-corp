import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { reconstructChain } from '../lib/events/chain.js';
import { createResearchAdapter } from '../lib/research/adapter.js';
import { loadInstanceConfig, validateInstanceConfig } from '../lib/config.js';
import { runOpportunityEngine, runDiscoveryPass } from '../lib/opportunities/engine.js';
import { normalizeOpportunityCandidate } from '../lib/opportunities/schema.js';
import { listOpportunities, getOpportunity } from '../lib/opportunities/store.js';
import { scoreOpportunity, recencyFactor } from '../lib/opportunities/scoring.js';
import { buildPrompt, parseCandidateJson } from '../lib/roles/opportunityProspect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');
const ORIGINAL_ENV = {
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_MODEL_A: process.env.LLM_MODEL_A,
  LLM_MODEL_B: process.env.LLM_MODEL_B,
  LLM_MODEL_C: process.env.LLM_MODEL_C,
  LLM_MODEL_BAD: process.env.LLM_MODEL_BAD,
  LLM_MODEL_SLOW: process.env.LLM_MODEL_SLOW
};

process.env.LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.LLM_MODEL = process.env.LLM_MODEL ?? 'test-local-model';
process.env.LLM_MODEL_A = process.env.LLM_MODEL_A ?? 'test-model-a';
process.env.LLM_MODEL_B = process.env.LLM_MODEL_B ?? 'test-model-b';
process.env.LLM_MODEL_C = process.env.LLM_MODEL_C ?? 'test-model-c';
process.env.LLM_MODEL_BAD = process.env.LLM_MODEL_BAD ?? 'test-model-bad';
process.env.LLM_MODEL_SLOW = process.env.LLM_MODEL_SLOW ?? 'test-model-slow';

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-opps-'));
}

function minimalInstanceConfig(overrides = {}) {
  return {
    name: 'phase4-test',
    llm: {
      providers: {
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      }
    },
    research: {
      knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
      knowledgeBaseMcpServerPath: '../futco-mcp/server.js',
      webSearchProvider: 'disabled'
    },
    roles: { 'opportunity.prospect': { provider: 'local' } },
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
        llm: {
          providers: {
            local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
          }
        },
        research: {
      knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
      knowledgeBaseMcpServerPath: '../futco-mcp/server.js',
      webSearchProvider: 'disabled'
    },
        eventSources: [],
        roles: { 'opportunity.prospect': { provider: 'local' } },
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

function llmResponse(text, overrides = {}) {
  return {
    text,
    usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    costUsd: null,
    ...overrides
  };
}

function stubLlmClientReturning(candidate) {
  return async () => llmResponse(typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
}

function validCandidate(overrides = {}) {
  return {
    type: 'consulting-engagement',
    title: 'Help Acme Corp adopt an AI intake workflow',
    description: 'Acme asked about automating their support-ticket triage; FutCo consulting fits.',
    confidence: 0.75,
    rationale: 'Direct inbound request matching FutCo\'s AI consulting focus.',
    evidenceEventIds: [],
    counterparty: {
      kind: 'company',
      name: 'Acme Corp',
      contactHint: 'Contact the operations lead from the inbound request'
    },
    ...overrides
  };
}

function multiProviderInstanceConfig(provider, extra = {}) {
  const { llm: extraLlm = {}, ...rest } = extra;
  return minimalInstanceConfig({
    llm: {
      providers: {
        alpha: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL_A', timeoutMs: 50 },
        beta: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL_B', timeoutMs: 50 },
        gamma: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL_C', timeoutMs: 50 },
        bad: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL_BAD', timeoutMs: 50 },
        slow: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL_SLOW', timeoutMs: 5 }
      },
      ...extraLlm
    },
    roles: { 'opportunity.prospect': { provider } },
    ...rest
  });
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

    const { opportunities, createdEvents, scoredEvents } = await runOpportunityEngine({
      instanceConfig: minimalInstanceConfig({ roles: { 'opportunity.prospect': { provider: 'local' } } }),
      dataDir,
      triggerEvent: trigger,
      llmClient: stubLlmClientReturning(validCandidate())
    });
    const [opportunity] = opportunities;
    const [createdEvent] = createdEvents;
    const [scoredEvent] = scoredEvents;

    assert.equal(opportunity.type, 'consulting-engagement');
    assert.equal(opportunity.title, validCandidate().title);
    assert.equal(opportunity.status, 'scored');
    assert.equal(typeof opportunity.score.value, 'number');
    assert.equal(typeof opportunity.score.rationale, 'string');
    assert.equal(opportunity.correlationId, trigger.correlationId);
    assert.equal(opportunity.pursuable, true);
    assert.ok(opportunity.sourceEventIds.includes(trigger.id));
    assert.deepEqual(opportunity.counterparty, validCandidate().counterparty);
    assert.deepEqual(opportunity.proposedBy, {
      role: 'opportunity.prospect',
      provider: 'local',
      model: process.env.LLM_MODEL
    });

    const providerEvents = queryEvents(dataDir, { type: 'role.provider.completed', correlationId: trigger.correlationId });
    assert.equal(providerEvents.length, 1);
    assert.equal(providerEvents[0].payload.provider, 'local');
    assert.equal(providerEvents[0].payload.model, process.env.LLM_MODEL);
    assert.deepEqual(providerEvents[0].payload.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    assert.equal(providerEvents[0].payload.costUsd, null);
    assert.equal(typeof providerEvents[0].payload.latencyMs, 'number');

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
    assert.equal(stored.pursuable, true);
    assert.deepEqual(stored.counterparty, validCandidate().counterparty);
    assert.deepEqual(stored.proposedBy, opportunity.proposedBy);
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
        instanceConfig: minimalInstanceConfig({ roles: { 'opportunity.prospect': { provider: 'local' } } }),
        dataDir,
        triggerEvent: trigger,
        llmClient: stubLlmClientReturning('this is not json')
      }),
      /invalid JSON/
    );

    assert.equal(queryEvents(dataDir, { type: 'opportunity.created' }).length, 0);
    assert.equal(queryEvents(dataDir, { type: 'opportunity.scored' }).length, 0);
    const failures = queryEvents(dataDir, { type: 'role.provider.failed', correlationId: trigger.correlationId });
    const completions = queryEvents(dataDir, { type: 'role.provider.completed', correlationId: trigger.correlationId });
    assert.equal(completions.length, 1);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].payload.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
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
        instanceConfig: minimalInstanceConfig({ roles: { 'opportunity.prospect': { provider: 'local' } } }),
        dataDir,
        triggerEvent: trigger,
        llmClient: stubLlmClientReturning({ title: 'missing everything else' })
      }),
      /Invalid opportunity candidate/
    );

    assert.equal(queryEvents(dataDir, { type: 'opportunity.created' }).length, 0);
    const failures = queryEvents(dataDir, { type: 'role.provider.failed', correlationId: trigger.correlationId });
    const completions = queryEvents(dataDir, { type: 'role.provider.completed', correlationId: trigger.correlationId });
    assert.equal(completions.length, 1);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].payload.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
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

test('buildPrompt excludes own-domain evidence results before truncation and leaves non-URL items untouched', () => {
  const triggerEvent = {
    id: 'trigger-own-domain',
    type: 'market.signal.detected',
    occurredAt: '2026-08-25T12:00:00.000Z',
    source: 'manual',
    payload: { topic: 'distribution partners' }
  };
  const evidenceEvents = [
    {
      id: 'evidence-own-only',
      occurredAt: '2026-08-25T12:01:00.000Z',
      payload: {
        kind: 'web-search',
        query: 'distribution partners',
        resultSummary: 'own-domain-only',
        result: {
          results: [{ title: 'Own result', url: 'https://www.example.com/partners', snippet: 'own site result' }]
        }
      }
    },
    {
      id: 'evidence-mixed',
      occurredAt: '2026-08-25T12:02:00.000Z',
      payload: {
        kind: 'web-search',
        query: 'distribution partners',
        resultSummary: 'mixed',
        result: {
          results: [
            { title: 'Own root', url: 'https://example.com/root', snippet: 'own root' },
            { title: 'Own subdomain', url: 'https://news.example.com/post', snippet: 'own subdomain' },
            { title: 'Keep 1', url: 'https://partner-one.test/path', snippet: 'keep one' },
            { title: 'Keep 2', url: 'https://openai.com/channel', snippet: 'keep two' }
          ]
        }
      }
    },
    {
      id: 'evidence-pre-truncate',
      occurredAt: '2026-08-25T12:03:00.000Z',
      payload: {
        kind: 'web-search',
        query: 'distribution partners',
        resultSummary: 'pre-truncate',
        result: {
          results: [
            { title: 'Keep A', url: 'https://alpha.test/a', snippet: 'a' },
            { title: 'Keep B', url: 'https://beta.test/b', snippet: 'b' },
            { title: 'Own crowded slot', url: 'https://www.example.com/crowded', snippet: 'crowded' },
            { title: 'Keep C', url: 'https://gamma.test/c', snippet: 'c' },
            { title: 'Keep D', url: 'https://delta.test/d', snippet: 'd' },
            { title: 'Keep E', url: 'https://epsilon.test/e', snippet: 'e' }
          ]
        }
      }
    },
    {
      id: 'evidence-kb',
      occurredAt: '2026-08-25T12:04:00.000Z',
      payload: {
        kind: 'knowledge-base-search',
        query: 'distribution partners',
        resultSummary: 'kb',
        result: {
          results: [{ title: 'Internal note with no URL', snippet: 'keep this knowledge-base note' }]
        }
      }
    },
    {
      id: 'evidence-substring-no-match',
      occurredAt: '2026-08-25T12:05:00.000Z',
      payload: {
        kind: 'web-search',
        query: 'distribution partners',
        resultSummary: 'substring-no-match',
        result: {
          results: [{ title: 'Unrelated AI site', url: 'https://openai.com/platform', snippet: 'should stay' }]
        }
      }
    }
  ];

  const { userPrompt } = buildPrompt({
    triggerEvent,
    evidenceEvents,
    instanceConfig: { name: 'ExampleCo', ownDomains: ['example.com', 'ai'] }
  });
  const prompt = JSON.parse(userPrompt);

  assert.deepEqual(prompt.evidence[0].results, []);
  assert.deepEqual(
    prompt.evidence[1].results.map((result) => result.title),
    ['Keep 1', 'Keep 2']
  );
  assert.deepEqual(
    prompt.evidence[2].results.map((result) => result.title),
    ['Keep A', 'Keep B', 'Keep C', 'Keep D', 'Keep E']
  );
  assert.equal(prompt.evidence[3].results[0].title, 'Internal note with no URL');
  assert.equal(prompt.evidence[4].results[0].title, 'Unrelated AI site');
});

test('buildPrompt leaves evidence unchanged when ownDomains is omitted or empty and the prompt requires counterparty honesty', () => {
  const triggerEvent = {
    id: 'trigger-no-own-domains',
    type: 'market.signal.detected',
    occurredAt: '2026-08-25T13:00:00.000Z',
    source: 'manual',
    payload: { topic: 'integration partners' }
  };
  const evidenceEvents = [
    {
      id: 'evidence-no-own-domains',
      occurredAt: '2026-08-25T13:01:00.000Z',
      payload: {
        kind: 'web-search',
        query: 'integration partners',
        resultSummary: 'no-filter',
        result: {
          results: [{ title: 'Example site result', url: 'https://www.example.com/path', snippet: 'still present' }]
        }
      }
    }
  ];

  const noFieldPrompt = JSON.parse(buildPrompt({ triggerEvent, evidenceEvents, instanceConfig: { name: 'ExampleCo' } }).userPrompt);
  const emptyListPrompt = JSON.parse(
    buildPrompt({ triggerEvent, evidenceEvents, instanceConfig: { name: 'ExampleCo', ownDomains: [] } }).userPrompt
  );
  const { systemPrompt } = buildPrompt({
    triggerEvent,
    evidenceEvents,
    instanceConfig: { name: 'ExampleCo', ownDomains: [] }
  });

  assert.deepEqual(noFieldPrompt.evidence, emptyListPrompt.evidence);
  assert.equal(noFieldPrompt.evidence[0].results[0].title, 'Example site result');
  assert.match(systemPrompt, /"counterparty" is required on every response/);
  assert.match(systemPrompt, /share a name with one of ExampleCo's own products/i);
  assert.match(systemPrompt, /kind to "none"/i);
});

test('normalizeOpportunityCandidate enforces counterparty rules and preserves it on valid candidates', () => {
  assert.throws(
    () => normalizeOpportunityCandidate({ ...validCandidate(), counterparty: undefined }),
    /counterparty: must be an object/
  );
  assert.throws(
    () => normalizeOpportunityCandidate(validCandidate({ counterparty: { kind: 'unknown', name: 'Acme', contactHint: null } })),
    /counterparty\.kind/
  );
  assert.throws(
    () => normalizeOpportunityCandidate(validCandidate({ counterparty: { kind: 'none', name: 'Acme', contactHint: null } })),
    /counterparty\.name: must be null when counterparty\.kind is "none"/
  );
  assert.throws(
    () => normalizeOpportunityCandidate(validCandidate({ counterparty: { kind: 'company', name: null, contactHint: null } })),
    /counterparty\.name: must be a non-empty string when counterparty\.kind is "company" or "person"/
  );

  const normalized = normalizeOpportunityCandidate(
    validCandidate({ counterparty: { kind: 'person', name: 'Jane Doe', contactHint: 'CTO named in the article' } })
  );
  assert.deepEqual(normalized.counterparty, {
    kind: 'person',
    name: 'Jane Doe',
    contactHint: 'CTO named in the article'
  });
});

test('runOpportunityEngine stores counterparty and derives pursuable deterministically', async () => {
  const dataDir = makeTempDataDir();
  try {
    const nonPursuableTrigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-non-pursuable' },
      payload: { note: 'general market note' },
      correlationId: 'phase4-pursuable-none'
    });
    const { opportunities: noneOpportunities } = await runOpportunityEngine({
      instanceConfig: minimalInstanceConfig({ roles: { 'opportunity.prospect': { provider: 'local' } } }),
      dataDir,
      triggerEvent: nonPursuableTrigger,
      llmClient: stubLlmClientReturning(
        validCandidate({
          title: 'Named market note only',
          counterparty: { kind: 'none', name: null, contactHint: null }
        })
      )
    });

    assert.equal(noneOpportunities[0].pursuable, false);
    assert.deepEqual(noneOpportunities[0].counterparty, { kind: 'none', name: null, contactHint: null });
    assert.equal(getOpportunity(dataDir, noneOpportunities[0].id).pursuable, false);

    const pursuableTrigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-pursuable' },
      payload: { note: 'specific buyer signal' },
      correlationId: 'phase4-pursuable-company'
    });
    const companyCounterparty = {
      kind: 'company',
      name: 'BuyerCo',
      contactHint: 'VP Operations quoted in the evidence'
    };
    const { opportunities: companyOpportunities } = await runOpportunityEngine({
      instanceConfig: minimalInstanceConfig({ roles: { 'opportunity.prospect': { provider: 'local' } } }),
      dataDir,
      triggerEvent: pursuableTrigger,
      llmClient: stubLlmClientReturning(validCandidate({ title: 'BuyerCo wants help', counterparty: companyCounterparty }))
    });

    assert.equal(companyOpportunities[0].pursuable, true);
    assert.deepEqual(companyOpportunities[0].counterparty, companyCounterparty);

    const stored = getOpportunity(dataDir, companyOpportunities[0].id);
    assert.equal(stored.pursuable, true);
    assert.deepEqual(stored.counterparty, companyCounterparty);

    const listed = listOpportunities(dataDir);
    const listedNone = listed.find((opportunity) => opportunity.id === noneOpportunities[0].id);
    const listedCompany = listed.find((opportunity) => opportunity.id === companyOpportunities[0].id);
    assert.equal(listedNone.pursuable, false);
    assert.deepEqual(listedNone.counterparty, { kind: 'none', name: null, contactHint: null });
    assert.equal(listedCompany.pursuable, true);
    assert.deepEqual(listedCompany.counterparty, companyCounterparty);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('listOpportunities sorts pursuable first and treats a missing pursuable field as false', () => {
  const dataDir = makeTempDataDir();
  try {
    const fixtures = [
      {
        id: 'opp-missing',
        correlationId: 'phase4-sort-missing',
        title: 'Historical record with no pursuable field',
        type: 'market-trend',
        score: 0.95
      },
      {
        id: 'opp-true-low',
        correlationId: 'phase4-sort-true-low',
        title: 'Pursuable lower score',
        type: 'consulting-engagement',
        score: 0.4,
        pursuable: true,
        counterparty: { kind: 'company', name: 'BuyerCo', contactHint: 'Ops lead in evidence' }
      },
      {
        id: 'opp-false-high',
        correlationId: 'phase4-sort-false',
        title: 'Explicitly non-pursuable higher score',
        type: 'market-trend',
        score: 0.8,
        pursuable: false,
        counterparty: { kind: 'none', name: null, contactHint: null }
      },
      {
        id: 'opp-true-high',
        correlationId: 'phase4-sort-true-high',
        title: 'Pursuable higher score',
        type: 'consulting-engagement',
        score: 0.9,
        pursuable: true,
        counterparty: { kind: 'person', name: 'Jane Buyer', contactHint: 'Quoted CTO' }
      }
    ];

    for (const fixture of fixtures) {
      const trigger = appendEvent(dataDir, {
        type: 'lead.received',
        source: 'phase4-test',
        subject: { type: 'lead', id: `lead-${fixture.id}` },
        payload: {},
        correlationId: fixture.correlationId
      });
      const createdPayload = {
        id: fixture.id,
        type: fixture.type,
        title: fixture.title,
        description: 'desc',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [trigger.id],
        correlationId: fixture.correlationId,
        createdAt: trigger.occurredAt
      };
      if ('pursuable' in fixture) {
        createdPayload.pursuable = fixture.pursuable;
      }
      if ('counterparty' in fixture) {
        createdPayload.counterparty = fixture.counterparty;
      }
      const created = appendEvent(dataDir, {
        type: 'opportunity.created',
        source: 'role:opportunity.prospect',
        subject: { type: 'opportunity', id: fixture.id },
        payload: createdPayload,
        causationId: trigger.id,
        correlationId: fixture.correlationId
      });
      appendEvent(dataDir, {
        type: 'opportunity.scored',
        source: 'opportunity.engine',
        subject: { type: 'opportunity', id: fixture.id },
        payload: {
          id: fixture.id,
          score: { value: fixture.score, rationale: `score=${fixture.score}` },
          status: 'scored'
        },
        causationId: created.id,
        correlationId: fixture.correlationId
      });
    }

    const listed = listOpportunities(dataDir);
    assert.deepEqual(
      listed.map((opportunity) => opportunity.id),
      ['opp-true-high', 'opp-true-low', 'opp-missing', 'opp-false-high']
    );
    assert.equal(listed.find((opportunity) => opportunity.id === 'opp-missing').pursuable, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('boss-only prospect run produces one Opportunity, one completion, and never touches the second provider', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-boss-only' },
      payload: { note: 'Need AI workflow help' },
      correlationId: 'phase4-boss-only'
    });

    let alphaCalls = 0;
    let betaCalls = 0;
    const { opportunities } = await runOpportunityEngine({
      instanceConfig: multiProviderInstanceConfig(['alpha', 'beta']),
      dataDir,
      triggerEvent: trigger,
      llmClient: {
        alpha: async () => {
          alphaCalls += 1;
          return llmResponse(
            JSON.stringify(validCandidate({ title: 'Alpha boss opportunity', wantsSecondOpinion: false }))
          );
        },
        beta: async () => {
          betaCalls += 1;
          return llmResponse(JSON.stringify(validCandidate({ title: 'Beta should not run' })));
        }
      }
    });

    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].proposedBy.provider, 'alpha');
    assert.equal(alphaCalls, 1);
    assert.equal(betaCalls, 0);
    assert.equal(queryEvents(dataDir, { type: 'role.provider.completed', correlationId: trigger.correlationId }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'role.provider.reserved', correlationId: trigger.correlationId }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('boss-requested second opinion uses only the next provider, settles the reservation, and creates two Opportunities', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-elective-1' },
      payload: { note: 'Need AI workflow help' },
      correlationId: 'phase4-elective-1'
    });

    let betaCalls = 0;
    const { opportunities } = await runOpportunityEngine({
      instanceConfig: multiProviderInstanceConfig(['alpha', 'beta']),
      dataDir,
      triggerEvent: trigger,
      llmClient: {
        alpha: stubLlmClientReturning(
          validCandidate({
            title: 'Alpha boss opportunity',
            wantsSecondOpinion: true,
            secondOpinionReason: 'Needs a second angle'
          })
        ),
        beta: async () => {
          betaCalls += 1;
          return llmResponse(JSON.stringify(validCandidate({ title: 'Beta elective opportunity' })));
        }
      }
    });

    assert.equal(opportunities.length, 2);
    assert.equal(betaCalls, 1);
    assert.deepEqual(
      opportunities.map((opportunity) => opportunity.proposedBy.provider),
      ['alpha', 'beta']
    );
    assert.ok(opportunities.every((opportunity) => opportunity.correlationId === trigger.correlationId));

    const reservations = queryEvents(dataDir, { type: 'role.provider.reserved', correlationId: trigger.correlationId });
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].payload.provider, 'beta');

    const completions = queryEvents(dataDir, { type: 'role.provider.completed', correlationId: trigger.correlationId });
    assert.equal(completions.length, 2);
    const betaCompletion = completions.find((event) => event.payload.provider === 'beta');
    assert.equal(betaCompletion.payload.reservationId, reservations[0].payload.reservationId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('budget exhaustion skips the elective second opinion and records role.provider.skipped', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-elective-budget' },
      payload: { note: 'Need AI workflow help' },
      correlationId: 'phase4-elective-budget'
    });

    const { opportunities } = await runOpportunityEngine({
      instanceConfig: multiProviderInstanceConfig(['alpha', 'beta'], {
        llm: {
          budget: {
            period: 'daily',
            limits: {
              beta: { tokens: 100 }
            }
          }
        }
      }),
      dataDir,
      triggerEvent: trigger,
      llmClient: {
        alpha: stubLlmClientReturning(
          validCandidate({
            title: 'Alpha boss opportunity',
            wantsSecondOpinion: true,
            secondOpinionReason: 'Worth a double-check'
          })
        ),
        beta: stubLlmClientReturning(validCandidate({ title: 'Beta should be skipped' }))
      }
    });

    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].proposedBy.provider, 'alpha');
    assert.equal(queryEvents(dataDir, { type: 'role.provider.reserved', correlationId: trigger.correlationId }).length, 0);

    const skipped = queryEvents(dataDir, { type: 'role.provider.skipped', correlationId: trigger.correlationId });
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].payload.provider, 'beta');
    assert.equal(skipped[0].payload.reason, 'budget exhausted');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('boss failure falls back to the next provider without any budget reservation', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-fallback-1' },
      payload: { note: 'Need AI workflow help' },
      correlationId: 'phase4-fallback-1'
    });

    const { opportunities } = await runOpportunityEngine({
      instanceConfig: multiProviderInstanceConfig(['alpha', 'slow']),
      dataDir,
      triggerEvent: trigger,
      llmClient: {
        alpha: async () => {
          throw new Error('Boss timed out');
        },
        slow: stubLlmClientReturning(validCandidate({ title: 'Fallback provider opportunity' }))
      }
    });

    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].proposedBy.provider, 'slow');
    assert.equal(queryEvents(dataDir, { type: 'role.provider.reserved', correlationId: trigger.correlationId }).length, 0);

    const failures = queryEvents(dataDir, { type: 'role.provider.failed', correlationId: trigger.correlationId });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].payload.provider, 'alpha');
    assert.match(failures[0].payload.reason, /timed out/i);
    assert.equal(failures[0].payload.usage, null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fallback continues through the full provider list until one provider succeeds', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-fallback-2' },
      payload: { note: 'Need AI workflow help' },
      correlationId: 'phase4-fallback-2'
    });

    const { opportunities } = await runOpportunityEngine({
      instanceConfig: multiProviderInstanceConfig(['alpha', 'beta', 'gamma']),
      dataDir,
      triggerEvent: trigger,
      llmClient: {
        alpha: async () => {
          throw new Error('Alpha failed');
        },
        beta: async () => {
          throw new Error('Beta failed');
        },
        gamma: stubLlmClientReturning(validCandidate({ title: 'Gamma fallback opportunity' }))
      }
    });

    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].proposedBy.provider, 'gamma');
    assert.equal(queryEvents(dataDir, { type: 'role.provider.failed', correlationId: trigger.correlationId }).length, 2);
    assert.equal(queryEvents(dataDir, { type: 'role.provider.reserved', correlationId: trigger.correlationId }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a boss request for a second opinion reaches at most the next provider in the list', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-elective-2' },
      payload: { note: 'Need AI workflow help' },
      correlationId: 'phase4-elective-2'
    });

    let betaCalls = 0;
    let gammaCalls = 0;
    const { opportunities } = await runOpportunityEngine({
      instanceConfig: multiProviderInstanceConfig(['alpha', 'beta', 'gamma']),
      dataDir,
      triggerEvent: trigger,
      llmClient: {
        alpha: stubLlmClientReturning(
          validCandidate({
            title: 'Alpha boss opportunity',
            wantsSecondOpinion: true,
            secondOpinionReason: 'One more perspective'
          })
        ),
        beta: async () => {
          betaCalls += 1;
          return llmResponse(JSON.stringify(validCandidate({ title: 'Beta elective opportunity' })));
        },
        gamma: async () => {
          gammaCalls += 1;
          return llmResponse(JSON.stringify(validCandidate({ title: 'Gamma should not run' })));
        }
      }
    });

    assert.equal(opportunities.length, 2);
    assert.equal(betaCalls, 1);
    assert.equal(gammaCalls, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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
        return llmResponse('not valid json');
      }
      return llmResponse(
        JSON.stringify(validCandidate({ type: 'market-trend', title: `Trend for ${triggerEvent.payload.topic}` }))
      );
    };

    const results = await runDiscoveryPass({ instanceConfig, dataDir, researchAdapter, llmClient });

    assert.equal(results.length, 2);
    const good = results.find((r) => r.topic === 'topic-a-good');
    const bad = results.find((r) => r.topic === 'topic-b-bad');

    assert.equal(good.error, undefined);
    assert.equal(good.opportunities.length, 1);
    assert.equal(good.opportunities[0].type, 'market-trend');
    assert.match(bad.error, /invalid JSON/);

    const scored = listOpportunities(dataDir, { status: 'scored' });
    assert.equal(scored.length, 1);
    assert.equal(scored[0].title, 'Trend for topic-a-good');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('opportunity engine grounds candidates in real knowledge-base evidence with correct causation/correlation', async () => {
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

    const { opportunities, createdEvents } = await runOpportunityEngine({
      instanceConfig: config,
      dataDir,
      triggerEvent: trigger,
      researchAdapter,
      researchQuery: 'e3d-pilot',
      llmClient: stubLlmClientReturning(
        validCandidate({ type: 'product-opportunity', title: 'Package e3d-pilot output for FutCo clients' })
      )
    });
    const [opportunity] = opportunities;
    const [createdEvent] = createdEvents;

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

test('opportunities list and show CLI commands render pursuable-first rows, filters, counterparty data, and missing-field fallback', () => {
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
        pursuable: false,
        counterparty: { kind: 'none', name: null, contactHint: null },
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
        pursuable: true,
        counterparty: { kind: 'company', name: 'BuyerCo', contactHint: 'VP Operations named in evidence' },
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

    const triggerC = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-cli-c' },
      payload: {},
      correlationId: 'phase4-cli-chain-c'
    });
    const createdC = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-cli-c' },
      payload: {
        id: 'opp-cli-c',
        type: 'market-trend',
        title: 'Historical shape opportunity',
        description: 'desc c',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [triggerC.id],
        correlationId: triggerC.correlationId,
        createdAt: triggerC.occurredAt
      },
      causationId: triggerC.id,
      correlationId: triggerC.correlationId
    });
    appendEvent(dataDir, {
      type: 'opportunity.scored',
      source: 'opportunity.engine',
      subject: { type: 'opportunity', id: 'opp-cli-c' },
      payload: { id: 'opp-cli-c', score: { value: 0.7, rationale: 'historical' }, status: 'scored' },
      causationId: createdC.id,
      correlationId: triggerC.correlationId
    });

    const listOutput = runCli(['opportunities', 'list', '--instance', name]);
    const lines = listOutput.trim().split('\n');
    assert.ok(lines[0].includes('opp-cli-b'));
    assert.ok(lines[0].includes('[pursuable]'));
    assert.ok(lines[0].includes('counterparty=BuyerCo, kind=company, contactHint=VP Operations named in evidence'));
    assert.ok(lines[1].includes('opp-cli-a'));
    assert.ok(lines[1].includes('[intel-only]'));
    assert.ok(lines[1].includes('counterparty=none'));
    assert.ok(lines[2].includes('opp-cli-c'));
    assert.ok(lines[2].includes('[intel-only]'));
    assert.ok(lines[2].includes('counterparty=unknown (predates this field)'));

    const filteredOutput = runCli(['opportunities', 'list', '--instance', name, '--min-score', '0.5']);
    assert.match(filteredOutput, /opp-cli-a/);
    assert.match(filteredOutput, /opp-cli-c/);
    assert.doesNotMatch(filteredOutput, /opp-cli-b/);

    const pursuableOnlyOutput = runCli([
      'opportunities',
      'list',
      '--instance',
      name,
      '--pursuable-only',
      '--status',
      'scored',
      '--min-score',
      '0.1'
    ]);
    assert.match(pursuableOnlyOutput, /opp-cli-b/);
    assert.doesNotMatch(pursuableOnlyOutput, /opp-cli-a/);
    assert.doesNotMatch(pursuableOnlyOutput, /opp-cli-c/);

    const showOutput = runCli(['opportunities', 'show', 'opp-cli-b', '--instance', name]);
    assert.match(showOutput, /Opportunity opp-cli-b/);
    assert.match(showOutput, /Low score opportunity/);
    assert.match(showOutput, /pursuable:\s+true/);
    assert.match(showOutput, /kind:\s+company/);
    assert.match(showOutput, /name:\s+BuyerCo/);
    assert.match(showOutput, /contactHint:\s+VP Operations named in evidence/);
    assert.match(showOutput, /score:\s+0\.2/);
    assert.match(showOutput, /causal chain/);
    assert.match(showOutput, new RegExp(triggerB.id));

    const historicalShowOutput = runCli(['opportunities', 'show', 'opp-cli-c', '--instance', name]);
    assert.match(historicalShowOutput, /unknown \(predates this field\)/);
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
    ownDomains: ['example.com'],
    scoring: { weights: { confidence: 0.6, evidenceCount: 0.25, recency: 0.15 }, typeWeights: { 'consulting-engagement': 1.2 } }
  });
  assert.equal(validateInstanceConfig(valid).valid, true);

  const badTopics = { ...valid, researchTopics: 'not-an-array' };
  const badTopicsResult = validateInstanceConfig(badTopics);
  assert.equal(badTopicsResult.valid, false);
  assert.ok(badTopicsResult.errors.some((e) => e.startsWith('researchTopics:')));

  const badOwnDomains = { ...valid, ownDomains: 'not-an-array' };
  const badOwnDomainsResult = validateInstanceConfig(badOwnDomains);
  assert.equal(badOwnDomainsResult.valid, false);
  assert.ok(badOwnDomainsResult.errors.some((e) => e.startsWith('ownDomains:')));

  const badWeight = { ...valid, scoring: { weights: { confidence: 'high' } } };
  const badWeightResult = validateInstanceConfig(badWeight);
  assert.equal(badWeightResult.valid, false);
  assert.ok(badWeightResult.errors.some((e) => e.startsWith('scoring.weights.confidence:')));
});

test('futco instance config declares the opportunity.prospect role and real research topics', () => {
  const config = loadInstanceConfig(path.join(ROOT, '.e3d-corp', 'instance', 'futco', 'instance.json'));
  assert.deepEqual(config.roles['opportunity.prospect'], { provider: 'local' });
  assert.ok(Array.isArray(config.researchTopics) && config.researchTopics.length > 0);
});
