import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import {
  buildPrompt,
  parseCandidateJson,
  runInvestingOpportunityScorer
} from '../lib/roles/investingOpportunity.js';
import {
  normalizeInvestingOpportunityCandidate,
  validateInvestingOpportunityCandidate
} from '../lib/opportunities/investingSchema.js';

const ORIGINAL_ENV = {
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL
};

process.env.LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.LLM_MODEL = process.env.LLM_MODEL ?? 'test-local-model';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-investing-role-'));
}

function minimalInstanceConfig(overrides = {}) {
  return {
    name: 'futco',
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
    roles: { 'opportunity.investing': { provider: 'local' } },
    ...overrides
  };
}

function llmResponse(text, overrides = {}) {
  return {
    text,
    usage: { promptTokens: 31, completionTokens: 19, totalTokens: 50 },
    costUsd: null,
    ...overrides
  };
}

function stubLlmClientReturning(candidate) {
  return async () => llmResponse(typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
}

function validCandidate(overrides = {}) {
  return {
    type: 'long-idea',
    title: 'Stay long SOL while stablecoin flows keep accelerating',
    description: 'SOL retains constructive positioning because thesis demand and story flow both remain supportive.',
    view: 'bullish',
    confidence: 0.78,
    rationale: 'Active thesis support aligns with fresh story momentum and a healthy current market backdrop.',
    invalidationCondition: 'Invalidate if stablecoin inflows reverse and story activity falls materially for multiple sessions.',
    thesisRefs: ['thesis-sol-1'],
    storyRefs: ['story-sol-1'],
    evidenceEventIds: ['evidence-1'],
    ...overrides
  };
}

function investingEvidenceEvent(overrides = {}) {
  return {
    id: 'evidence-1',
    type: 'evidence.gathered',
    occurredAt: '2026-08-27T12:00:00.000Z',
    source: 'research.knowledgeBase',
    subject: { type: 'research', id: 'research-1' },
    payload: {
      kind: 'knowledge-base-search',
      query: 'sol thesis and story state',
      resultSummary: 'One thesis, one story, and one market snapshot',
      degraded: false,
      result: {
        theses: [
          {
            id: 'thesis-sol-1',
            type: 'thesis',
            title: 'Stablecoin liquidity keeps Solana structurally bid',
            summary: 'Liquidity migration into the chain remains constructive.'
          }
        ],
        stories: [
          {
            id: 'story-sol-1',
            type: 'story',
            title: 'On-chain wallet activity is accelerating',
            summary: 'Wallet growth and transactions both inflected up this week.'
          }
        ],
        marketState: [
          {
            id: 'market-sol-1',
            type: 'market-state',
            title: 'SOL price structure',
            summary: 'Higher highs and higher lows versus the weekly range.'
          }
        ]
      }
    },
    causationId: 'trigger-1',
    correlationId: 'corr-investing-1',
    ...overrides
  };
}

test('buildPrompt separates E3D theses, stories, and market state for the investing role', () => {
  const triggerEvent = {
    id: 'trigger-1',
    type: 'investment.signal.detected',
    occurredAt: '2026-08-27T11:00:00.000Z',
    source: 'manual',
    subject: { type: 'market-signal', id: 'sol' },
    payload: {
      marketTopic: 'Solana',
      marketState: { regime: 'risk-on', breadth: 'improving' }
    },
    correlationId: 'corr-investing-1'
  };

  const { systemPrompt, userPrompt } = buildPrompt({
    triggerEvent,
    evidenceEvents: [investingEvidenceEvent()],
    instanceConfig: minimalInstanceConfig(),
    marketState: triggerEvent.payload.marketState
  });

  assert.match(systemPrompt, /opportunity\.investing/);
  const parsed = JSON.parse(userPrompt);
  assert.deepEqual(parsed.marketState, { regime: 'risk-on', breadth: 'improving' });
  assert.equal(parsed.evidence.theses.length, 1);
  assert.equal(parsed.evidence.theses[0].id, 'thesis-sol-1');
  assert.equal(parsed.evidence.stories.length, 1);
  assert.equal(parsed.evidence.stories[0].id, 'story-sol-1');
  assert.equal(parsed.evidence.marketEvidence.length, 1);
  assert.equal(parsed.evidence.evidenceEvents[0].id, 'evidence-1');
});

test('runInvestingOpportunityScorer returns a normalized investment candidate and provider telemetry without mutating opportunity state', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      id: 'trigger-1',
      type: 'investment.signal.detected',
      source: 'manual',
      subject: { type: 'market-signal', id: 'sol' },
      payload: {
        marketTopic: 'Solana',
        marketState: { regime: 'risk-on', breadth: 'improving' }
      },
      correlationId: 'corr-investing-1'
    });

    appendEvent(dataDir, investingEvidenceEvent());

    const [candidate] = await runInvestingOpportunityScorer({
      instanceConfig: minimalInstanceConfig(),
      dataDir,
      triggerEvent: trigger,
      llmClient: stubLlmClientReturning(validCandidate())
    });

    assert.equal(candidate.type, 'long-idea');
    assert.equal(candidate.view, 'bullish');
    assert.equal(candidate.invalidationCondition, validCandidate().invalidationCondition);
    assert.deepEqual(candidate.thesisRefs, ['thesis-sol-1']);
    assert.deepEqual(candidate.storyRefs, ['story-sol-1']);
    assert.deepEqual(candidate.evidenceEventIds, ['evidence-1']);
    assert.deepEqual(candidate.proposedBy, {
      role: 'opportunity.investing',
      provider: 'local',
      model: process.env.LLM_MODEL
    });
    assert.ok(candidate.sourceEventIds.includes(trigger.id));
    assert.ok(candidate.sourceEventIds.includes('evidence-1'));
    assert.equal(candidate.correlationId, trigger.correlationId);

    const completions = queryEvents(dataDir, {
      type: 'role.provider.completed',
      correlationId: trigger.correlationId
    });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].payload.role, 'opportunity.investing');
    assert.deepEqual(completions[0].payload.usage, { promptTokens: 31, completionTokens: 19, totalTokens: 50 });

    assert.equal(queryEvents(dataDir, { type: 'opportunity.created' }).length, 0);
    assert.equal(queryEvents(dataDir, { type: 'opportunity.scored' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invented thesis or story references are rejected and recorded as a provider failure', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      id: 'trigger-2',
      type: 'investment.signal.detected',
      source: 'manual',
      subject: { type: 'market-signal', id: 'btc' },
      payload: { marketTopic: 'Bitcoin' },
      correlationId: 'corr-investing-2'
    });

    appendEvent(
      dataDir,
      investingEvidenceEvent({
        id: 'evidence-2',
        subject: { type: 'research', id: 'research-2' },
        causationId: 'trigger-2',
        correlationId: 'corr-investing-2'
      })
    );

    await assert.rejects(
      runInvestingOpportunityScorer({
        instanceConfig: minimalInstanceConfig(),
        dataDir,
        triggerEvent: trigger,
        llmClient: stubLlmClientReturning(
          validCandidate({
            evidenceEventIds: ['evidence-2'],
            thesisRefs: ['thesis-not-real'],
            storyRefs: ['story-sol-1']
          })
        )
      }),
      /unknown reference "thesis-not-real"/
    );

    const failures = queryEvents(dataDir, { type: 'role.provider.failed', correlationId: trigger.correlationId });
    assert.equal(failures.length, 1);
    assert.match(failures[0].payload.reason, /unknown reference "thesis-not-real"/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parseCandidateJson and investing schema reject malformed or incomplete role output', () => {
  assert.throws(() => parseCandidateJson(''), /returned empty output/);
  assert.throws(() => parseCandidateJson('not json'), /invalid JSON/);

  const incomplete = {
    type: 'watchlist',
    title: 'Wait and see',
    description: 'Signal is mixed.',
    rationale: 'Not enough alignment yet.',
    confidence: 0.2
  };

  const validation = validateInvestingOpportunityCandidate(incomplete);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('view')));
  assert.ok(validation.errors.some((error) => error.includes('invalidationCondition')));

  assert.throws(
    () => normalizeInvestingOpportunityCandidate({ ...validCandidate(), view: 'sideways' }),
    /view: must be one of/
  );
});
