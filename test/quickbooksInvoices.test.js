import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents } from '../lib/events/store.js';
import { createResearchAdapter } from '../lib/research/adapter.js';
import { fetchQuickbooksInvoices } from '../lib/research/quickbooksInvoices.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-quickbooks-'));
}

function okJsonResponse(body) {
  return { ok: true, async text() { return JSON.stringify(body); }, async json() { return body; } };
}

function fakeFetchSequence(responses) {
  let call = 0;
  return async (url, request) => {
    const handler = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return handler(url, request);
  };
}

test('fetchQuickbooksInvoices refreshes the access token, then queries and normalizes invoices', async () => {
  const calls = [];
  const result = await fetchQuickbooksInvoices({
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-old',
    realmId: 'realm-1',
    lookbackDays: 7,
    fetchImpl: fakeFetchSequence([
      async (url, request) => {
        calls.push({ step: 'token', url: url.toString(), request });
        return okJsonResponse({
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 3600,
          x_refresh_token_expires_in: 8726400
        });
      },
      async (url, request) => {
        calls.push({ step: 'query', url: url.toString(), request });
        return okJsonResponse({
          QueryResponse: {
            Invoice: [
              {
                Id: '101',
                DocNumber: '1001',
                CustomerRef: { value: '1', name: 'Acme HVAC' },
                TotalAmt: 249.5,
                Balance: 0,
                CurrencyRef: { value: 'USD' },
                TxnDate: '2026-10-01',
                DueDate: '2026-10-15'
              }
            ]
          }
        });
      }
    ])
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].customerName, 'Acme HVAC');
  assert.equal(result.rows[0].totalAmt, 249.5);
  assert.equal(result.rows[0].paid, true);
  assert.equal(result.refreshedTokens.accessToken, 'access-new');
  assert.equal(result.refreshedTokens.refreshToken, 'refresh-new');

  assert.equal(calls[0].step, 'token');
  assert.match(calls[0].request.headers.authorization, /^Basic /);
  assert.equal(calls[1].step, 'query');
  assert.match(calls[1].request.headers.authorization, /^Bearer access-new$/);
  assert.match(calls[1].url, /sandbox-quickbooks\.api\.intuit\.com/);
});

test('fetchQuickbooksInvoices reports unavailable with incomplete credentials, never calling fetch', async () => {
  let called = false;
  const result = await fetchQuickbooksInvoices({
    clientId: 'client-1',
    fetchImpl: async () => { called = true; return okJsonResponse({}); }
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(called, false);
});

test('fetchQuickbooksInvoices reports unavailable when the token refresh fails', async () => {
  const result = await fetchQuickbooksInvoices({
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-old',
    realmId: 'realm-1',
    fetchImpl: async () => ({ ok: false, status: 401, async text() { return 'invalid_grant'; } })
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /token refresh returned HTTP 401/);
});

test('research adapter lands pulled QuickBooks invoice rows as an evidence.gathered event', async () => {
  const dataDir = makeTempDataDir();
  try {
    const adapter = createResearchAdapter({}, { dataDir });
    const result = await adapter.pullQuickbooksInvoices({ lookbackDays: 7 });
    assert.equal(result.status, 'unavailable');
    assert.ok(result.evidenceEventId);
    const events = queryEvents(dataDir, { type: 'evidence.gathered' });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'research.quickbooksInvoices');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
