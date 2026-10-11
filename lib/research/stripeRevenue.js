const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function unavailableResult(reason) {
  return {
    status: 'unavailable',
    provider: 'stripe-revenue',
    reason,
    summary: reason,
    rowCount: 0,
    rows: []
  };
}

// Flattens a Stripe charge object down to the fields the outcome loop
// actually needs - amounts are cents in Stripe's API, converted to a decimal
// currency amount here so nothing downstream has to remember the convention.
// customerEmail is Stripe's own billing_details.email (present even for a
// one-off charge with no stored Customer object), kept separate from
// customerId so email-based correlation lookups never require a Customer to
// exist.
function normalizeCharge(charge) {
  return {
    id: charge.id,
    object: 'charge',
    status: charge.status,
    amount: typeof charge.amount === 'number' ? charge.amount / 100 : null,
    currency: charge.currency ?? null,
    customerId: typeof charge.customer === 'string' ? charge.customer : charge.customer?.id ?? null,
    customerEmail: charge.billing_details?.email ?? charge.receipt_email ?? null,
    description: charge.description ?? null,
    metadata: charge.metadata ?? {},
    created: typeof charge.created === 'number' ? new Date(charge.created * 1000).toISOString() : null,
    paid: charge.paid === true,
    refunded: charge.refunded === true
  };
}

// Pull-only, same trust level as lib/research/metaInsights.js: a GET with a
// bearer token (Stripe's secret key), never a write. Uses /v1/charges rather
// than /v1/events because charges already carry amount/customer/metadata in
// one flat object - no second lookup needed per row. Rolling-window like GA4
// and Meta insights (created[gte]), not cursor-paged: a short poll interval
// means stale/overlapping reads are fine and simpler than tracking a cursor.
export async function fetchStripeRevenue({ apiKey, lookbackDays, limit, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) {
    return unavailableResult('Stripe secret key is not configured');
  }

  const sinceSeconds = Math.floor(Date.now() / 1000) - (lookbackDays ?? 14) * 24 * 60 * 60;
  const url = new URL(`${STRIPE_API_BASE}/charges`);
  url.searchParams.set('created[gte]', String(sinceSeconds));
  url.searchParams.set('limit', String(Math.min(limit ?? 100, 100)));

  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` } });
  } catch (error) {
    return unavailableResult(`Stripe revenue request failed: ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? text;
    } catch {
      // keep the raw text if it isn't JSON
    }
    return unavailableResult(`Stripe revenue returned HTTP ${response.status}: ${message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return unavailableResult(`Stripe revenue returned invalid JSON: ${error.message}`);
  }

  const rows = Array.isArray(data.data) ? data.data.map(normalizeCharge) : [];
  return {
    status: 'ok',
    provider: 'stripe-revenue',
    query: { lookbackDays: lookbackDays ?? 14 },
    rowCount: rows.length,
    rows,
    summary: `${rows.length} charge(s) in the last ${lookbackDays ?? 14} day(s)`
  };
}
