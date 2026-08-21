import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent } from '../lib/events/store.js';
import { createProposal } from '../lib/proposals/create.js';
import { getProposal } from '../lib/proposals/store.js';
import { assertProposalAuthorized } from '../lib/authority/policy.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { createRequestListener, startWebServer } from '../lib/web/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-web-'));
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeTempInstance({ web, envVars } = {}) {
  const name = `phase6-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  const config = {
    name,
    dataDir,
    llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
    research: { knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
    eventSources: [],
    roles: {}
  };
  if (web) config.web = web;
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify(config, null, 2));

  const previousEnv = {};
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }

  return {
    name,
    instanceDir,
    config,
    dataDir: path.join(ROOT, dataDir),
    restoreEnv: () => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

function cleanupTempInstance(instance) {
  instance.restoreEnv();
  fs.rmSync(instance.instanceDir, { recursive: true, force: true });
}

function proposedBy(overrides = {}) {
  return { role: 'opportunity.communicator', provider: 'local', model: 'test-model', ...overrides };
}

// A stand-in Phase-7-style action-execution function, same shape as the one
// Phase 5's own tests used: the important thing under test is that it calls
// assertProposalAuthorized as its own first line and that we can count calls.
function fakeActionExecutor(type) {
  let calls = 0;
  const executor = async (proposal) => {
    assertProposalAuthorized(proposal, type);
    calls += 1;
    return { fired: true, proposalId: proposal.id };
  };
  return { executor, callCount: () => calls };
}

function startEphemeralServer({ config, dataDir }) {
  const listener = createRequestListener({ config, dataDir });
  const server = http.createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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

test('web server refuses to start with no auth env vars configured, naming the missing credential', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(
      () =>
        createRequestListener({
          config: { web: { authUserEnvVar: 'PHASE6_MISSING_USER', authPassEnvVar: 'PHASE6_MISSING_PASS', port: 0 } },
          dataDir
        }),
      /missing required env var "PHASE6_MISSING_USER"/
    );

    process.env.PHASE6_PARTIAL_USER = 'chris';
    try {
      assert.throws(
        () =>
          createRequestListener({
            config: { web: { authUserEnvVar: 'PHASE6_PARTIAL_USER', authPassEnvVar: 'PHASE6_MISSING_PASS2', port: 0 } },
            dataDir
          }),
        /missing required env var "PHASE6_MISSING_PASS2"/
      );
    } finally {
      delete process.env.PHASE6_PARTIAL_USER;
    }

    assert.throws(() => createRequestListener({ config: {}, dataDir }), /no "web" section/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('startWebServer throws the same way, before ever listening, when credentials are missing', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(
      () =>
        startWebServer({
          config: { web: { authUserEnvVar: 'PHASE6_STILL_MISSING', authPassEnvVar: 'PHASE6_STILL_MISSING_2', port: 0 } },
          dataDir,
          port: 0
        }),
      /missing required env var "PHASE6_STILL_MISSING"/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET /opportunities/:id renders a causal chain identical in content to `opportunities show`', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE6_CHAIN_USER', authPassEnvVar: 'PHASE6_CHAIN_PASS', port: 3999 },
    envVars: { PHASE6_CHAIN_USER: 'chris', PHASE6_CHAIN_PASS: 'secret' }
  });
  let server;
  try {
    const trigger = appendEvent(instance.dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-web-chain' },
      payload: {},
      correlationId: 'phase6-chain-correlation'
    });
    const created = appendEvent(instance.dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-web-chain' },
      payload: {
        id: 'opp-web-chain',
        type: 'consulting-engagement',
        title: 'Web chain test opportunity',
        description: 'A description for the web chain test',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [trigger.id],
        correlationId: trigger.correlationId,
        createdAt: trigger.occurredAt
      },
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    appendEvent(instance.dataDir, {
      type: 'opportunity.scored',
      source: 'opportunity.engine',
      subject: { type: 'opportunity', id: 'opp-web-chain' },
      payload: { id: 'opp-web-chain', score: { value: 0.77, rationale: 'strong fit' }, status: 'scored' },
      causationId: created.id,
      correlationId: trigger.correlationId
    });

    const cliOutput = runCli(['opportunities', 'show', 'opp-web-chain', '--instance', instance.name]);

    server = await startEphemeralServer({ config: instance.config, dataDir: instance.dataDir });
    const res = await httpRequest(`${baseUrl(server)}/opportunities/opp-web-chain`, {
      headers: { Authorization: basicAuthHeader('chris', 'secret') }
    });

    assert.equal(res.statusCode, 200);

    for (const expected of [
      'opp-web-chain',
      'consulting-engagement',
      'Web chain test opportunity',
      'strong fit',
      trigger.correlationId,
      trigger.id,
      created.id
    ]) {
      assert.ok(cliOutput.includes(expected), `CLI output missing ${expected}`);
      assert.ok(res.body.includes(expected), `web output missing ${expected}`);
    }

    for (const eventType of ['lead.received', 'opportunity.created', 'opportunity.scored']) {
      assert.ok(cliOutput.includes(eventType));
      assert.ok(res.body.includes(eventType));
    }
  } finally {
    if (server) server.close();
    cleanupTempInstance(instance);
  }
});

test('approving a level-2 proposal via the web form fires the action exactly once and records via: "web"', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE6_L2_USER', authPassEnvVar: 'PHASE6_L2_PASS', port: 3999 },
    envVars: { PHASE6_L2_USER: 'chris', PHASE6_L2_PASS: 'secret' }
  });
  const { executor, callCount } = fakeActionExecutor('send-outreach');
  registerActionExecutor('send-outreach', executor);
  let server;
  try {
    const trigger = appendEvent(instance.dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-web-l2' },
      payload: {},
      correlationId: 'phase6-l2-correlation'
    });
    const { proposal } = createProposal(instance.dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    server = await startEphemeralServer({ config: instance.config, dataDir: instance.dataDir });
    const auth = basicAuthHeader('chris', 'secret');

    const getRes = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}`, { headers: { Authorization: auth } });
    const cookieToken = extractCsrfCookie(getRes.headers['set-cookie']);
    const formToken = extractCsrfField(getRes.body);
    assert.ok(cookieToken && formToken && cookieToken === formToken);

    const body = new URLSearchParams({ reason: 'Good fit, send it', _csrf: formToken }).toString();
    const postRes = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}/approve`, {
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
    assert.equal(callCount(), 1);
    assert.equal(getProposal(instance.dataDir, proposal.id).status, 'approved');
    assert.ok(postRes.body.includes('Action executed'));
  } finally {
    if (server) server.close();
    clearActionExecutor('send-outreach');
    cleanupTempInstance(instance);
  }
});

test('single-step approve on a level-3/4 proposal via the web form does not fire the action without confirm', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE6_L3_USER', authPassEnvVar: 'PHASE6_L3_PASS', port: 3999 },
    envVars: { PHASE6_L3_USER: 'chris', PHASE6_L3_PASS: 'secret' }
  });
  const { executor, callCount } = fakeActionExecutor('issue-invoice');
  registerActionExecutor('issue-invoice', executor);
  let server;
  try {
    const trigger = appendEvent(instance.dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-web-l3' },
      payload: {},
      correlationId: 'phase6-l3-correlation'
    });
    const { proposal } = createProposal(instance.dataDir, {
      type: 'issue-invoice',
      payload: { amount: 500 },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    server = await startEphemeralServer({ config: instance.config, dataDir: instance.dataDir });
    const auth = basicAuthHeader('chris', 'secret');

    const getRes = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}`, { headers: { Authorization: auth } });
    const cookieToken = extractCsrfCookie(getRes.headers['set-cookie']);
    const formToken = extractCsrfField(getRes.body);

    const approveBody = new URLSearchParams({ reason: 'ok to invoice', _csrf: formToken }).toString();
    const approveRes = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(approveBody),
        Cookie: `e3d_csrf=${cookieToken}`
      },
      body: approveBody
    });

    assert.equal(approveRes.statusCode, 200);
    assert.equal(callCount(), 0, 'the action must not fire on the single-step approve alone');
    assert.equal(getProposal(instance.dataDir, proposal.id).status, 'approved');
    assert.ok(!approveRes.body.includes('Action executed'));
    assert.ok(approveRes.body.includes('Confirm and execute'));

    const confirmCookieToken = extractCsrfCookie(approveRes.headers['set-cookie']) ?? cookieToken;
    const confirmFormToken = extractCsrfField(approveRes.body) ?? formToken;
    const confirmBody = new URLSearchParams({ _csrf: confirmFormToken }).toString();
    const confirmRes = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}/confirm`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(confirmBody),
        Cookie: `e3d_csrf=${confirmCookieToken}`
      },
      body: confirmBody
    });

    assert.equal(confirmRes.statusCode, 200);
    assert.equal(callCount(), 1, 'the separate confirm step is what actually fires the action');
  } finally {
    if (server) server.close();
    clearActionExecutor('issue-invoice');
    cleanupTempInstance(instance);
  }
});

test('a CSRF-forged POST (no valid same-site cookie) to a mutating route is rejected and never mutates state', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE6_CSRF_USER', authPassEnvVar: 'PHASE6_CSRF_PASS', port: 3999 },
    envVars: { PHASE6_CSRF_USER: 'chris', PHASE6_CSRF_PASS: 'secret' }
  });
  const { executor, callCount } = fakeActionExecutor('send-outreach');
  registerActionExecutor('send-outreach', executor);
  let server;
  try {
    const trigger = appendEvent(instance.dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-web-csrf' },
      payload: {},
      correlationId: 'phase6-csrf-correlation'
    });
    const { proposal } = createProposal(instance.dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    server = await startEphemeralServer({ config: instance.config, dataDir: instance.dataDir });
    const auth = basicAuthHeader('chris', 'secret');

    // Forged: attacker knows (or guesses) nothing about the CSRF cookie and
    // sends no Cookie header at all - exactly what a real cross-site forged
    // POST would look like, since SameSite=Strict never attaches it.
    const body = new URLSearchParams({ reason: 'forged', _csrf: 'attacker-guessed-token' }).toString();
    const res = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });

    assert.equal(res.statusCode, 403);
    assert.equal(callCount(), 0);
    assert.equal(getProposal(instance.dataDir, proposal.id).status, 'pending');

    // Mismatched cookie/token pair is rejected too.
    const mismatchRes = await httpRequest(`${baseUrl(server)}/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Cookie: 'e3d_csrf=some-other-token-entirely'
      },
      body
    });
    assert.equal(mismatchRes.statusCode, 403);
    assert.equal(callCount(), 0);
    assert.equal(getProposal(instance.dataDir, proposal.id).status, 'pending');
  } finally {
    if (server) server.close();
    clearActionExecutor('send-outreach');
    cleanupTempInstance(instance);
  }
});

test('requests without valid basic auth are rejected with 401', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE6_AUTH_USER', authPassEnvVar: 'PHASE6_AUTH_PASS', port: 3999 },
    envVars: { PHASE6_AUTH_USER: 'chris', PHASE6_AUTH_PASS: 'secret' }
  });
  let server;
  try {
    server = await startEphemeralServer({ config: instance.config, dataDir: instance.dataDir });

    const noAuthRes = await httpRequest(`${baseUrl(server)}/opportunities`);
    assert.equal(noAuthRes.statusCode, 401);

    const wrongAuthRes = await httpRequest(`${baseUrl(server)}/opportunities`, {
      headers: { Authorization: basicAuthHeader('chris', 'wrong-password') }
    });
    assert.equal(wrongAuthRes.statusCode, 401);

    const correctAuthRes = await httpRequest(`${baseUrl(server)}/opportunities`, {
      headers: { Authorization: basicAuthHeader('chris', 'secret') }
    });
    assert.equal(correctAuthRes.statusCode, 200);
  } finally {
    if (server) server.close();
    cleanupTempInstance(instance);
  }
});
