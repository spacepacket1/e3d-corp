import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import {
  buildPrompt,
  normalizeBriefDraft,
  parseBriefDraftJson,
  runCreativeBrief,
  toE3dCreativeBrief
} from '../lib/roles/creativeBrief.js';
// Cross-repo import for strong verification, same convention as
// test/e3dTradeAcceptance.test.js importing e3d-trade's own scripts: this
// asserts the brief this role produces actually validates against
// e3d-creative's real, current schema, not a hoped-to-be-in-sync copy.
import { validateBriefInput } from '../../e3d-creative/lib/schema.js';

// resolveProvider() validates the configured provider is actually "ready"
// (env vars set) before returning {model, call} - even when a test supplies
// its own llmClient override - so these need to be set once up front, same
// as test/riskAssess.test.js does for its own role's env vars.
const ORIGINAL_ENV = {
  CREATIVE_BRIEF_LLM_BASE_URL: process.env.CREATIVE_BRIEF_LLM_BASE_URL,
  CREATIVE_BRIEF_LLM_MODEL: process.env.CREATIVE_BRIEF_LLM_MODEL
};
process.env.CREATIVE_BRIEF_LLM_BASE_URL = process.env.CREATIVE_BRIEF_LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.CREATIVE_BRIEF_LLM_MODEL = process.env.CREATIVE_BRIEF_LLM_MODEL ?? 'creative-brief-model-local';

test.after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
      continue;
    }
    process.env[name] = value;
  }
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-creative-brief-'));
}

function baseInstanceConfig(overrides = {}) {
  return {
    name: 'FutCo',
    llm: {
      providers: {
        local: {
          kind: 'local',
          baseUrlEnvVar: 'CREATIVE_BRIEF_LLM_BASE_URL',
          modelEnvVar: 'CREATIVE_BRIEF_LLM_MODEL'
        }
      }
    },
    roles: {
      'creative.brief': {
        provider: 'local'
      }
    },
    ...overrides
  };
}

function llmResponse(text) {
  return { text };
}

// A realistic chain: a Meta-insights evidence pull showing rising CPL, then
// a creative Opportunity opened from it and marked pursuing - the same
// shape ops/reports/pollMetaInsights.js + opportunity.prospect produce for
// real, not a synthetic fixture unrelated to the actual pipeline.
function seedPursuingCreativeOpportunity(dataDir, { opportunityId = 'opp-creative-brief-1' } = {}) {
  const correlationId = `creative-brief-${opportunityId}`;
  const evidence = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.metaInsights',
    subject: { type: 'research', id: 'research-1' },
    payload: {
      kind: 'meta-insights',
      query: { adAccountId: '123', campaignIds: ['hvac_v3'] },
      resultSummary: '14 row(s) across 1 campaign(s)',
      result: {
        status: 'ok',
        rows: [
          { campaignId: 'hvac_v3', campaignName: 'HVAC Scanner - NorCal', costPerLandingPageView: 6.2, spend: 410.5 }
        ]
      },
      degraded: false
    },
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id: opportunityId },
    payload: {
      id: opportunityId,
      type: 'product-opportunity',
      title: 'HVAC ad cost-per-landing-page-view has crept above target',
      description: 'The HVAC Scanner v3 campaign is running at $6.20 cost per landing page view, well above the $4.50 target.',
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
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth a new creative direction', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });

  return {
    correlationId,
    evidenceEventId: evidence.id,
    opportunity: {
      id: opportunityId,
      type: 'product-opportunity',
      title: 'HVAC ad cost-per-landing-page-view has crept above target',
      description: 'The HVAC Scanner v3 campaign is running at $6.20 cost per landing page view, well above the $4.50 target.',
      status: 'pursuing',
      score: null,
      correlationId
    }
  };
}

function validDraft(overrides = {}, evidenceEventId) {
  return {
    product: 'OppScan HVAC Scanner',
    audience: 'HVAC business owners in NorCal running paid search/social today',
    objective: 'Lower cost per landing page view back toward the $4.50 target',
    constraints: ['30 seconds or under', 'no fabricated testimonials'],
    spendCeiling: 500,
    metric: 'cost per landing page view',
    threshold: 'below $4.50',
    rationale: 'The current creative direction is running well above its cost-per-landing-page-view target.',
    evidenceEventIds: [evidenceEventId],
    ...overrides
  };
}

test('runCreativeBrief drafts a brief grounded in the evidence chain that validates against e3d-creative\'s real schema', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity, evidenceEventId } = seedPursuingCreativeOpportunity(dataDir);

    let capturedPrompt = null;
    const result = await runCreativeBrief({
      instanceConfig: baseInstanceConfig(),
      dataDir,
      opportunity,
      llmClient: async ({ systemPrompt, userPrompt }) => {
        capturedPrompt = { systemPrompt, userPrompt: JSON.parse(userPrompt) };
        return llmResponse(JSON.stringify(validDraft({}, evidenceEventId)));
      }
    });

    assert.match(capturedPrompt.systemPrompt, /Ground every claim in the evidence/i);
    assert.match(capturedPrompt.systemPrompt, /Never invent an audience/i);
    assert.equal(capturedPrompt.userPrompt.opportunity.id, opportunity.id);
    assert.ok(capturedPrompt.userPrompt.allowedEvidenceEventIds.includes(evidenceEventId));

    assert.deepEqual(result.brief, {
      product: 'OppScan HVAC Scanner',
      audience: 'HVAC business owners in NorCal running paid search/social today',
      objective: 'Lower cost per landing page view back toward the $4.50 target',
      baselineRef: null,
      constraints: ['30 seconds or under', 'no fabricated testimonials'],
      spendCeiling: 500,
      metric: 'cost per landing page view',
      threshold: 'below $4.50'
    });

    const schemaCheck = validateBriefInput(result.brief);
    assert.equal(schemaCheck.valid, true, `brief should validate against e3d-creative's schema: ${schemaCheck.errors?.join(', ')}`);

    assert.equal(result.event.type, 'creative-brief.drafted');
    assert.equal(result.event.correlationId, opportunity.correlationId);
    assert.equal(result.event.payload.opportunityId, opportunity.id);
    assert.deepEqual(result.event.payload.evidenceEventIds, [evidenceEventId]);
    assert.equal(result.event.payload.role, 'creative.brief');
    assert.equal(result.event.payload.provider, 'local');

    assert.equal(queryEvents(dataDir, { type: 'creative-brief.drafted' }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief refuses an opportunity that is not "pursuing"', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-not-pursuing' });
    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        opportunity: { ...opportunity, status: 'scored' }
      }),
      /not "pursuing"/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief fails closed on ungrounded output: empty evidenceEventIds is refused, and no event is recorded', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity, evidenceEventId } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-ungrounded' });

    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        opportunity,
        llmClient: async () => llmResponse(JSON.stringify(validDraft({ evidenceEventIds: [] }, evidenceEventId)))
      }),
      /non-empty array.*grounded/
    );

    assert.equal(queryEvents(dataDir, { type: 'creative-brief.drafted' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief refuses a hallucinated evidence id not in the allowed list', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-hallucinated' });

    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        opportunity,
        llmClient: async () => llmResponse(JSON.stringify(validDraft({ evidenceEventIds: ['event-that-does-not-exist'] }, null)))
      }),
      /must only cite supplied event ids/
    );

    assert.equal(queryEvents(dataDir, { type: 'creative-brief.drafted' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief rejects output with missing or extra keys', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity, evidenceEventId } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-extra-keys' });
    const { rationale, ...missingRationale } = validDraft({}, evidenceEventId);

    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        opportunity,
        llmClient: async () => llmResponse(JSON.stringify(missingRationale))
      }),
      /must contain exactly these keys/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief rejects a negative or non-numeric spendCeiling', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity, evidenceEventId } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-bad-spend' });

    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        opportunity,
        llmClient: async () => llmResponse(JSON.stringify(validDraft({ spendCeiling: -10 }, evidenceEventId)))
      }),
      /spendCeiling.*finite number/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief accepts a null spendCeiling when the evidence gives no spend figure', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity, evidenceEventId } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-null-spend' });

    const result = await runCreativeBrief({
      instanceConfig: baseInstanceConfig(),
      dataDir,
      opportunity,
      llmClient: async () => llmResponse(JSON.stringify(validDraft({ spendCeiling: null }, evidenceEventId)))
    });

    assert.equal(result.brief.spendCeiling, null);
    assert.equal(validateBriefInput(result.brief).valid, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief rejects an empty constraints entry and allows an empty constraints array', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity, evidenceEventId } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-constraints' });

    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        opportunity,
        llmClient: async () => llmResponse(JSON.stringify(validDraft({ constraints: [''] }, evidenceEventId)))
      }),
      /constraints.*non-empty strings/
    );

    const result = await runCreativeBrief({
      instanceConfig: baseInstanceConfig(),
      dataDir,
      opportunity,
      llmClient: async () => llmResponse(JSON.stringify(validDraft({ constraints: [] }, evidenceEventId)))
    });
    assert.deepEqual(result.brief.constraints, []);
    assert.equal(validateBriefInput(result.brief).valid, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runCreativeBrief throws before any provider call when roles["creative.brief"].provider is missing', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingCreativeOpportunity(dataDir, { opportunityId: 'opp-no-provider' });
    let called = false;

    await assert.rejects(
      () => runCreativeBrief({
        instanceConfig: baseInstanceConfig({ roles: {} }),
        dataDir,
        opportunity,
        llmClient: async () => {
          called = true;
          return llmResponse('{}');
        }
      }),
      /missing roles\.creative\.brief\.provider/
    );
    assert.equal(called, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parseBriefDraftJson strips a markdown fence and normalizeBriefDraft/buildPrompt are exercised directly', () => {
  const parsed = parseBriefDraftJson('```json\n{"a":1}\n```');
  assert.deepEqual(parsed, { a: 1 });

  const draft = normalizeBriefDraft(validDraft({}, 'evt-1'), ['evt-1']);
  assert.deepEqual(toE3dCreativeBrief(draft), {
    product: draft.product,
    audience: draft.audience,
    objective: draft.objective,
    baselineRef: null,
    constraints: draft.constraints,
    spendCeiling: draft.spendCeiling,
    metric: draft.metric,
    threshold: draft.threshold
  });

  const { systemPrompt, userPrompt, allowedEvidenceEventIds } = buildPrompt({
    opportunity: { id: 'o1', type: 'product-opportunity', title: 't', description: 'd', score: null },
    chain: [{ id: 'e1', type: 'opportunity.created', occurredAt: '2026-01-01T00:00:00.000Z', payload: {} }],
    instanceConfig: { name: 'FutCo' }
  });
  assert.match(systemPrompt, /FutCo/);
  assert.deepEqual(allowedEvidenceEventIds, ['e1']);
  assert.equal(JSON.parse(userPrompt).opportunity.id, 'o1');
});
