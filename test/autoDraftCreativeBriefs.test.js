import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { autoDraftCreativeBriefs } from '../lib/roles/autoDraftCreativeBriefs.js';

// resolveProvider() checks these env vars are actually set before returning
// {model, call}, even when a test supplies its own llmClient override - same
// requirement test/creativeBrief.test.js already documents for this role.
const ORIGINAL_ENV = {
  AUTO_DRAFT_BRIEFS_LLM_BASE_URL: process.env.AUTO_DRAFT_BRIEFS_LLM_BASE_URL,
  AUTO_DRAFT_BRIEFS_LLM_MODEL: process.env.AUTO_DRAFT_BRIEFS_LLM_MODEL
};
process.env.AUTO_DRAFT_BRIEFS_LLM_BASE_URL = process.env.AUTO_DRAFT_BRIEFS_LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.AUTO_DRAFT_BRIEFS_LLM_MODEL = process.env.AUTO_DRAFT_BRIEFS_LLM_MODEL ?? 'auto-draft-briefs-model-local';

test.after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-auto-draft-briefs-'));
}

function instanceConfig() {
  return {
    name: 'FutCo',
    llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'AUTO_DRAFT_BRIEFS_LLM_BASE_URL', modelEnvVar: 'AUTO_DRAFT_BRIEFS_LLM_MODEL' } } },
    roles: { 'creative.brief': { provider: 'local' } }
  };
}

function seedPursuingOpportunity(dataDir, { opportunityId }) {
  const correlationId = `auto-draft-${opportunityId}`;
  const evidence = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.metaInsights',
    subject: { type: 'research', id: 'r1' },
    payload: { kind: 'meta-insights', query: {}, result: { status: 'ok', rows: [] }, resultSummary: 'x', degraded: false },
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id: opportunityId },
    payload: {
      id: opportunityId,
      type: 'product-opportunity',
      title: 'CPL creeping up',
      description: 'desc',
      evidence: [],
      score: null,
      status: 'candidate',
      sourceEventIds: [evidence.id],
      correlationId,
      createdAt: evidence.occurredAt
    },
    causationId: evidence.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'worth it', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });
}

function validDraftJson(evidenceEventId) {
  return JSON.stringify({
    product: 'oppscan',
    audience: 'HVAC business owners',
    objective: 'landing_page_view',
    constraints: [],
    spendCeiling: null,
    metric: 'cost per landing page view',
    threshold: 'below $4.50',
    rationale: 'grounded',
    evidenceEventIds: [evidenceEventId]
  });
}

test('autoDraftCreativeBriefs drafts a brief for every pursuing opportunity lacking one', async () => {
  const dataDir = makeTempDataDir();
  try {
    seedPursuingOpportunity(dataDir, { opportunityId: 'opp-a' });
    seedPursuingOpportunity(dataDir, { opportunityId: 'opp-b' });

    const llmClient = async ({ userPrompt }) => {
      const parsed = JSON.parse(userPrompt);
      return { text: validDraftJson(parsed.allowedEvidenceEventIds[0]) };
    };

    const results = await autoDraftCreativeBriefs(dataDir, { instanceConfig: instanceConfig(), llmClient });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'drafted'));
    assert.equal(queryEvents(dataDir, { type: 'creative-brief.drafted' }).length, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoDraftCreativeBriefs skips an opportunity that already has a drafted brief, and never re-drafts on a second scan', async () => {
  const dataDir = makeTempDataDir();
  try {
    seedPursuingOpportunity(dataDir, { opportunityId: 'opp-c' });
    const llmClient = async ({ userPrompt }) => {
      const parsed = JSON.parse(userPrompt);
      return { text: validDraftJson(parsed.allowedEvidenceEventIds[0]) };
    };

    const first = await autoDraftCreativeBriefs(dataDir, { instanceConfig: instanceConfig(), llmClient });
    assert.equal(first[0].status, 'drafted');

    const second = await autoDraftCreativeBriefs(dataDir, { instanceConfig: instanceConfig(), llmClient });
    assert.equal(second.length, 1);
    assert.equal(second[0].status, 'already-drafted');
    assert.equal(queryEvents(dataDir, { type: 'creative-brief.drafted' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoDraftCreativeBriefs records an error for one opportunity without aborting the rest of the scan', async () => {
  const dataDir = makeTempDataDir();
  try {
    seedPursuingOpportunity(dataDir, { opportunityId: 'opp-fail' });
    seedPursuingOpportunity(dataDir, { opportunityId: 'opp-ok' });

    let call = 0;
    const llmClient = async ({ userPrompt }) => {
      call += 1;
      if (call === 1) {
        return { text: 'not json' };
      }
      const parsed = JSON.parse(userPrompt);
      return { text: validDraftJson(parsed.allowedEvidenceEventIds[0]) };
    };

    const results = await autoDraftCreativeBriefs(dataDir, { instanceConfig: instanceConfig(), llmClient });
    assert.equal(results.length, 2);
    const byId = Object.fromEntries(results.map((r) => [r.opportunityId, r]));
    assert.equal(byId['opp-fail'].status, 'error');
    assert.equal(byId['opp-ok'].status, 'drafted');
    assert.equal(queryEvents(dataDir, { type: 'creative-brief.drafted' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
