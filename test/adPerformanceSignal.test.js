import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { runOpportunityEngine } from '../lib/opportunities/engine.js';
import { collectDegradationCandidates, recordDegradationSignal, alreadySignaledIds } from '../lib/event-sources/adPerformanceSignal.js';

const ORIGINAL_ENV = {
  AD_PERF_SIGNAL_LLM_BASE_URL: process.env.AD_PERF_SIGNAL_LLM_BASE_URL,
  AD_PERF_SIGNAL_LLM_MODEL: process.env.AD_PERF_SIGNAL_LLM_MODEL
};
process.env.AD_PERF_SIGNAL_LLM_BASE_URL = process.env.AD_PERF_SIGNAL_LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.AD_PERF_SIGNAL_LLM_MODEL = process.env.AD_PERF_SIGNAL_LLM_MODEL ?? 'ad-perf-signal-model-local';

test.after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-ad-perf-signal-'));
}

function instanceConfig() {
  return {
    name: 'FutCo',
    llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'AD_PERF_SIGNAL_LLM_BASE_URL', modelEnvVar: 'AD_PERF_SIGNAL_LLM_MODEL' } } },
    roles: { 'opportunity.prospect': { provider: 'local' } }
  };
}

const NOW = new Date('2026-10-11T00:00:00.000Z');

function row({ date, campaignId = 'camp-1', spend, landingPageViews }) {
  return { date, campaignId, campaignName: 'hvac', impressions: null, clicks: null, spend, cpm: null, landingPageViews, costPerLandingPageView: null, actions: [], costPerActionType: [] };
}

function daysAgo(n, from = NOW) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function landInsightsEvidence(dataDir, rows) {
  return appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research.metaInsights',
    subject: { type: 'research', id: `evidence-${Math.random().toString(36).slice(2)}` },
    payload: { kind: 'meta-insights', query: {}, result: { status: 'ok', rows }, resultSummary: 'test', degraded: false },
    correlationId: 'meta-poll-correlation'
  });
}

const CAMPAIGNS = [{ key: 'hvac_v3', campaignId: 'camp-1', label: 'HVAC Scanner v3', product: 'oppscan' }];

test('collectDegradationCandidates finds a breach with the default rule when no override is configured', () => {
  const dataDir = makeTempDataDir();
  try {
    landInsightsEvidence(dataDir, [
      row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }), // prior: $2/LPV
      row({ date: daysAgo(2), spend: 200, landingPageViews: 50 }) // current: $4/LPV, +100%
    ]);

    const candidates = collectDegradationCandidates(dataDir, { campaigns: CAMPAIGNS, now: NOW });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].campaign.campaignId, 'camp-1');
    assert.equal(candidates[0].rule.metric, 'cost_per_landing_page_view');
    assert.ok(candidates[0].result.breached);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectDegradationCandidates reports nothing when the metric has not degraded', () => {
  const dataDir = makeTempDataDir();
  try {
    landInsightsEvidence(dataDir, [
      row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }),
      row({ date: daysAgo(2), spend: 100, landingPageViews: 50 })
    ]);
    const candidates = collectDegradationCandidates(dataDir, { campaigns: CAMPAIGNS, now: NOW });
    assert.equal(candidates.length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectDegradationCandidates honors a configured opportunitySignalRules override instead of the default', () => {
  const dataDir = makeTempDataDir();
  try {
    landInsightsEvidence(dataDir, [
      row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }),
      row({ date: daysAgo(2), spend: 110, landingPageViews: 50 }) // +10%, below the 30% default but above a 5% custom rule
    ]);

    const defaultCandidates = collectDegradationCandidates(dataDir, { campaigns: CAMPAIGNS, now: NOW });
    assert.equal(defaultCandidates.length, 0);

    const customCandidates = collectDegradationCandidates(dataDir, {
      campaigns: CAMPAIGNS,
      rules: [{ metric: 'cost_per_landing_page_view', window_days: 7, degradation_pct: 0.05 }],
      now: NOW
    });
    assert.equal(customCandidates.length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recordDegradationSignal is idempotent within the same window period - a second scan finds no new candidate', () => {
  const dataDir = makeTempDataDir();
  try {
    landInsightsEvidence(dataDir, [
      row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }),
      row({ date: daysAgo(2), spend: 200, landingPageViews: 50 })
    ]);

    const first = collectDegradationCandidates(dataDir, { campaigns: CAMPAIGNS, now: NOW });
    assert.equal(first.length, 1);
    recordDegradationSignal(dataDir, first[0]);

    const second = collectDegradationCandidates(dataDir, { campaigns: CAMPAIGNS, now: NOW });
    assert.equal(second.length, 0);
    assert.equal(alreadySignaledIds(dataDir).size, 1);
    assert.equal(queryEvents(dataDir, { type: 'ad-performance.degradation_signal.detected' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a recorded degradation signal, run through opportunity.prospect, produces a grounded Opportunity', async () => {
  const dataDir = makeTempDataDir();
  try {
    landInsightsEvidence(dataDir, [
      row({ date: daysAgo(10), spend: 100, landingPageViews: 50 }),
      row({ date: daysAgo(2), spend: 200, landingPageViews: 50 })
    ]);
    const [candidate] = collectDegradationCandidates(dataDir, { campaigns: CAMPAIGNS, now: NOW });
    const { signalEvent, evidenceEvent } = recordDegradationSignal(dataDir, candidate);

    const draftCandidate = {
      type: 'product-opportunity',
      title: 'HVAC Scanner v3 cost per landing page view has doubled',
      description: 'Cost per landing page view rose from $2.00 to $4.00 over the last 7 days.',
      confidence: 0.8,
      rationale: 'Direct evidence from the Meta insights degradation signal.',
      evidenceEventIds: [evidenceEvent.id],
      counterparty: { kind: 'none', name: null, contactHint: null }
    };

    const { opportunities } = await runOpportunityEngine({
      instanceConfig: instanceConfig(),
      dataDir,
      triggerEvent: signalEvent,
      llmClient: async () => ({ text: JSON.stringify(draftCandidate) })
    });

    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].correlationId, signalEvent.correlationId);
    assert.ok(opportunities[0].sourceEventIds.includes(evidenceEvent.id));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
