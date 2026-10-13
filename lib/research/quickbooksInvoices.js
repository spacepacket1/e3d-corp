const OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_API_BASE = 'https://quickbooks.api.intuit.com';

function unavailableResult(reason) {
  return {
    status: 'unavailable',
    provider: 'quickbooks-invoices',
    reason,
    summary: reason,
    rowCount: 0,
    rows: []
  };
}

// QuickBooks access tokens expire in ~1hr (unlike Stripe's static secret key),
// so every pull mints a fresh one from the longer-lived refresh token first.
// Intuit returns a (possibly rotated) refresh_token alongside it - the caller
// is responsible for persisting result.refreshedTokens.refreshToken if it
// differs from what was passed in, or the next pull will fail once the old
// one is invalidated.
async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl }) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basicAuth}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QuickBooks token refresh returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

// Flattens a QBO Invoice entity to the fields an outcome/revenue loop
// actually needs, mirroring lib/research/stripeRevenue.js's normalizeCharge.
// "paid" is derived from Balance, not a status field QBO doesn't expose here.
function normalizeInvoice(invoice) {
  const totalAmt = typeof invoice.TotalAmt === 'number' ? invoice.TotalAmt : null;
  const balance = typeof invoice.Balance === 'number' ? invoice.Balance : null;
  return {
    id: invoice.Id,
    docNumber: invoice.DocNumber ?? null,
    customerId: invoice.CustomerRef?.value ?? null,
    customerName: invoice.CustomerRef?.name ?? null,
    totalAmt,
    balance,
    paid: totalAmt !== null && balance === 0,
    currency: invoice.CurrencyRef?.value ?? null,
    txnDate: invoice.TxnDate ?? null,
    dueDate: invoice.DueDate ?? null
  };
}

// Pull-only: the QBO Query endpoint is a GET, and the only "write" in this
// whole path is the token refresh, which rotates Intuit's own OAuth token,
// never company data. Rolling-window like stripeRevenue (TxnDate >=
// sinceDate), not cursor-paged - same reasoning: a short poll interval makes
// re-reading overlap fine and simpler than tracking a cursor through QBO's
// own invoice edits/voids.
export async function fetchQuickbooksInvoices({
  clientId,
  clientSecret,
  refreshToken,
  realmId,
  sandbox = true,
  lookbackDays,
  limit,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!clientId || !clientSecret || !refreshToken || !realmId) {
    return unavailableResult(
      'QuickBooks credentials are not fully configured (need clientId, clientSecret, refreshToken, realmId)'
    );
  }

  let tokenResponse;
  try {
    tokenResponse = await refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
  } catch (error) {
    return unavailableResult(`QuickBooks token refresh failed: ${error.message}`);
  }

  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    return unavailableResult('QuickBooks token refresh did not return an access_token');
  }

  const days = lookbackDays ?? 14;
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const maxResults = Math.min(limit ?? 100, 100);
  const apiBase = sandbox ? SANDBOX_API_BASE : PRODUCTION_API_BASE;
  const query = `SELECT * FROM Invoice WHERE TxnDate >= '${sinceDate}' MAXRESULTS ${maxResults}`;
  const url = new URL(`${apiBase}/v3/company/${realmId}/query`);
  url.searchParams.set('query', query);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
    });
  } catch (error) {
    return unavailableResult(`QuickBooks invoice query failed: ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    return unavailableResult(`QuickBooks invoice query returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return unavailableResult(`QuickBooks invoice query returned invalid JSON: ${error.message}`);
  }

  const rows = Array.isArray(data.QueryResponse?.Invoice) ? data.QueryResponse.Invoice.map(normalizeInvoice) : [];
  return {
    status: 'ok',
    provider: 'quickbooks-invoices',
    query: { lookbackDays: days, sandbox },
    rowCount: rows.length,
    rows,
    summary: `${rows.length} invoice(s) since ${sinceDate}`,
    refreshedTokens: {
      accessToken,
      refreshToken: tokenResponse.refresh_token ?? refreshToken,
      expiresIn: tokenResponse.expires_in ?? null,
      refreshTokenExpiresIn: tokenResponse.x_refresh_token_expires_in ?? null
    }
  };
}
