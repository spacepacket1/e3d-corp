import { recordOutcome } from './record.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Maps a Stripe webhook event type to one of the fixed OUTCOME_TYPES
// (lib/outcomes/schema.js). Non-exhaustive on purpose - only the event types
// this loop currently cares about ("did we get paid", "did someone become a
// customer") are mapped; anything else is refused rather than guessed.
const STRIPE_EVENT_TYPE_MAP = Object.freeze({
  'charge.succeeded': 'invoice.paid',
  'invoice.paid': 'invoice.paid',
  'checkout.session.completed': 'customer.adopted',
  'customer.subscription.created': 'customer.adopted'
});

// Records a real Stripe revenue/signup event as an Outcome attributed to the
// campaign/opportunity chain that produced it - the manifesto's "Measure:
// Stripe outcomes attributed to the specific creative/campaign" step
// (docs/futco-ad-outcome-loop-manifesto.md in e3d-pilot). Mirrors
// lib/outcomes/tradeReturn.js's shape: fails closed exactly like
// recordOutcome itself already does when no correlationId is given or no
// chain exists for it.
//
// Attribution only works once whatever flow creates the Stripe object (a
// Checkout Session today) stamps `metadata.correlationId` with the
// originating opportunity's correlationId - that stamping happens outside
// e3d-corp, in the product's own checkout flow, and does not exist yet for
// any FutCo product as of 2026-10-11. Until a product does that, every real
// Stripe event here is refused with a clear reason rather than silently
// dropped or guessed at via fuzzy email matching - the raw revenue is still
// visible via lib/research/stripeRevenue.js's evidence.gathered poll either
// way, just not attributed to a specific chain.
export function recordStripeRevenueOutcome(dataDir, stripeEvent = {}) {
  const { id: stripeEventId, type: stripeEventType, data } = stripeEvent;
  if (!isNonEmptyString(stripeEventId)) {
    throw new Error('Stripe webhook payload is missing "id"');
  }
  if (!isNonEmptyString(stripeEventType)) {
    throw new Error('Stripe webhook payload is missing "type"');
  }

  const outcomeType = STRIPE_EVENT_TYPE_MAP[stripeEventType];
  if (!outcomeType) {
    throw new Error(
      `Stripe event type "${stripeEventType}" has no mapped Outcome type; refusing to guess (see STRIPE_EVENT_TYPE_MAP)`
    );
  }

  const object = data?.object;
  if (object === null || typeof object !== 'object') {
    throw new Error('Stripe webhook payload is missing "data.object"');
  }

  const correlationId = object.metadata?.correlationId;
  if (!isNonEmptyString(correlationId)) {
    throw new Error(
      `Stripe object ${object.id ?? '(no id)'} has no metadata.correlationId; cannot attribute to a campaign/opportunity chain`
    );
  }

  const amount = typeof object.amount === 'number' ? object.amount / 100 : (typeof object.amount_total === 'number' ? object.amount_total / 100 : null);

  return recordOutcome(dataDir, {
    id: stripeEventId,
    correlationId: correlationId.trim(),
    type: outcomeType,
    payload: {
      stripeEventId,
      stripeEventType,
      stripeObjectId: object.id ?? null,
      stripeObjectType: object.object ?? null,
      customerId: typeof object.customer === 'string' ? object.customer : null,
      customerEmail: object.customer_details?.email ?? object.billing_details?.email ?? object.receipt_email ?? null,
      amount,
      currency: object.currency ?? null
    },
    occurredAt: typeof stripeEvent.created === 'number' ? new Date(stripeEvent.created * 1000).toISOString() : undefined,
    source: 'webhook:stripe'
  });
}
