// The one write path to Meta in this codebase - everything else under
// lib/research/ is read-only. Deliberately its own small module, not folded
// into metaInsights.js, so "this file can mutate a live ad account" stays
// obvious from the file list alone. Sits behind lib/actions/metaCampaignChange.js's
// FINANCIAL_ACTION gate (lib/authority/policy.js's "meta-campaign-change"
// entry, defined since before this session, waiting for exactly this).

const GRAPH_API_VERSION = 'v21.0';
const VALID_STATUSES = new Set(['ACTIVE', 'PAUSED']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function parseMetaErrorBody(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? text;
  } catch {
    return text;
  }
}

// GET first, write second - the same "never trust a cached/assumed prior
// state" discipline this codebase already uses for mandate status
// (currentAdMandateStatus): the caller gets back what the campaign's status
// actually was immediately before this call changed it, for the audit event.
export async function getMetaCampaignStatus({ token, campaignId, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('getMetaCampaignStatus requires a token');
  if (!campaignId) throw new Error('getMetaCampaignStatus requires a campaignId');

  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${campaignId}`);
  url.searchParams.set('fields', 'id,name,status,effective_status');
  url.searchParams.set('access_token', token);

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Meta campaign status lookup for ${campaignId} returned HTTP ${response.status}: ${await parseMetaErrorBody(response)}`);
  }
  const body = await response.json();
  return { id: body.id, name: body.name, status: body.status, effectiveStatus: body.effective_status };
}

// The one actual write: sets a campaign's top-level status to ACTIVE or
// PAUSED. Nothing else (budget, targeting, creative) - pause/resume is the
// narrowest possible real-money action, exactly what Chris Bloom asked for.
export async function setMetaCampaignStatus({ token, campaignId, status, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('setMetaCampaignStatus requires a token');
  if (!campaignId) throw new Error('setMetaCampaignStatus requires a campaignId');
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`setMetaCampaignStatus: status must be one of ${[...VALID_STATUSES].join(', ')}, got "${status}"`);
  }

  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${campaignId}`);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ status, access_token: token }).toString()
  });

  if (!response.ok) {
    throw new Error(`Meta campaign status change for ${campaignId} to ${status} returned HTTP ${response.status}: ${await parseMetaErrorBody(response)}`);
  }

  const body = await response.json();
  if (!isPlainObject(body) || body.success !== true) {
    throw new Error(`Meta did not confirm the status change for ${campaignId} to ${status}: ${JSON.stringify(body)}`);
  }

  return { campaignId, status, metaResponse: body };
}
