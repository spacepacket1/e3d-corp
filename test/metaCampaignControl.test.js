import assert from 'node:assert/strict';
import test from 'node:test';
import { getMetaCampaignStatus, setMetaCampaignStatus } from '../lib/research/metaCampaignControl.js';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('getMetaCampaignStatus GETs the campaign and normalizes the fields', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    return jsonResponse(200, { id: 'camp-1', name: 'Test Campaign', status: 'ACTIVE', effective_status: 'ACTIVE' });
  };

  const result = await getMetaCampaignStatus({ token: 'tok', campaignId: 'camp-1', fetchImpl });
  assert.deepEqual(result, { id: 'camp-1', name: 'Test Campaign', status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/camp-1\?/);
  assert.match(calls[0], /access_token=tok/);
});

test('getMetaCampaignStatus throws with Meta\'s own error message on a non-OK response', async () => {
  const fetchImpl = async () => jsonResponse(400, { error: { message: 'Invalid OAuth access token' } });
  await assert.rejects(
    getMetaCampaignStatus({ token: 'bad', campaignId: 'camp-1', fetchImpl }),
    /Invalid OAuth access token/
  );
});

test('setMetaCampaignStatus POSTs status as form data and requires success:true', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url.toString(), init });
    return jsonResponse(200, { success: true });
  };

  const result = await setMetaCampaignStatus({ token: 'tok', campaignId: 'camp-1', status: 'PAUSED', fetchImpl });
  assert.deepEqual(result, { campaignId: 'camp-1', status: 'PAUSED', metaResponse: { success: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('status'), 'PAUSED');
  assert.equal(body.get('access_token'), 'tok');
});

test('setMetaCampaignStatus rejects an invalid status before ever calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(200, { success: true });
  };
  await assert.rejects(
    setMetaCampaignStatus({ token: 'tok', campaignId: 'camp-1', status: 'DELETED', fetchImpl }),
    /status must be one of/
  );
  assert.equal(called, false);
});

test('setMetaCampaignStatus throws when Meta does not confirm success', async () => {
  const fetchImpl = async () => jsonResponse(200, { success: false });
  await assert.rejects(
    setMetaCampaignStatus({ token: 'tok', campaignId: 'camp-1', status: 'ACTIVE', fetchImpl }),
    /did not confirm/
  );
});

test('setMetaCampaignStatus surfaces Meta\'s own error message on a non-OK response', async () => {
  const fetchImpl = async () => jsonResponse(403, { error: { message: 'Permissions error' } });
  await assert.rejects(
    setMetaCampaignStatus({ token: 'tok', campaignId: 'camp-1', status: 'PAUSED', fetchImpl }),
    /Permissions error/
  );
});
