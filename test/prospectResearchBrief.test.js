import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProspectResearchBrief, sanitizeBrief } from '../lib/roles/prospectResearchBrief.js';
import { scoreIcpFit } from '../lib/research/icpScoring.js';

const ORIGINAL_API_KEY = process.env.TEST_ANTHROPIC_API_KEY;
process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY ?? 'test-key';

test.after(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.TEST_ANTHROPIC_API_KEY;
  else process.env.TEST_ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
});

function instanceConfig() {
  return {
    llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'TEST_ANTHROPIC_API_KEY' } } },
    roles: { 'sales.prospectResearchBrief': { provider: 'claude' } }
  };
}

const SAMPLE_BUSINESS = { name: 'Acme HVAC', website: 'https://acmehvac.example.com', location: 'Sacramento, CA' };
const SAMPLE_RAW_RESEARCH = { websiteText: 'Family owned since 2009. No online scheduling, phone only.', googleBusinessProfile: '4.1 stars, 23 reviews' };

test('sanitizeBrief parses a well-formed response and coerces unknown signal types to null', () => {
  const result = sanitizeBrief(
    JSON.stringify({
      leakHypothesis: 'No online scheduling likely loses after-hours inquiries.',
      signals: { yearsInBusiness: 16, activeAdvertising: 'yes', weakLeadCaptureObserved: true, unknownKey: 1 },
      estimatedFields: ['yearsInBusiness', 'notARealKey'],
      sourceNotes: ['website has no scheduling link']
    })
  );
  assert.equal(result.leakHypothesis, 'No online scheduling likely loses after-hours inquiries.');
  assert.equal(result.signals.yearsInBusiness, 16);
  assert.equal(result.signals.activeAdvertising, null); // 'yes' is a string, not a boolean - rejected
  assert.equal(result.signals.weakLeadCaptureObserved, true);
  assert.equal(result.signals.revenueEstimate, null); // not provided at all
  assert.deepEqual(result.estimatedFields, ['yearsInBusiness']); // unknown key filtered out
  assert.deepEqual(result.sourceNotes, ['website has no scheduling link']);
});

test('sanitizeBrief strips a markdown fence around the JSON', () => {
  const result = sanitizeBrief('```json\n{"leakHypothesis": "x", "signals": {}, "estimatedFields": [], "sourceNotes": []}\n```');
  assert.equal(result.leakHypothesis, 'x');
});

test('sanitizeBrief returns null for invalid JSON rather than guessing', () => {
  assert.equal(sanitizeBrief('not json at all'), null);
});

test('sanitizeBrief returns null when leakHypothesis is missing', () => {
  assert.equal(sanitizeBrief(JSON.stringify({ signals: {}, estimatedFields: [], sourceNotes: [] })), null);
});

test('draftProspectResearchBrief output signals plug directly into scoreIcpFit', async () => {
  const { brief } = await draftProspectResearchBrief({
    instanceConfig: instanceConfig(),
    business: SAMPLE_BUSINESS,
    rawResearch: SAMPLE_RAW_RESEARCH,
    llmClient: async () => ({
      text: JSON.stringify({
        leakHypothesis: 'Phone-only intake with no after-hours path likely loses urgent evening calls.',
        signals: { yearsInBusiness: 16, weakLeadCaptureObserved: true, reputationOpportunity: false },
        estimatedFields: ['weakLeadCaptureObserved'],
        sourceNotes: ['family owned since 2009', 'phone only, no online scheduling']
      })
    })
  });

  assert.ok(brief.leakHypothesis.length > 0);
  const scored = scoreIcpFit(brief.signals, { estimatedFields: brief.estimatedFields });
  assert.equal(scored.breakdown.find((c) => c.key === 'yearsInBusiness').points, 5);
  assert.equal(scored.breakdown.find((c) => c.key === 'weakLeadCaptureObserved').estimated, true);
});

test('draftProspectResearchBrief requires a business with a name', async () => {
  await assert.rejects(
    draftProspectResearchBrief({
      instanceConfig: instanceConfig(),
      business: {},
      rawResearch: SAMPLE_RAW_RESEARCH,
      llmClient: async () => ({ text: 'x' })
    }),
    /requires a business object with a name/
  );
});

test('draftProspectResearchBrief requires a rawResearch object', async () => {
  await assert.rejects(
    draftProspectResearchBrief({
      instanceConfig: instanceConfig(),
      business: SAMPLE_BUSINESS,
      llmClient: async () => ({ text: 'x' })
    }),
    /requires a rawResearch object/
  );
});

test('draftProspectResearchBrief returns a null brief (not a throw) when the model responds with garbage', async () => {
  const { brief } = await draftProspectResearchBrief({
    instanceConfig: instanceConfig(),
    business: SAMPLE_BUSINESS,
    rawResearch: SAMPLE_RAW_RESEARCH,
    llmClient: async () => ({ text: 'sorry, I cannot help with that' })
  });
  assert.equal(brief, null);
});
