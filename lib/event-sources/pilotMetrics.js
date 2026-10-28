import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendEvent, queryEvents } from '../events/store.js';
import { resolvePilotConfig, SCHEMA_VERSION } from '../pilot/config.js';

export const PILOT_SAMPLED_EVENT = 'pilot.metrics.sampled';
const SOURCE = 'research.pilot';

export class PilotMetricsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'PilotMetricsError';
    this.kind = kind;
  }
}

// ssh host is config, not user data, but it still must never be able to become an ssh option or a shell word.
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

// Default transport: `ssh` via execFile (no local shell, argv array). The remote command is the single trailing argument
// from config (research.pilot.remoteCommand); nothing from the metrics output or any other data is ever put in argv.
export function createSshTransport({ execFileImpl = execFile } = {}) {
  return function sshTransport({ host, keyFile, command, timeoutMs }) {
    if (!SAFE_HOST.test(host)) return Promise.reject(new PilotMetricsError('config', `research.pilot.sshHost "${host}" is not a plain host name`));
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
    if (keyFile) args.push('-i', keyFile, '-o', 'IdentitiesOnly=yes');
    args.push('--', host, command);
    return new Promise((resolve, reject) => {
      execFileImpl('ssh', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true || error.signal === 'SIGTERM';
          const detail = String(stderr || error.message).trim().split('\n').slice(-1)[0].slice(0, 300);
          reject(new PilotMetricsError(timedOut ? 'timeout' : 'ssh', `ssh to Pilot failed${timedOut ? ' (timeout)' : ''}: ${detail}`));
          return;
        }
        resolve(String(stdout));
      });
    });
  };
}

// Strict enough to refuse a wrong-shaped document, loose enough that any value may be null.
export function parsePilotMetrics(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PilotMetricsError('parse', 'pilot-metrics output was not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PilotMetricsError('parse', 'pilot-metrics output was not a JSON object');
  if (doc.schema !== SCHEMA_VERSION) throw new PilotMetricsError('schema', `pilot-metrics schema ${JSON.stringify(doc.schema)} is not supported (expected ${SCHEMA_VERSION})`);
  for (const key of ['funnel', 'usage', 'revenue', 'cohorts', 'health']) {
    if (doc[key] !== undefined && doc[key] !== null && (typeof doc[key] !== 'object' || Array.isArray(doc[key]))) {
      throw new PilotMetricsError('schema', `pilot-metrics "${key}" must be an object`);
    }
  }
  return {
    schema: doc.schema,
    generatedAt: doc.generatedAt ?? null,
    windowHours: doc.windowHours ?? null,
    funnel: doc.funnel ?? {},
    usage: doc.usage ?? {},
    revenue: doc.revenue ?? {},
    cohorts: doc.cohorts ?? {},
    health: doc.health ?? {},
    notes: Array.isArray(doc.notes) ? doc.notes.map(String) : []
  };
}

export function lastSuccessfulSample(dataDir) {
  const events = queryEvents(dataDir, { type: PILOT_SAMPLED_EVENT });
  return events[events.length - 1] ?? null;
}

function recordDegraded(dataDir, { error, now, cfg }) {
  return appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: SOURCE,
    subject: { type: 'research', id: crypto.randomUUID() },
    payload: {
      kind: 'pilot-metrics-sample',
      query: { sshHost: cfg.sshHost, windowHours: cfg.windowHours },
      resultSummary: `Pilot metrics unavailable (${error.kind ?? 'error'}): ${error.message}`,
      result: { status: 'unavailable', reason: error.kind ?? 'error', summary: error.message },
      degraded: true
    },
    causationId: null,
    correlationId: `pilot-sample-run:${crypto.randomUUID()}`,
    occurredAt: now.toISOString()
  });
}

// Authority level 0: read-only ingestion over ssh. Appends one `pilot.metrics.sampled` event holding the whole aggregate
// document (no PII by contract). An unreachable server or malformed output is recorded as degraded evidence and NEVER as
// numbers. A repeat call inside research.pilot.minPollIntervalMinutes makes no ssh call and returns { skipped: 'interval' }.
export async function samplePilotMetrics({ dataDir, instanceConfig, transport = createSshTransport(), now = new Date(), force = false } = {}) {
  if (!dataDir) throw new Error('samplePilotMetrics requires a dataDir');
  const cfg = resolvePilotConfig(instanceConfig);

  const last = lastSuccessfulSample(dataDir);
  if (!force && last && now.getTime() - new Date(last.occurredAt).getTime() < cfg.minPollIntervalMs) {
    return { skipped: 'interval', degraded: false, nextSampleAt: new Date(new Date(last.occurredAt).getTime() + cfg.minPollIntervalMs).toISOString(), event: last };
  }

  let metrics;
  try {
    const stdout = await transport({ host: cfg.sshHost, keyFile: cfg.sshKeyFile, command: cfg.remoteCommand, timeoutMs: cfg.timeoutMs });
    metrics = parsePilotMetrics(stdout);
  } catch (error) {
    if (!(error instanceof PilotMetricsError)) throw error;
    const event = recordDegraded(dataDir, { error, now, cfg });
    return { skipped: null, degraded: true, error: { kind: error.kind, message: error.message }, event };
  }

  const event = appendEvent(dataDir, {
    type: PILOT_SAMPLED_EVENT,
    source: SOURCE,
    subject: { type: 'pilot-metrics', id: crypto.randomUUID() },
    payload: { metrics, sampledAt: now.toISOString(), windowHours: metrics.windowHours ?? cfg.windowHours, degraded: false },
    causationId: null,
    correlationId: `pilot-metrics:${crypto.randomUUID()}`,
    occurredAt: now.toISOString()
  });
  return { skipped: null, degraded: false, event, metrics };
}
