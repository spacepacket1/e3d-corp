import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { queryEvents } from '../lib/events/store.js';
import { recordStressEvaluationReceived } from '../lib/event-sources/financialStressMonitor.js';
import { createRequestListener } from '../lib/web/server.js';
import { listExecutedActions } from '../lib/actions/log.js';
import { publishStressChange } from '../lib/actions/publishStressChange.js';
import { createE3dClient } from '../lib/e3d/client.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { listProposals, getProposal } from '../lib/proposals/store.js';
import { createProposal } from '../lib/proposals/create.js';
import { run } from '../lib/cli.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-financial-stress-'));
}

function makeTempInstance(extra = {}) {
  const root = process.cwd();
  const name = `financial-stress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(root, '.e3d-corp', 'instance', name);
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
        research: { webSearchProvider: 'disabled' },
        eventSources: [],
        roles: {},
        ...extra
      },
      null,
      2
    )
  );
  return { name, instanceDir, dataDir: path.join(root, dataDir) };
}

async function invokeRequest(listener, urlPath, { method = 'GET', headers = {}, body } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
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

function makeSubmission(overrides = {}) {
  return {
    event_id: 'stress-event-1',
    run_id: 'stress-run-1',
    material_change: true,
    score_before: 37,
    score_after: 63,
    liquidity_response_before: 'stable',
    liquidity_response_after: 'tightening',
    regime_before: 'normal',
    regime_after: 'stress',
    pipeline: {
      stage1_research: { summary: 'Liquidity indicators deteriorated.' },
      stage2_crosscheck: { agreement: 'agree' },
      stage3_narrative: { headline: 'Stress rising quickly.' }
    },
    ...overrides
  };
}

async function withWebhookEnv(fn) {
  const previous = {
    token: process.env.STRESS_EVAL_TOKEN_TEST,
    user: process.env.STRESS_EVAL_WEB_USER_TEST,
    pass: process.env.STRESS_EVAL_WEB_PASS_TEST
  };
  process.env.STRESS_EVAL_TOKEN_TEST = 'stress-secret';
  process.env.STRESS_EVAL_WEB_USER_TEST = 'web-user';
  process.env.STRESS_EVAL_WEB_PASS_TEST = 'web-pass';

  try {
    return await fn();
  } finally {
    if (previous.token === undefined) delete process.env.STRESS_EVAL_TOKEN_TEST;
    else process.env.STRESS_EVAL_TOKEN_TEST = previous.token;
    if (previous.user === undefined) delete process.env.STRESS_EVAL_WEB_USER_TEST;
    else process.env.STRESS_EVAL_WEB_USER_TEST = previous.user;
    if (previous.pass === undefined) delete process.env.STRESS_EVAL_WEB_PASS_TEST;
    else process.env.STRESS_EVAL_WEB_PASS_TEST = previous.pass;
  }
}

function makeListener(dataDir) {
  return createRequestListener({
    config: {
      web: { authUserEnvVar: 'STRESS_EVAL_WEB_USER_TEST', authPassEnvVar: 'STRESS_EVAL_WEB_PASS_TEST', port: 3000 },
      stressEvaluationWebhook: { tokenEnvVar: 'STRESS_EVAL_TOKEN_TEST' },
      e3d: { baseUrl: 'http://e3d.local' }
    },
    dataDir
  });
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function extractCsrfCookie(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const found = values.find((value) => value.startsWith('e3d_csrf='));
  return found?.match(/^e3d_csrf=([^;]+)/)?.[1] ?? null;
}

function extractCsrfField(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? null;
}

async function createStressProposalThroughWebhook(listener, overrides = {}) {
  const response = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
    method: 'POST',
    headers: {
      authorization: 'Bearer stress-secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify(makeSubmission(overrides))
  });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body).proposal_id;
}

async function captureOutput(fn) {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = (chunk, encoding, cb) => {
    stdout += String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof cb === 'function') cb();
    return true;
  };
  process.stderr.write = (chunk, encoding, cb) => {
    stderr += String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof cb === 'function') cb();
    return true;
  };
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test('recordStressEvaluationReceived rejects non-objects and is idempotent by run_id', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(
      () => recordStressEvaluationReceived(dataDir, null, { correlationId: 'stress-event-1' }),
      /Stress evaluation submission must be an object/
    );

    const first = recordStressEvaluationReceived(dataDir, makeSubmission(), { correlationId: 'stress-event-1' });
    const second = recordStressEvaluationReceived(dataDir, makeSubmission({ score_after: 70 }), {
      correlationId: 'stress-event-1'
    });

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.event.id, first.event.id);

    const events = queryEvents(dataDir, { type: 'financial-stress-evaluation.received' });
    assert.equal(events.length, 1);
    assert.equal(events[0].subject.id, 'stress-run-1');
    assert.equal(events[0].payload.score_after, 63);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('financial stress webhook creates one event and one proposal for a material change, even across duplicate deliveries', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    try {
      const listener = makeListener(dataDir);
      const body = JSON.stringify(makeSubmission());

      const first = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
        method: 'POST',
        headers: {
          authorization: 'Bearer stress-secret',
          'content-type': 'application/json'
        },
        body
      });
      assert.equal(first.statusCode, 200);
      assert.equal(JSON.parse(first.body).idempotent, false);

      const second = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
        method: 'POST',
        headers: {
          authorization: 'Bearer stress-secret',
          'content-type': 'application/json'
        },
        body
      });
      assert.equal(second.statusCode, 200);
      assert.equal(JSON.parse(second.body).idempotent, true);

      const intakeEvents = queryEvents(dataDir, { type: 'financial-stress-evaluation.received' });
      const proposalEvents = queryEvents(dataDir, { type: 'proposal.created' });
      const proposals = listProposals(dataDir, { type: 'publish-stress-change' });

      assert.equal(intakeEvents.length, 1);
      assert.equal(intakeEvents[0].correlationId, 'stress-event-1');
      assert.equal(proposalEvents.length, 1);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].authorityLevel, 4);
      assert.equal(proposals[0].payload.run_id, 'stress-run-1');
      assert.deepEqual(proposals[0].proposedBy, {
        role: 'financial-stress-pipeline',
        provider: 'e3d',
        model: 'financial-stress-pipeline-v1'
      });
      assert.equal(proposalEvents[0].causationId, intakeEvents[0].id);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('financial stress webhook stores a non-material evaluation without creating a proposal', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    try {
      const listener = makeListener(dataDir);
      const response = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
        method: 'POST',
        headers: {
          authorization: 'Bearer stress-secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify(makeSubmission({ event_id: 'stress-event-2', run_id: 'stress-run-2', material_change: false }))
      });

      assert.equal(response.statusCode, 200);
      assert.equal(queryEvents(dataDir, { type: 'financial-stress-evaluation.received' }).length, 1);
      assert.equal(listProposals(dataDir, { type: 'publish-stress-change' }).length, 0);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('financial stress webhook rejects missing bearer auth without touching the event log', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    try {
      const listener = makeListener(dataDir);
      const response = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(makeSubmission())
      });

      assert.equal(response.statusCode, 401);
      assert.equal(queryEvents(dataDir, { type: 'financial-stress-evaluation.received' }).length, 0);
      assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('financial stress proposal approval records reviewer correction before the fixed decision event', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    try {
      const listener = makeListener(dataDir);
      const intake = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
        method: 'POST',
        headers: {
          authorization: 'Bearer stress-secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify(makeSubmission())
      });
      const proposalId = JSON.parse(intake.body).proposal_id;
      const auth = basicAuthHeader('web-user', 'web-pass');

      const detail = await invokeRequest(listener, `/proposals/${proposalId}`, { headers: { authorization: auth } });
      const cookieToken = extractCsrfCookie(detail.headers['set-cookie']);
      const formToken = extractCsrfField(detail.body);
      assert.ok(cookieToken);
      assert.equal(formToken, cookieToken);

      const body = new URLSearchParams({
        reason: 'Approve after reviewer correction',
        finalScore: '68',
        finalLiquidityResponse: 'emergency-liquidity-watch',
        finalRegime: 'acute-stress',
        correctionNote: 'Adjusted for Friday funding pressure.',
        _csrf: formToken
      }).toString();
      const approve = await invokeRequest(listener, `/proposals/${proposalId}/approve`, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          cookie: `e3d_csrf=${cookieToken}`
        },
        body
      });

      assert.equal(approve.statusCode, 200);
      const correctionEvents = queryEvents(dataDir, { type: 'financial-stress-correction.submitted' });
      const createdEvent = queryEvents(dataDir, {
        type: 'proposal.created',
        subject: { type: 'proposal', id: proposalId }
      })[0];
      const approvedEvent = queryEvents(dataDir, { type: 'proposal.approved' })[0];

      assert.equal(correctionEvents.length, 1);
      assert.equal(correctionEvents[0].subject.id, proposalId);
      assert.equal(correctionEvents[0].causationId, createdEvent.id);
      assert.equal(correctionEvents[0].correlationId, createdEvent.correlationId);
      assert.deepEqual(correctionEvents[0].payload, {
        proposalId,
        finalScore: 68,
        finalLiquidityResponse: 'emergency-liquidity-watch',
        finalRegime: 'acute-stress',
        note: 'Adjusted for Friday funding pressure.'
      });
      assert.equal(approvedEvent.payload.finalScore, undefined);
      assert.equal(approvedEvent.payload.reason, 'Approve after reviewer correction');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('financial stress proposal detail shows triage summary with expandable stage breakdown', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    try {
      const listener = makeListener(dataDir);
      const intake = await invokeRequest(listener, '/webhooks/e3d-financial-stress-evaluation', {
        method: 'POST',
        headers: {
          authorization: 'Bearer stress-secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify(
          makeSubmission({
            pipeline: {
              stage1_research: { score: 63, evidence: ['SOFR pressure', 'discount-window uptake'] },
              stage2_crosscheck: { agreement: 'disagree', score: 58, flags: ['regional bank data lag'] },
              stage2b_adjudication: { summary: 'Use stage 1 direction but lower confidence.' },
              stage3_narrative: { headline: 'Funding pressure rose', narrative: 'Stress increased from normal levels.' }
            }
          })
        )
      });
      const proposalId = JSON.parse(intake.body).proposal_id;

      const detail = await invokeRequest(listener, `/proposals/${proposalId}`, {
        headers: { authorization: basicAuthHeader('web-user', 'web-pass') }
      });

      assert.equal(detail.statusCode, 200);
      assert.match(detail.body, /Financial stress triage/);
      assert.match(detail.body, /disagree/);
      assert.match(detail.body, /Three-stage breakdown/);
      assert.match(detail.body, /Stage 2b/);
      assert.match(detail.body, /name="finalScore"/);
      assert.ok(!detail.body.includes('<dt>payload</dt>'));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('confirming an approved financial stress proposal releases reviewer-corrected payload and lists the fired action', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    let calls = 0;
    let releasePayload;
    registerActionExecutor('publish-stress-change', (proposal, ctx) =>
      publishStressChange(proposal, {
        ...ctx,
        e3dClient: {
          async releaseFinancialStressChange(payload) {
            calls += 1;
            releasePayload = payload;
            return { accepted: true, release_id: 'release-1' };
          }
        }
      })
    );

    try {
      const listener = makeListener(dataDir);
      const proposalId = await createStressProposalThroughWebhook(listener);
      const auth = basicAuthHeader('web-user', 'web-pass');
      const detail = await invokeRequest(listener, `/proposals/${proposalId}`, { headers: { authorization: auth } });
      const csrf = extractCsrfField(detail.body);
      const cookie = extractCsrfCookie(detail.headers['set-cookie']);

      const approveBody = new URLSearchParams({
        reason: 'Release the corrected stress change',
        finalScore: '71',
        finalLiquidityResponse: 'liquidity-facility-watch',
        finalRegime: 'systemic-stress',
        correctionNote: 'Reviewer raised score after funding desk review.',
        _csrf: csrf
      }).toString();
      const approve = await invokeRequest(listener, `/proposals/${proposalId}/approve`, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(approveBody),
          cookie: `e3d_csrf=${cookie}`
        },
        body: approveBody
      });
      assert.equal(approve.statusCode, 200);

      const approved = getProposal(dataDir, proposalId);
      const result = await confirmAndExecute(dataDir, proposalId, 'chris', 'cli', {});
      const repeat = await confirmAndExecute(dataDir, proposalId, 'chris', 'cli', {});

      assert.equal(result.executionResult.published, true);
      assert.equal(repeat.executionResult.idempotent, true);
      assert.equal(calls, 1);
      assert.deepEqual(releasePayload, {
        run_id: 'stress-run-1',
        event_id: 'stress-event-1',
        final_score: 71,
        final_liquidity_response: 'liquidity-facility-watch',
        final_regime: 'systemic-stress',
        reviewer_correction_note: 'Reviewer raised score after funding desk review.'
      });

      const events = queryEvents(dataDir, { type: 'financial-stress-change.published' });
      assert.equal(events.length, 1);
      assert.equal(events[0].payload.success, true);
      assert.equal(events[0].causationId, queryEvents(dataDir, { type: 'proposal.approved' })[0].id);
      assert.equal(events[0].correlationId, approved.correlationId);

      const actions = listExecutedActions(dataDir);
      assert.equal(actions[0].type, 'financial-stress-change.published');
      assert.match(actions[0].summary, /financial stress change stress-run-1 published to e3d/);
    } finally {
      clearActionExecutor('publish-stress-change');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('financial stress release falls back to proposal draft values and retries 5xx before succeeding', async () => {
  const dataDir = makeTempDataDir();
  let releasePayload;
  registerActionExecutor('publish-stress-change', (proposal, ctx) =>
    publishStressChange(proposal, {
      ...ctx,
      e3dClient: {
        async releaseFinancialStressChange(payload) {
          releasePayload = payload;
          return { accepted: true, release_id: 'release-draft' };
        }
      }
    })
  );

  try {
    const intake = recordStressEvaluationReceived(dataDir, makeSubmission(), { correlationId: 'stress-event-1' });
    const { proposal } = createProposal(dataDir, {
      type: 'publish-stress-change',
      payload: makeSubmission(),
      proposedBy: { role: 'financial-stress-pipeline', provider: 'e3d', model: 'financial-stress-pipeline-v1' },
      causationId: intake.event.id,
      correlationId: 'stress-event-1',
      instanceConfig: {}
    });

    await decideProposal(dataDir, proposal.id, 'approved', 'Release draft values', 'chris', 'cli', {});
    await confirmAndExecute(dataDir, proposal.id, 'chris', 'cli', {});

    assert.deepEqual(releasePayload, {
      run_id: 'stress-run-1',
      event_id: 'stress-event-1',
      final_score: 63,
      final_liquidity_response: 'tightening',
      final_regime: 'stress',
      reviewer_correction_note: null
    });

    let attempts = 0;
    const client = createE3dClient(
      { baseUrl: 'http://e3d.local', timeoutMs: 50, maxAttempts: 3, apiKeyEnvVar: 'E3D_PHASE3_API_KEY' },
      {
        async fetchImpl(url, options) {
          attempts += 1;
          assert.equal(url, 'http://e3d.local/webhooks/e3d-financial-stress-evaluation/release');
          assert.equal(options.headers['Idempotency-Key'], 'release:stress-run-1:stress-event-1');
          assert.equal(options.headers['x-api-key'], 'phase3-key');
          assert.equal(options.headers['x-e3d-api-key'], 'phase3-key');
          const payload = JSON.parse(options.body);
          assert.equal(payload.final_score, 63);
          assert.equal(payload.final_liquidity_response, 'tightening');
          assert.equal(payload.final_regime, 'stress');
          assert.equal(payload.reviewer_correction_note, null);
          if (attempts < 3) {
            return new Response(JSON.stringify({ message: 'temporary stress outage' }), { status: 503 });
          }
          return new Response(JSON.stringify({ accepted: true, release_id: 'release-2' }), { status: 200 });
        }
      }
    );

    const previousKey = process.env.E3D_PHASE3_API_KEY;
    process.env.E3D_PHASE3_API_KEY = 'phase3-key';
    try {
      const ack = await client.releaseFinancialStressChange({
        run_id: 'stress-run-1',
        event_id: 'stress-event-1',
        final_score: 63,
        final_liquidity_response: 'tightening',
        final_regime: 'stress',
        reviewer_correction_note: null
      });
      assert.equal(ack.accepted, true);
      assert.equal(attempts, 3);
    } finally {
      if (previousKey === undefined) delete process.env.E3D_PHASE3_API_KEY;
      else process.env.E3D_PHASE3_API_KEY = previousKey;
    }
  } finally {
    clearActionExecutor('publish-stress-change');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('web rejection of a financial stress proposal sends exactly one reject callback', async () => {
  await withWebhookEnv(async () => {
    const dataDir = makeTempDataDir();
    const previousFetch = globalThis.fetch;
    const rejectBodies = [];
    globalThis.fetch = async (url, options) => {
      rejectBodies.push({ url, options });
      return new Response(JSON.stringify({ accepted: true, reject_id: 'reject-1' }), { status: 200 });
    };

    try {
      const listener = makeListener(dataDir);
      const proposalId = await createStressProposalThroughWebhook(listener);
      const auth = basicAuthHeader('web-user', 'web-pass');
      const detail = await invokeRequest(listener, `/proposals/${proposalId}`, { headers: { authorization: auth } });
      const csrf = extractCsrfField(detail.body);
      const cookie = extractCsrfCookie(detail.headers['set-cookie']);
      const body = new URLSearchParams({ reason: 'Do not publish yet', _csrf: csrf }).toString();

      const response = await invokeRequest(listener, `/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          cookie: `e3d_csrf=${cookie}`
        },
        body
      });

      assert.equal(response.statusCode, 200);
      assert.equal(rejectBodies.length, 1);
      assert.equal(rejectBodies[0].url, 'http://e3d.local/webhooks/e3d-financial-stress-evaluation/reject');
      assert.equal(rejectBodies[0].options.headers['Idempotency-Key'], 'reject:stress-run-1');
      assert.deepEqual(JSON.parse(rejectBodies[0].options.body), {
        run_id: 'stress-run-1',
        reason: 'Do not publish yet'
      });
    } finally {
      globalThis.fetch = previousFetch;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('CLI rejection of a financial stress proposal sends the reject callback after decision succeeds', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };

  const { name, instanceDir, dataDir } = makeTempInstance({
    e3d: { baseUrl: 'http://e3d.local' }
  });
  try {
    const intake = recordStressEvaluationReceived(dataDir, makeSubmission(), { correlationId: 'stress-event-1' });
    const { proposal } = createProposal(dataDir, {
      type: 'publish-stress-change',
      payload: makeSubmission(),
      proposedBy: { role: 'financial-stress-pipeline', provider: 'e3d', model: 'financial-stress-pipeline-v1' },
      causationId: intake.event.id,
      correlationId: 'stress-event-1',
      instanceConfig: {}
    });

    const output = await captureOutput(() =>
      run(['proposals', 'reject', proposal.id, '--reason', 'reject through cli', '--instance', name])
    );

    assert.equal(output.result, 0);
    assert.match(output.stdout, /rejected/);
    assert.equal(getProposal(dataDir, proposal.id).status, 'rejected');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://e3d.local/webhooks/e3d-financial-stress-evaluation/reject');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      run_id: 'stress-run-1',
      reason: 'reject through cli'
    });
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});
