// Read-only: when did Stripe last take a live payment? The webhook-silence signal compares this with Pilot's last
// received webhook, so a quiet week with no payments is not mistaken for a broken webhook.
// Returns epoch ms, null (Stripe reachable, no live charges), or undefined (cannot tell: no key, network or API error).
export async function fetchLatestStripeChargeAt({ instanceConfig, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const envVar = instanceConfig?.research?.stripe?.apiKeyEnvVar;
  const key = envVar ? env[envVar] : undefined;
  if (!key) return undefined;
  try {
    const res = await fetchImpl('https://api.stripe.com/v1/charges?limit=1', {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    const charge = Array.isArray(body?.data) ? body.data[0] : null;
    return charge && Number.isFinite(charge.created) ? charge.created * 1000 : null;
  } catch {
    return undefined;
  }
}
