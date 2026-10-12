import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { proposeAdMandate } from '../lib/proposals/adMandate.js';
import { activateAdMandate } from '../lib/actions/adMandate.js';
import { proposeCommissionCreative } from '../lib/proposals/commissionCreative.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { autoDecideUnderMandate } from '../lib/decisions/autoDecideUnderMandate.js';
import { transitionAdMandateLifecycle } from '../lib/actions/adMandateLifecycle.js';
import { getProposal } from '../lib/proposals/store.js';
import { createRequestListener } from '../lib/web/server.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-ad-mandate-lifecycle-'));
}

function seedPursuingProductOpportunity(dataDir, { opportunityId = `opp-${Math.random().toString(36).slice(2)}` } = {}) {
  const correlationId = `lifecycle-${opportunityId}`;
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
    payload: { id: opportunityId, type: 'product-opportunity', title: 'HVAC CPL creeping up', correlationId },
    causationId: signal.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth a mandate', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });

  return { id: opportunityId, type: 'product-opportunity', title: 'HVAC CPL creeping up', status: 'pursuing', correlationId };
}

function validAdMandate(overrides = {}) {
  return {
    owner: 'futco',
    expires_at: '2026-12-31T00:00:00.000Z',
    thesis_refs: ['thesis-hvac-cpl-creep'],
    objective: 'Keep HVAC scanner CPL under control while testing new creative variants.',
    constraints: {
      max_daily_spend_usd: 150,
      max_monthly_spend_usd: 3000,
      max_cpl_usd: 40,
      max_cac_usd: null,
      allowed_products: ['oppscan'],
      allowed_campaign_ids: null,
      pause_on_metric_degradation: [{ metric: 'cpl_usd', window_days: 7, degradation_pct: 0.4 }],
      paper_only_creative: true
    },
    preferences: {},
    confidence: 0.7,
    invalidation: 'Invalidate if CPL stabilizes without intervention.',
    ...overrides
  };
}

const adRiskPolicy = { max_daily_spend_usd: 500, max_monthly_spend_usd: 10000 };

async function activeMandateProposal(dataDir, mandateOverrides = {}) {
  const opportunity = seedPursuingProductOpportunity(dataDir);
  const { proposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate(mandateOverrides) });
  await decideProposal(dataDir, proposal.id, 'approved', 'Set a spend envelope', 'chris', 'cli');
  const approved = getProposal(dataDir, proposal.id);
  await activateAdMandate(approved, { dataDir, instanceConfig: { adRiskPolicy } });
  return getProposal(dataDir, proposal.id);
}

test('transitionAdMandateLifecycle suspends an active mandate and folds status accordingly', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    const result = await transitionAdMandateLifecycle(dataDir, {
      mandateProposalId: mandateProposal.id,
      toStatus: 'suspended',
      reason: 'Pausing while we review CPL',
      decidedBy: 'chris',
      via: 'cli'
    });

    assert.equal(result.transitioned, true);
    assert.equal(result.previousStatus, 'active');
    assert.equal(result.toStatus, 'suspended');

    const reloaded = getProposal(dataDir, mandateProposal.id);
    assert.equal(reloaded.payload.status, 'suspended');

    const events = queryEvents(dataDir, { type: 'ad-mandate.suspended' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.decidedBy, 'chris');
    assert.equal(events[0].payload.via, 'cli');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('transitionAdMandateLifecycle refuses to suspend a mandate that is not yet active', async () => {
  const dataDir = makeTempDataDir();
  try {
    const opportunity = seedPursuingProductOpportunity(dataDir);
    const { proposal } = proposeAdMandate(dataDir, { opportunity, mandate: validAdMandate() });

    await assert.rejects(
      transitionAdMandateLifecycle(dataDir, {
        mandateProposalId: proposal.id,
        toStatus: 'suspended',
        reason: 'test',
        decidedBy: 'chris',
        via: 'cli'
      }),
      /cannot transition/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('revoke is terminal - a revoked mandate cannot later be suspended', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    await transitionAdMandateLifecycle(dataDir, {
      mandateProposalId: mandateProposal.id,
      toStatus: 'revoked',
      reason: 'No longer needed',
      decidedBy: 'chris',
      via: 'cli'
    });

    assert.equal(getProposal(dataDir, mandateProposal.id).payload.status, 'revoked');

    await assert.rejects(
      transitionAdMandateLifecycle(dataDir, {
        mandateProposalId: mandateProposal.id,
        toStatus: 'suspended',
        reason: 'too late',
        decidedBy: 'chris',
        via: 'cli'
      }),
      /cannot transition/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a custom eventType (auto-suspend) folds to the same suspended status, distinguishable in the event log', async () => {
  const dataDir = makeTempDataDir();
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    await transitionAdMandateLifecycle(dataDir, {
      mandateProposalId: mandateProposal.id,
      toStatus: 'suspended',
      eventType: 'ad-mandate.auto-suspended',
      reason: 'cpl_usd degraded 52% over 7 days (breach of pause_on_metric_degradation)',
      decidedBy: 'system:ad-mandate-health-check',
      via: 'autonomous-health-check'
    });

    assert.equal(getProposal(dataDir, mandateProposal.id).payload.status, 'suspended');
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.auto-suspended' }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'ad-mandate.suspended' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the kill switch stops autonomous decisions on the next check (integration with autoDecideUnderMandate)', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('commission-creative', async () => ({ commissioned: true }));
  try {
    const mandateProposal = await activeMandateProposal(dataDir);
    const opportunity = seedPursuingProductOpportunity(dataDir);
    const { proposal: commissionProposal } = proposeCommissionCreative(dataDir, {
      opportunity,
      brief: { product: 'oppscan', audience: 'a', objective: 'o', constraints: [] },
      reason: 'test'
    });

    await transitionAdMandateLifecycle(dataDir, {
      mandateProposalId: mandateProposal.id,
      toStatus: 'suspended',
      reason: 'kill switch',
      decidedBy: 'chris',
      via: 'cli'
    });

    await assert.rejects(
      autoDecideUnderMandate(dataDir, commissionProposal.id, mandateProposal.id, { adRiskPolicy }),
      /not active/
    );
    assert.equal(getProposal(dataDir, commissionProposal.id).status, 'pending');
  } finally {
    clearActionExecutor('commission-creative');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- Web UI surface ---

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function invokeRequest(listener, { url, method = 'GET', headers = {}, body } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (body) req.write(body);
  req.end();

  let responseBody = '';
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headersToSet = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headersToSet)) {
        this.headers[name.toLowerCase()] = value;
      }
    },
    end(chunk = '') {
      responseBody += chunk;
      resolveDone();
    }
  };

  await listener(req, res);
  await done;
  return { statusCode: res.statusCode, headers: res.headers, body: responseBody };
}

function extractCsrfCookie(setCookieHeaders) {
  if (!setCookieHeaders) return undefined;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const entry of list) {
    const match = entry.match(/e3d_csrf=([0-9a-f]+)/);
    if (match) return match[1];
  }
  return undefined;
}

function extractCsrfField(html) {
  const match = html.match(/name="_csrf" value="([0-9a-f]+)"/);
  return match ? match[1] : undefined;
}

function makeWebInstance() {
  const name = `ad-mandate-lifecycle-web-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(process.cwd(), '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  const config = {
    name,
    dataDir,
    llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' } } },
    research: { knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
    eventSources: [],
    roles: {},
    web: { authUserEnvVar: 'AD_MANDATE_LIFECYCLE_WEB_USER', authPassEnvVar: 'AD_MANDATE_LIFECYCLE_WEB_PASS' }
  };
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify(config, null, 2));
  process.env.AD_MANDATE_LIFECYCLE_WEB_USER = 'chris';
  process.env.AD_MANDATE_LIFECYCLE_WEB_PASS = 'secret';
  return { instanceDir, config, dataDir: path.join(process.cwd(), dataDir) };
}

test('web UI: the kill switch shows on an active ad_mandate proposal page and suspends it on submit', async () => {
  const instance = makeWebInstance();
  try {
    const mandateProposal = await activeMandateProposal(instance.dataDir);
    const listener = createRequestListener({ config: instance.config, dataDir: instance.dataDir });
    const auth = basicAuthHeader('chris', 'secret');

    const getRes = await invokeRequest(listener, { url: `/proposals/${mandateProposal.id}`, headers: { Authorization: auth } });
    assert.equal(getRes.statusCode, 200);
    assert.ok(getRes.body.includes('Kill switch'));
    assert.ok(getRes.body.includes('suspend-mandate'));

    const cookieToken = extractCsrfCookie(getRes.headers['set-cookie']);
    const formToken = extractCsrfField(getRes.body);
    const body = new URLSearchParams({ reason: 'CPL spiked', _csrf: formToken }).toString();

    const postRes = await invokeRequest(listener, {
      url: `/proposals/${mandateProposal.id}/suspend-mandate`,
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Cookie: `e3d_csrf=${cookieToken}`
      },
      body
    });

    assert.equal(postRes.statusCode, 200);
    assert.equal(getProposal(instance.dataDir, mandateProposal.id).payload.status, 'suspended');

    const getAfter = await invokeRequest(listener, { url: `/proposals/${mandateProposal.id}`, headers: { Authorization: auth } });
    assert.ok(!getAfter.body.includes('Kill switch'));
  } finally {
    delete process.env.AD_MANDATE_LIFECYCLE_WEB_USER;
    delete process.env.AD_MANDATE_LIFECYCLE_WEB_PASS;
    fs.rmSync(instance.instanceDir, { recursive: true, force: true });
  }
});
