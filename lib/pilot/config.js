// Config and thresholds for the Pilot monitor (docs/pilot-monitor.md). Same stance as lib/youtube/thresholds.js: none of
// these commit money; getting one slightly wrong only changes WHEN a human is asked to look, so documented defaults are
// fine and every one is overridable under research.pilot.thresholds.
export const SCHEMA_VERSION = 1;

export const DEFAULT_THRESHOLDS = Object.freeze({
  // Signup drop: signups in the last 7d vs the 7d total sampled ~7 days ago. Needs a baseline of at least this many.
  signupDropMinBaseline: 10,
  signupDropMaxRatio: 0.5,
  // Activation gap: share of signups in the window with no first debate, once there are enough signups to judge.
  activationGapMinSignups: 5,
  activationGapMaxRate: 0.5,
  // Purchase stall: this many verified users (cumulative) and a purchase/verified rate under the floor, no purchase in the window.
  purchaseStallMinVerified: 25,
  purchaseStallMaxRate: 0.02,
  // Error / refusal spike in the window, relative to debates (and an absolute floor so tiny numbers never fire).
  errorSpikeMinCount: 3,
  errorSpikeMinRate: 0.1,
  refusalSpikeMinCount: 5,
  refusalSpikeMinRate: 0.2,
  // Webhook silence while the product is otherwise live (debates in the 7d window).
  webhookSilenceMinutes: 360,
  // Refund spike in the window.
  refundSpikeMinCount: 2,
  refundSpikeMinRate: 0.2,
  // MRR change vs the sample ~7 days ago, as a fraction of the earlier value (and an absolute floor in USD).
  mrrChangeMinFraction: 0.1,
  mrrChangeMinUsd: 20,
  // Retention cohorts: smallest cohort worth raising.
  cohortMinCount: 1,
  // Hours of tolerance when looking for the sample "N days ago".
  baselineToleranceHours: 12,
  // Re-raise the same condition at most once per this many hours (per kind), so a persistent problem is one
  // Opportunity per cooldown, not one per poll, yet resurfaces instead of being silenced forever.
  cooldownHoursHealth: 24,
  cooldownHoursTrend: 72,
  cooldownHoursCohort: 168
});

export function resolveThresholds(overrides = {}) {
  const merged = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key in DEFAULT_THRESHOLDS && typeof value === 'number' && Number.isFinite(value) && value >= 0) merged[key] = value;
  }
  return merged;
}

const DEFAULTS = Object.freeze({ windowHours: 24, minPollIntervalMinutes: 25, timeoutSeconds: 30 });

export function resolvePilotConfig(instanceConfig) {
  const pilot = instanceConfig?.research?.pilot;
  if (!pilot || typeof pilot.sshHost !== 'string' || pilot.sshHost.trim() === '') {
    throw new Error('research.pilot.sshHost is not configured; the Pilot monitor has nothing to monitor');
  }
  if (typeof pilot.remoteCommand !== 'string' || pilot.remoteCommand.trim() === '') {
    throw new Error('research.pilot.remoteCommand is not configured');
  }
  return {
    sshHost: pilot.sshHost.trim(),
    sshKeyFile: typeof pilot.sshKeyFile === 'string' && pilot.sshKeyFile.trim() !== '' ? pilot.sshKeyFile.trim() : null,
    remoteCommand: pilot.remoteCommand.trim(),
    windowHours: pilot.windowHours ?? DEFAULTS.windowHours,
    minPollIntervalMs: (pilot.minPollIntervalMinutes ?? DEFAULTS.minPollIntervalMinutes) * 60_000,
    timeoutMs: (pilot.timeoutSeconds ?? DEFAULTS.timeoutSeconds) * 1000,
    thresholds: resolveThresholds(pilot.thresholds),
    typeWeights: pilot.typeWeights ?? {}
  };
}

export function isPilotConfigured(instanceConfig) {
  const pilot = instanceConfig?.research?.pilot;
  return Boolean(pilot && typeof pilot.sshHost === 'string' && pilot.sshHost.trim() !== '');
}
