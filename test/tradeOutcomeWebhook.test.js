import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createRequestListener } from '../lib/web/server.js';
import { readExperience } from '../lib/experience/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-trade-outcome-'));
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

function seedMandateChain(dataDir, correlationId = 'trade-outcome-correlation', mandateId = 'mandate-fixture-1') {
  const signal = appendEvent(dataDir, {
    type: 'investment.signal.detected',
    source: 'manual',
    subject: { type: 'market-signal', id: 'signal-1' },
    payload: { topic: 'AI infrastructure' },
    correlationId
  });
  const proposal = appendEvent(dataDir, {
    type: 'proposal.created',
    source: 'proposal.capital_mandate',
    subject: { type: 'proposal', id: 'proposal-1' },
    payload: {
      id: 'proposal-1',
      type: 'capital_mandate',
      status: 'approved',
      correlationId,
      createdAt: signal.occurredAt,
      payload: {
        mandate_id: mandateId,
        version: '1.0',
        owner: 'futco',
        status: 'approved',
        created_at: signal.occurredAt,
        approved_at: signal.occurredAt,
        correlation_id: correlationId,
        proposal_id: 'proposal-1',
        decision_id: 'decision-1',
        objective: 'Constrain paper trades.'
      }
    },
    causationId: signal.id,
    correlationId
  });
  const approved = appendEvent(dataDir, {
    type: 'proposal.approved',
    source: 'decision:cli',
    subject: { type: 'proposal', id: 'proposal-1' },
    payload: { decision: 'approved', reason: 'Go', decidedBy: 'chris', decisionId: 'decision-1', via: 'cli' },
    causationId: proposal.id,
    correlationId
  });
  return appendEvent(dataDir, {
    type: 'capital-mandate.submitted',
    source: 'action:capital_mandate',
    subject: { type: 'proposal', id: 'proposal-1' },
    payload: {
      proposalId: 'proposal-1',
      mandateId,
      owner: 'futco',
      previousStatus: 'approved',
      submittedStatus: 'active',
      tradeStatus: 'active',
      submittedAt: approved.occurredAt
    },
    causationId: approved.id,
    correlationId
  });
}

test('e3d-trade outcome webhook records an Outcome and Experience idempotently for a submitted mandate chain', async () => {
  const dataDir = makeTempDataDir();
  const previousToken = process.env.TRADE_OUTCOME_TOKEN_TEST;
  const previousUser = process.env.TRADE_OUTCOME_WEB_USER_TEST;
  const previousPass = process.env.TRADE_OUTCOME_WEB_PASS_TEST;
  process.env.TRADE_OUTCOME_TOKEN_TEST = 'secret-token';
  process.env.TRADE_OUTCOME_WEB_USER_TEST = 'web-user';
  process.env.TRADE_OUTCOME_WEB_PASS_TEST = 'web-pass';

  try {
    const submissionEvent = seedMandateChain(dataDir);
    const listener = createRequestListener({
      config: {
        web: { authUserEnvVar: 'TRADE_OUTCOME_WEB_USER_TEST', authPassEnvVar: 'TRADE_OUTCOME_WEB_PASS_TEST', port: 3000 },
        tradeOutcomeWebhook: { tokenEnvVar: 'TRADE_OUTCOME_TOKEN_TEST' }
      },
      dataDir
    });

    const body = JSON.stringify({
      outcome_id: 'outcome-trade-1',
      mandate_id: 'mandate-fixture-1',
      correlation_id: submissionEvent.correlationId,
      type: 'trade.executed',
      occurred_at: '2026-08-27T20:00:00.000Z',
      trade_id: 'trade-1',
      position_id: 'pos-1',
      symbol: 'AI',
      chain: 'base',
      side: 'buy',
      source_event_id: 'trade-log-1',
      portfolio_snapshot: { equity_usd: 101000, cash_usd: 94000, open_positions: 2 }
    });

    const first = await invokeRequest(listener, '/webhooks/e3d-trade-outcomes', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body
    });
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).idempotent, false);

    const second = await invokeRequest(listener, '/webhooks/e3d-trade-outcomes', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body
    });
    assert.equal(second.statusCode, 200);
    assert.equal(JSON.parse(second.body).idempotent, true);

    const outcomes = queryEvents(dataDir, { type: 'trade.executed', correlationId: submissionEvent.correlationId });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].payload.mandate_id, 'mandate-fixture-1');
    assert.equal(outcomes[0].payload.trade_id, 'trade-1');
    assert.equal(outcomes[0].causationId, submissionEvent.id);

    const experience = readExperience(dataDir, submissionEvent.correlationId);
    assert.equal(experience.outcome.type, 'trade.executed');
    assert.equal(experience.outcome.trade_id, 'trade-1');
  } finally {
    if (previousToken === undefined) delete process.env.TRADE_OUTCOME_TOKEN_TEST;
    else process.env.TRADE_OUTCOME_TOKEN_TEST = previousToken;
    if (previousUser === undefined) delete process.env.TRADE_OUTCOME_WEB_USER_TEST;
    else process.env.TRADE_OUTCOME_WEB_USER_TEST = previousUser;
    if (previousPass === undefined) delete process.env.TRADE_OUTCOME_WEB_PASS_TEST;
    else process.env.TRADE_OUTCOME_WEB_PASS_TEST = previousPass;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('e3d-trade outcome webhook rejects invalid auth and outcome-id conflicts', async () => {
  const dataDir = makeTempDataDir();
  const previousToken = process.env.TRADE_OUTCOME_TOKEN_TEST;
  const previousUser = process.env.TRADE_OUTCOME_WEB_USER_TEST;
  const previousPass = process.env.TRADE_OUTCOME_WEB_PASS_TEST;
  process.env.TRADE_OUTCOME_TOKEN_TEST = 'secret-token';
  process.env.TRADE_OUTCOME_WEB_USER_TEST = 'web-user';
  process.env.TRADE_OUTCOME_WEB_PASS_TEST = 'web-pass';

  try {
    seedMandateChain(dataDir);
    const listener = createRequestListener({
      config: {
        web: { authUserEnvVar: 'TRADE_OUTCOME_WEB_USER_TEST', authPassEnvVar: 'TRADE_OUTCOME_WEB_PASS_TEST', port: 3000 },
        tradeOutcomeWebhook: { tokenEnvVar: 'TRADE_OUTCOME_TOKEN_TEST' }
      },
      dataDir
    });

    const unauthorized = await invokeRequest(listener, '/webhooks/e3d-trade-outcomes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(unauthorized.statusCode, 401);

    const firstPayload = {
      outcome_id: 'outcome-realized-1',
      mandate_id: 'mandate-fixture-1',
      correlation_id: 'trade-outcome-correlation',
      type: 'trade.realized',
      occurred_at: '2026-08-27T21:00:00.000Z',
      trade_id: 'trade-1',
      pnl_usd: 120,
      outcome_label: 'profit'
    };
    const first = await invokeRequest(listener, '/webhooks/e3d-trade-outcomes', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(firstPayload)
    });
    assert.equal(first.statusCode, 200);

    const conflicting = await invokeRequest(listener, '/webhooks/e3d-trade-outcomes', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ...firstPayload, pnl_usd: 121 })
    });
    assert.equal(conflicting.statusCode, 400);
    assert.match(conflicting.body, /Outcome conflict/);
  } finally {
    if (previousToken === undefined) delete process.env.TRADE_OUTCOME_TOKEN_TEST;
    else process.env.TRADE_OUTCOME_TOKEN_TEST = previousToken;
    if (previousUser === undefined) delete process.env.TRADE_OUTCOME_WEB_USER_TEST;
    else process.env.TRADE_OUTCOME_WEB_USER_TEST = previousUser;
    if (previousPass === undefined) delete process.env.TRADE_OUTCOME_WEB_PASS_TEST;
    else process.env.TRADE_OUTCOME_WEB_PASS_TEST = previousPass;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
