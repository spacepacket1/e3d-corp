import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createResearchAdapter } from '../lib/research/adapter.js';
import { recordLeadReceived } from '../lib/event-sources/e3dApplied.js';
import { loadInstanceConfig, loadInstance } from '../lib/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempInstance({ knowledgeBaseMcpUrl, knowledgeBaseMcpServerPath, webSearchProvider, webSearchApiKeyEnvVar }) {
  const name = `phase3-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify(
      {
        name,
        dataDir: `.e3d-corp/instance/${name}`,
        llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
        research: {
          knowledgeBaseMcpUrl,
          ...(knowledgeBaseMcpServerPath ? { knowledgeBaseMcpServerPath } : {}),
          webSearchProvider,
          ...(webSearchApiKeyEnvVar ? { webSearchApiKeyEnvVar } : {})
        },
        eventSources: [
          {
            name: 'e3d-applied-contact-delivery',
            type: 'lead-capture',
            source: 'e3d-applied',
            delivery: 'webhook',
            endpointEnvVar: 'CONTACT_FORM_ENDPOINT_URL',
            path: '/contact'
          }
        ],
        roles: {}
      },
      null,
      2
    )
  );
  return { name, instanceDir };
}

function cleanupTempInstance(instanceDir) {
  fs.rmSync(instanceDir, { recursive: true, force: true });
}

test('futco instance config declares the e3d-applied lead-capture source', () => {
  const config = loadInstanceConfig(path.join(ROOT, '.e3d-corp', 'instance', 'futco', 'instance.json'));

  assert.equal(config.eventSources.length > 0, true);
  assert.equal(config.eventSources[0].source, 'e3d-applied');
  assert.equal(config.eventSources[0].type, 'lead-capture');
});

test('research adapter returns real knowledge-base results and appends evidence', async () => {
  const { name, instanceDir } = makeTempInstance({
    knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
    knowledgeBaseMcpServerPath: '../futco-mcp/server.js',
    webSearchProvider: 'disabled'
  });

  try {
    const { config, dataDir } = loadInstance(name);
    const adapter = createResearchAdapter(config, { dataDir });
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-1' },
      payload: { note: 'seed' },
      correlationId: 'phase3-kb-chain'
    });

    const result = await adapter.searchKnowledgeBase('e3d-pilot', {
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.equal(result.status, 'ok');
    assert.ok(result.matchCount > 0);
    assert.ok(result.results.length > 0);
    assert.match(result.summary, /\d+ matches/);

    const evidenceEvents = queryEvents(dataDir, {
      type: 'evidence.gathered',
      correlationId: trigger.correlationId
    });
    assert.equal(evidenceEvents.length, 1);
    assert.equal(evidenceEvents[0].causationId, trigger.id);
    assert.equal(evidenceEvents[0].payload.query, 'e3d-pilot');
    assert.equal(evidenceEvents[0].payload.degraded, false);
    assert.equal(evidenceEvents[0].payload.result.status, 'ok');
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

test('research adapter parses repo info and records evidence for the repo lookup', async () => {
  const { name, instanceDir } = makeTempInstance({
    knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
    knowledgeBaseMcpServerPath: '../futco-mcp/server.js',
    webSearchProvider: 'disabled'
  });

  try {
    const { config, dataDir } = loadInstance(name);
    const adapter = createResearchAdapter(config, { dataDir });
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-2' },
      payload: { note: 'seed' },
      correlationId: 'phase3-repo-chain'
    });

    const result = await adapter.getRepoInfo('e3d-pilot', {
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.repo.meta.name, 'e3d-pilot');
    assert.ok(result.repo.raw.includes('e3d-pilot'));
    assert.ok(result.summary.length > 0);

    const evidenceEvents = queryEvents(dataDir, {
      type: 'evidence.gathered',
      correlationId: trigger.correlationId
    });
    assert.equal(evidenceEvents.length, 1);
    assert.equal(evidenceEvents[0].payload.query, 'e3d-pilot');
    assert.equal(evidenceEvents[0].payload.result.status, 'ok');
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

test('web search uses the configured provider and appends evidence', async () => {
  const originalFetch = global.fetch;
  const fixtureUrl = 'https://search.fixture.local/search';
  global.fetch = async (input, init) => {
    assert.equal(String(input), fixtureUrl);
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(
      JSON.stringify({
        summary: `Fixture results for ${body.query}`,
        results: [{ title: `${body.query} result`, url: 'https://example.com/result', snippet: 'fixture' }]
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  };
  const { name, instanceDir } = makeTempInstance({
    knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
    webSearchProvider: fixtureUrl
  });

  try {
    const { config, dataDir } = loadInstance(name);
    const adapter = createResearchAdapter(config, { dataDir });
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-3' },
      payload: { note: 'seed' },
      correlationId: 'phase3-web-chain'
    });

    const result = await adapter.webSearch('e3d-corp', {
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.searchProvider, fixtureUrl);
    assert.equal(result.results.length, 1);
    assert.match(result.summary, /Fixture results/);

    const evidenceEvents = queryEvents(dataDir, {
      type: 'evidence.gathered',
      correlationId: trigger.correlationId
    });
    assert.equal(evidenceEvents.length, 1);
    assert.equal(evidenceEvents[0].payload.query, 'e3d-corp');
    assert.equal(evidenceEvents[0].payload.degraded, false);
  } finally {
    global.fetch = originalFetch;
    cleanupTempInstance(instanceDir);
  }
});

test('web search includes the configured API key from the referenced env var', async () => {
  const originalFetch = global.fetch;
  const fixtureUrl = 'https://api.tavily.com/search';
  const envVar = 'PHASE3_TEST_TAVILY_KEY';
  const originalEnvValue = process.env[envVar];
  process.env[envVar] = 'test-secret-key';
  let capturedBody;
  let capturedHeaders;
  global.fetch = async (input, init) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}'));
    capturedHeaders = init?.headers ?? {};
    return new Response(
      JSON.stringify({ answer: 'A synthesized answer.', results: [{ title: 'result', url: 'https://example.com' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  const { name, instanceDir } = makeTempInstance({
    knowledgeBaseMcpUrl: 'http://127.0.0.1:4110',
    webSearchProvider: fixtureUrl,
    webSearchApiKeyEnvVar: envVar
  });

  try {
    const { config, dataDir } = loadInstance(name);
    const adapter = createResearchAdapter(config, { dataDir });
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-apikey' },
      payload: { note: 'seed' },
      correlationId: 'phase3-apikey-chain'
    });

    const result = await adapter.webSearch('e3d-corp', {
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.equal(result.status, 'ok');
    assert.equal(capturedBody.api_key, 'test-secret-key');
    assert.equal(capturedHeaders.authorization, 'Bearer test-secret-key');
    assert.match(result.summary, /synthesized answer/);
  } finally {
    global.fetch = originalFetch;
    cleanupTempInstance(instanceDir);
    if (originalEnvValue === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = originalEnvValue;
    }
  }
});

test('research adapter returns documented unavailable results when providers are unreachable', async () => {
  const { name, instanceDir } = makeTempInstance({
    knowledgeBaseMcpUrl: 'http://127.0.0.1:1',
    webSearchProvider: 'disabled'
  });

  try {
    const { config, dataDir } = loadInstance(name);
    const adapter = createResearchAdapter(config, { dataDir });
    const trigger = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'manual',
      subject: { type: 'signal', id: 'signal-4' },
      payload: { note: 'seed' },
      correlationId: 'phase3-unavailable-chain'
    });

    const futcoResult = await adapter.searchKnowledgeBase('e3d-pilot', {
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    const webResult = await adapter.webSearch('e3d-corp', {
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.equal(futcoResult.status, 'unavailable');
    assert.match(futcoResult.reason, /unavailable/);
    assert.equal(webResult.status, 'unavailable');
    assert.match(webResult.reason, /unavailable/);

    const evidenceEvents = queryEvents(dataDir, {
      type: 'evidence.gathered',
      correlationId: trigger.correlationId
    });
    assert.equal(evidenceEvents.length, 2);
    for (const event of evidenceEvents) {
      assert.equal(event.payload.degraded, true);
      assert.equal(event.payload.result.status, 'unavailable');
    }
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

test('recordLeadReceived creates lead.received with a fresh correlationId', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-leads-'));
  try {
    const lead = recordLeadReceived(dataDir, {
      name: 'Chris Bloom',
      email: 'chris@example.com',
      company: 'FutCo',
      role: 'Founder',
      companySize: '2–9',
      workflowProblem: 'Improve onboarding handoffs.',
      triedAi: 'None',
      preferredNextStep: 'Introductory call',
      phone: '+1 555 555 5555',
      referralSource: 'Direct',
      consent: true,
      submittedAt: '2026-08-13T12:00:00.000Z'
    });

    assert.equal(lead.type, 'lead.received');
    assert.match(lead.correlationId, /^[0-9a-f-]{36}$/);
    assert.equal(lead.causationId, null);
    assert.equal(lead.payload.submission.email, 'chris@example.com');

    const records = queryEvents(dataDir, { type: 'lead.received' });
    assert.equal(records.length, 1);
    assert.equal(records[0].correlationId, lead.correlationId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
