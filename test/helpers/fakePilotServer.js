import fs from 'node:fs';

export const FIXTURE_PATH = new URL('../fixtures/pilot-metrics.v1.json', import.meta.url);
export const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// A fake-transport seam: stands in for the ssh transport. `respond` is the JSON document (object or raw string) or a
// function of the call; `fail` makes it throw like an unreachable host. Records every call so tests can assert on the inputs.
export function fakePilotTransport({ respond = loadFixture, fail = null } = {}) {
  const calls = [];
  const transport = async (call) => {
    calls.push(call);
    if (fail) throw fail;
    const value = typeof respond === 'function' ? respond(call) : respond;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  transport.calls = calls;
  return transport;
}

// The fixture with section overrides merged in (one level deep).
export function metrics(overrides = {}) {
  const base = loadFixture();
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' ? { ...base[key], ...value } : value;
  }
  return base;
}

// A fully healthy product: overrides that undo every fixture problem.
export const HEALTHY = {
  funnel: { signups7d: 40 },
  usage: { errorsWindow: 0, refusalsWindow: {} },
  revenue: { packsSoldWindow: 2, disputesOpen: 0, frozenSubscriptions: 0, refundsWindow: 0, mrrUsd: 100 },
  cohorts: { signedUpNoDebate7d: 5, outOfCredits: 0, nearAllowance: 0, paymentFailed: 0, starterExpiringSoon: 0 },
  health: { billingAlarms: [], lastWebhookAgeMinutes: 20, lastDebateAgeMinutes: 10 }
};
