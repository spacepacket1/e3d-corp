import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createResearchAdapter } from '../lib/research/adapter.js';
import { fetchStripeRevenue } from '../lib/research/stripeRevenue.js';
import { recordStripeRevenueOutcome } from '../lib/outcomes/stripeRevenue.js';
import { verifyStripeSignature, loadStripeWebhookSecret } from '../lib/web/auth.js';
import { createRequestListener } from '../lib/web/server.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-stripe-'));
}

function okJsonResponse(body) {
  return { ok: true, async text() { return JSON.stringify(body); }, async json() { return body; } };
}

test('fetchStripeRevenue normalizes charge rows and converts cents to a decimal amount', async () => {
  const calls = [];
  const result = await fetchStripeRevenue({
    apiKey: 'sk_test_fake',
    lookbackDays: 7,
    fetchImpl: async (url, request) => {
      calls.push({ url: url.toString(), request });
      return okJsonResponse({
        data: [
          {
            id: 'ch_1',
            object: 'charge',
            status: 'succeeded',
            amount: 4999,
            currency: 'usd',
            customer: 'cus_1',
            billing_details: { email: 'buyer@example.com' },
            metadata: { correlationId: 'corr-1' },
            created: 1760000000,
            paid: true,
            refunded: false
          }
        ]
      });
    }
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].amount, 49.99);
  assert.equal(result.rows[0].customerEmail, 'buyer@example.com');
  assert.equal(result.rows[0].metadata.correlationId, 'corr-1');
  assert.match(calls[0].request.headers.authorization, /^Bearer sk_test_fake$/);
  assert.match(calls[0].url, /created%5Bgte%5D=/);
});

test('fetchStripeRevenue reports unavailable without a key, never calling fetch', async () => {
  let called = false;
  const result = await fetchStripeRevenue({ fetchImpl: async () => { called = true; return okJsonResponse({ data: [] }); } });
  assert.equal(result.status, 'unavailable');
  assert.equal(called, false);
});

test('research adapter lands pulled Stripe rows as an evidence.gathered event', async () => {
  const dataDir = makeTempDataDir();
  try {
    const adapter = createResearchAdapter({}, { dataDir });
    // No apiKey and no fetchImpl passthrough on the adapter today -
    // fetchStripeRevenue short-circuits to "unavailable" before ever
    // touching the network, same as pullMetaInsights with no adAccountId.
    // The point of this test is that even a degraded pull still lands as a
    // real evidence.gathered event, never silently dropped.
    const result = await adapter.pullStripeRevenue({ lookbackDays: 7 });
    assert.equal(result.status, 'unavailable');
    assert.ok(result.evidenceEventId);
    const events = queryEvents(dataDir, { type: 'evidence.gathered' });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'research.stripeRevenue');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function seedChainWithCorrelation(dataDir, correlationId) {
  return appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id: 'opp-stripe' },
    payload: { id: 'opp-stripe', type: 'product-opportunity', title: 'x', correlationId },
    correlationId
  });
}

function stripeEvent({ id = 'evt_1', type = 'charge.succeeded', correlationId, amount = 4999 } = {}) {
  return {
    id,
    type,
    created: 1760000000,
    data: {
      object: {
        id: 'ch_1',
        object: 'charge',
        amount,
        currency: 'usd',
        customer: 'cus_1',
        billing_details: { email: 'buyer@example.com' },
        metadata: correlationId ? { correlationId } : {}
      }
    }
  };
}

test('recordStripeRevenueOutcome attributes a Stripe event to the chain named in metadata.correlationId', () => {
  const dataDir = makeTempDataDir();
  try {
    seedChainWithCorrelation(dataDir, 'corr-stripe-1');
    const result = recordStripeRevenueOutcome(dataDir, stripeEvent({ correlationId: 'corr-stripe-1' }));

    assert.equal(result.outcome.type, 'invoice.paid');
    assert.equal(result.outcome.subjectCorrelationId, 'corr-stripe-1');
    assert.equal(result.outcome.payload.amount, 49.99);
    assert.equal(result.outcome.payload.stripeObjectId, 'ch_1');

    const events = queryEvents(dataDir, { type: 'invoice.paid' });
    assert.equal(events.length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recordStripeRevenueOutcome refuses an event with no metadata.correlationId, rather than guessing', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(() => recordStripeRevenueOutcome(dataDir, stripeEvent()), /no metadata\.correlationId/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recordStripeRevenueOutcome refuses an unmapped Stripe event type', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(
      () => recordStripeRevenueOutcome(dataDir, stripeEvent({ type: 'payout.created', correlationId: 'corr-x' })),
      /no mapped Outcome type/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verifyStripeSignature accepts a correctly-signed payload and rejects a tampered one or stale timestamp', () => {
  const secret = 'whsec_test_secret';
  const rawBody = '{"id":"evt_1","type":"charge.succeeded"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(verifyStripeSignature(rawBody, header, secret), true);
  assert.equal(verifyStripeSignature(`${rawBody}tampered`, header, secret), false);
  assert.equal(verifyStripeSignature(rawBody, header, 'wrong-secret'), false);

  const staleHeader = `t=${timestamp - 10_000},v1=${signature}`;
  assert.equal(verifyStripeSignature(rawBody, staleHeader, secret), false);
});

async function invokeRequest(listener, urlPath, { method = 'GET', headers = {}, body } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (body) req.write(body);
  req.end();

  let responseBody = '';
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(statusCode, headersToSet = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headersToSet)) this.headers[name.toLowerCase()] = value;
    },
    end(chunk = '') { responseBody += chunk; resolveDone(); }
  };

  await listener(req, res);
  await done;
  return { statusCode: res.statusCode, body: responseBody };
}

test('POST /webhooks/stripe rejects a bad signature, accepts a valid one, and returns attributed:false for an unmatched correlationId', async () => {
  const dataDir = makeTempDataDir();
  const previousSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET_TEST;
  const previousUser = process.env.FUTCO_WEB_USER_STRIPE_TEST;
  const previousPass = process.env.FUTCO_WEB_PASS_STRIPE_TEST;
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET_TEST = 'whsec_test_secret';
  process.env.FUTCO_WEB_USER_STRIPE_TEST = 'web-user';
  process.env.FUTCO_WEB_PASS_STRIPE_TEST = 'web-pass';

  try {
    const config = {
      web: { authUserEnvVar: 'FUTCO_WEB_USER_STRIPE_TEST', authPassEnvVar: 'FUTCO_WEB_PASS_STRIPE_TEST', port: 0 },
      stripeOutcomeWebhook: { signingSecretEnvVar: 'STRIPE_WEBHOOK_SIGNING_SECRET_TEST' }
    };
    const secret = loadStripeWebhookSecret(config);
    assert.equal(secret, 'whsec_test_secret');

    const listener = createRequestListener({ config, dataDir });
    const rawBody = JSON.stringify(stripeEvent({ id: 'evt_bad_sig' }));
    const badSig = await invokeRequest(listener, '/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      body: rawBody
    });
    assert.equal(badSig.statusCode, 401);

    const unmatchedBody = JSON.stringify(stripeEvent({ id: 'evt_unmatched', correlationId: 'corr-does-not-exist' }));
    const timestamp = Math.floor(Date.now() / 1000);
    const goodSig = crypto.createHmac('sha256', secret).update(`${timestamp}.${unmatchedBody}`).digest('hex');
    const accepted = await invokeRequest(listener, '/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${timestamp},v1=${goodSig}` },
      body: unmatchedBody
    });
    assert.equal(accepted.statusCode, 200);
    const acceptedParsed = JSON.parse(accepted.body);
    assert.equal(acceptedParsed.attributed, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET_TEST;
    else process.env.STRIPE_WEBHOOK_SIGNING_SECRET_TEST = previousSecret;
    if (previousUser === undefined) delete process.env.FUTCO_WEB_USER_STRIPE_TEST;
    else process.env.FUTCO_WEB_USER_STRIPE_TEST = previousUser;
    if (previousPass === undefined) delete process.env.FUTCO_WEB_PASS_STRIPE_TEST;
    else process.env.FUTCO_WEB_PASS_STRIPE_TEST = previousPass;
  }
});
