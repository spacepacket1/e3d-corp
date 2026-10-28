import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents, verifyEventChain } from '../lib/events/store.js';
import { createSshTransport, samplePilotMetrics, parsePilotMetrics, PilotMetricsError } from '../lib/event-sources/pilotMetrics.js';
import { scanPilotSignals, PILOT_OPPORTUNITY_TYPES } from '../lib/opportunities/pilotOpportunities.js';
import { listOpportunities } from '../lib/opportunities/store.js';
import { reconstructChain } from '../lib/events/chain.js';
import { runPilotPoll } from '../lib/pilot/poll.js';
import { recordPilotRevenueOutcome } from '../lib/pilot/revenue.js';
import { buildPilotSummary, formatPilotSummaryText } from '../lib/pilot/summary.js';
import { validateInstanceConfig } from '../lib/config.js';
import { fakePilotTransport, loadFixture, metrics, HEALTHY } from './helpers/fakePilotServer.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const H = 3_600_000;
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * H);
const config = (extra = {}) => ({ research: { pilot: { sshHost: 'pilot.test', sshKeyFile: '/nonexistent/key', remoteCommand: 'node ops/pilot-metrics.js', ...extra } } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilot-'));

async function sampleAt(dataDir, doc, when, extra) {
  const r = await samplePilotMetrics({ dataDir, instanceConfig: config(extra), transport: fakePilotTransport({ respond: doc }), now: when, force: true });
  assert.equal(r.degraded, false);
  return r;
}
const healthy = (o = {}) => metrics(Object.fromEntries(Object.entries(HEALTHY).map(([k, v]) => [k, { ...v, ...(o[k] ?? {}) }])));
const kinds = (result) => result.created.map((o) => o.signal.kind).sort();

test('sampling records one pilot.metrics.sampled event with the document and the config-supplied ssh call', async () => {
  const dataDir = tmp();
  try {
    const transport = fakePilotTransport();
    const r = await samplePilotMetrics({ dataDir, instanceConfig: config(), transport, now: NOW });
    assert.equal(r.degraded, false);
    assert.deepEqual(transport.calls[0], { host: 'pilot.test', keyFile: '/nonexistent/key', command: 'node ops/pilot-metrics.js', timeoutMs: 30000 });
    const [event] = queryEvents(dataDir, { type: 'pilot.metrics.sampled' });
    assert.equal(event.source, 'research.pilot');
    assert.equal(event.payload.metrics.funnel.signupsTotal, 240);
    assert.equal(event.payload.degraded, false);
    assert.equal(verifyEventChain(dataDir).valid, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the poll interval gate makes no second call; --force does', async () => {
  const dataDir = tmp();
  try {
    const transport = fakePilotTransport();
    await samplePilotMetrics({ dataDir, instanceConfig: config(), transport, now: NOW });
    const again = await samplePilotMetrics({ dataDir, instanceConfig: config(), transport, now: new Date(NOW.getTime() + 10 * 60_000) });
    assert.equal(again.skipped, 'interval');
    assert.equal(transport.calls.length, 1);
    await samplePilotMetrics({ dataDir, instanceConfig: config(), transport, now: new Date(NOW.getTime() + 30 * 60_000) });
    assert.equal(transport.calls.length, 2);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('unreachable, malformed and wrong-schema output are degraded evidence, never numbers', async () => {
  for (const transport of [
    fakePilotTransport({ fail: new PilotMetricsError('ssh', 'ssh to Pilot failed: connection refused') }),
    fakePilotTransport({ respond: 'not json' }),
    fakePilotTransport({ respond: { ...loadFixture(), schema: 2 } })
  ]) {
    const dataDir = tmp();
    try {
      const r = await samplePilotMetrics({ dataDir, instanceConfig: config(), transport, now: NOW });
      assert.equal(r.degraded, true);
      assert.equal(queryEvents(dataDir, { type: 'pilot.metrics.sampled' }).length, 0);
      const [evidence] = queryEvents(dataDir, { type: 'evidence.gathered' });
      assert.equal(evidence.payload.degraded, true);
      assert.equal(evidence.payload.result.status, 'unavailable');
      assert.equal(scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW }).created.length, 0);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test('ssh transport: argv array only, key and host from config, option-looking hosts refused', async () => {
  let seen = null;
  const t = createSshTransport({ execFileImpl: (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, '{"schema":1}', ''); } });
  await t({ host: 'pilot.test', keyFile: '/k', command: 'node ops/pilot-metrics.js; echo $(x)', timeoutMs: 5000 });
  assert.equal(seen.cmd, 'ssh');
  assert.ok(seen.args.includes('BatchMode=yes'));
  assert.deepEqual(seen.args.slice(-3), ['--', 'pilot.test', 'node ops/pilot-metrics.js; echo $(x)']);
  assert.equal(seen.opts.timeout, 5000);
  assert.equal(seen.opts.shell, undefined);
  await assert.rejects(t({ host: '-oProxyCommand=evil', keyFile: null, command: 'x', timeoutMs: 1 }), /plain host name/);
  const failing = createSshTransport({ execFileImpl: (c, a, o, cb) => cb(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), '', '') });
  await assert.rejects(failing({ host: 'h', keyFile: null, command: 'x', timeoutMs: 1 }), (e) => e.kind === 'timeout');
  assert.throws(() => parsePilotMetrics('[]'), PilotMetricsError);
});

test('a healthy product raises nothing', async () => {
  const dataDir = tmp();
  try {
    await sampleAt(dataDir, healthy({ funnel: { signups7d: 40 } }), at(24 * 7));
    await sampleAt(dataDir, healthy(), NOW);
    const r = scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.deepEqual(r.created, []);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the fixture trips health, funnel and retention signals, each scored and citing real sampled events', async () => {
  const dataDir = tmp();
  try {
    const { event } = await sampleAt(dataDir, loadFixture(), NOW);
    const r = scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.equal(r.noBaseline, true);
    assert.deepEqual(kinds(r), ['activationGap', 'billingAlarm', 'disputesFrozen', 'errorSpike', 'purchaseStall', 'refusalSpike', 'retention', 'retention', 'retention', 'webhookSilence'].sort());
    for (const opp of r.created) {
      assert.equal(opp.status, 'scored');
      assert.equal(opp.pursuable, false);
      assert.ok(opp.score.value > 0 && opp.score.value <= 1);
      assert.ok(opp.evidence.includes(event.id), 'cites the sample event');
      const ev = queryEvents(dataDir, { type: 'evidence.gathered' }).find((e) => opp.evidence.includes(e.id));
      assert.equal(ev.payload.kind, 'pilot-metrics-signal');
      assert.equal(ev.payload.degraded, false);
      assert.deepEqual(reconstructChain(dataDir, opp.correlationId).map((e) => e.type), ['evidence.gathered', 'pilot.signal.detected', 'opportunity.created', 'opportunity.scored']);
    }
    const retention = r.created.filter((o) => o.type === PILOT_OPPORTUNITY_TYPES.retention).map((o) => o.signal.cohort).sort();
    assert.deepEqual(retention, ['outOfCredits', 'paymentFailed', 'starterExpiringSoon']);
    assert.equal(r.created.find((o) => o.signal.kind === 'webhookSilence').title.includes('11.7'), true);
    assert.deepEqual(r.created[0].proposedBy, { role: 'pilot.scan', provider: 'deterministic', model: 'n/a' });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('dedup: re-scanning, and re-polling for hours, does not re-fire; the next cooldown bucket does; a new alarm set does', async () => {
  const dataDir = tmp();
  try {
    await sampleAt(dataDir, loadFixture(), NOW);
    const first = scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.ok(first.created.length > 0);
    const second = scanPilotSignals({ dataDir, instanceConfig: config(), now: new Date(NOW.getTime() + 60_000) });
    assert.equal(second.created.length, 0);
    assert.equal(second.alreadySignaled.length, first.created.length);

    const later = new Date(NOW.getTime() + 2 * H);
    await sampleAt(dataDir, loadFixture(), later);
    assert.equal(scanPilotSignals({ dataDir, instanceConfig: config(), now: later }).created.length, 0);

    const changed = loadFixture();
    changed.health.billingAlarms = ['a brand new alarm'];
    const t3 = new Date(NOW.getTime() + 3 * H);
    await sampleAt(dataDir, changed, t3);
    assert.deepEqual(kinds(scanPilotSignals({ dataDir, instanceConfig: config(), now: t3 })), ['billingAlarm']);

    const nextDay = new Date(NOW.getTime() + 49 * H);
    await sampleAt(dataDir, loadFixture(), nextDay);
    const again = scanPilotSignals({ dataDir, instanceConfig: config(), now: nextDay });
    assert.ok(again.created.some((o) => o.signal.kind === 'webhookSilence'), 'a persistent problem resurfaces after its cooldown');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('week-on-week signals: signup drop and MRR change need and cite a week-old sample', async () => {
  const dataDir = tmp();
  try {
    await sampleAt(dataDir, healthy({ funnel: { signups7d: 40 }, revenue: { mrrUsd: 100 } }), at(24 * 7));
    const cur = healthy({ funnel: { signups7d: 12 }, revenue: { mrrUsd: 70 } });
    const { event } = await sampleAt(dataDir, cur, NOW);
    const r = scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.deepEqual(kinds(r), ['mrrChange', 'signupDrop']);
    const drop = r.created.find((o) => o.signal.kind === 'signupDrop');
    assert.match(drop.title, /12 this week from 40/);
    assert.equal(drop.evidence.length, 3);
    assert.ok(drop.evidence.includes(event.id));
    assert.equal(r.created.find((o) => o.signal.kind === 'mrrChange').title.includes('fell'), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('webhook silence needs the product to be live; refunds spike; null values never fire', async () => {
  const dataDir = tmp();
  try {
    await sampleAt(dataDir, healthy({ usage: { debates7d: 0 }, health: { lastWebhookAgeMinutes: 9000 }, revenue: { refundsWindow: 3, packsSoldWindow: 4 } }), NOW);
    const r = scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW });
    assert.deepEqual(kinds(r), ['refundSpike']);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  const nullDir = tmp();
  try {
    const nulls = { schema: 1, generatedAt: null, windowHours: null, funnel: null, usage: null, revenue: null, cohorts: null, health: null, notes: [] };
    await sampleAt(nullDir, nulls, NOW);
    assert.deepEqual(scanPilotSignals({ dataDir: nullDir, instanceConfig: config(), now: NOW }).created, []);
  } finally { fs.rmSync(nullDir, { recursive: true, force: true }); }
});

test('a stale sample is not judged', async () => {
  const dataDir = tmp();
  try {
    await sampleAt(dataDir, loadFixture(), at(8));
    assert.equal(scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW }).stale, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('revenue Outcome is derived from pilot.metrics, idempotent, neutral, and not added to revenueAttributable', async () => {
  const dataDir = tmp();
  try {
    await sampleAt(dataDir, loadFixture(), NOW);
    const first = recordPilotRevenueOutcome(dataDir);
    assert.equal(first.recorded, true);
    assert.equal(first.outcome.type, 'pilot.revenue.observed');
    assert.equal(first.outcome.payload.mrrUsd, 25);
    assert.equal(recordPilotRevenueOutcome(dataDir).recorded, false);
    assert.equal(queryEvents(dataDir, { type: 'pilot.revenue.observed' }).length, 1);
    assert.equal(recordPilotRevenueOutcome(tmp()).recorded, false);
    const { computeMetrics } = await import('../lib/evaluation/metrics.js');
    assert.equal(computeMetrics(dataDir).revenueAttributable, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('summary compares against the sample from ~24h ago and lists open Pilot opportunities', async () => {
  const dataDir = tmp();
  try {
    assert.equal(buildPilotSummary(dataDir, { now: NOW }).available, false);
    await sampleAt(dataDir, metrics({ funnel: { signupsTotal: 230 } }), at(24));
    await sampleAt(dataDir, loadFixture(), NOW);
    scanPilotSignals({ dataDir, instanceConfig: config(), now: NOW });
    const s = buildPilotSummary(dataDir, { now: NOW });
    assert.equal(s.available, true);
    assert.equal(s.hasYesterday, true);
    assert.deepEqual(s.funnel.find((f) => f.key === 'signupsTotal'), { key: 'signupsTotal', value: 240, yesterday: 230, delta: 10 });
    assert.ok(s.opportunities.length > 0 && s.opportunities.every((o) => o.type.startsWith('pilot-')));
    const text = formatPilotSummaryText(s).join('\n');
    assert.match(text, /signupsTotal: 240 \(\+10\)/);
    assert.match(text, /MRR \$25/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('runPilotPoll end to end against the fake server: sample, scan, revenue, then a quiet second poll', async () => {
  const dataDir = tmp();
  try {
    const transport = fakePilotTransport();
    const r = await runPilotPoll({ dataDir, instanceConfig: config(), transport, now: NOW });
    assert.equal(r.sample.degraded, false);
    assert.ok(r.scan.created.length >= 8);
    assert.equal(r.revenue.recorded, true);
    const quiet = await runPilotPoll({ dataDir, instanceConfig: config(), transport, now: new Date(NOW.getTime() + 30 * 60_000) });
    assert.equal(quiet.scan.created.length, 0);
    assert.equal(listOpportunities(dataDir).length, r.scan.created.length);
    assert.equal(verifyEventChain(dataDir).valid, true);
    const down = await runPilotPoll({ dataDir, instanceConfig: config(), transport: fakePilotTransport({ fail: new PilotMetricsError('ssh', 'down') }), now: new Date(NOW.getTime() + 3 * H) });
    assert.equal(down.sample.degraded, true);
    assert.equal(buildPilotSummary(dataDir, { now: new Date(NOW.getTime() + 3 * H) }).lastDegradedReason, 'ssh');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('config validation accepts a research.pilot block and refuses option-looking hosts', () => {
  const base = JSON.parse(fs.readFileSync(new URL('../examples/instance.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateInstanceConfig(base).errors ?? [], []);
  const bad = structuredClone(base);
  bad.research.pilot.sshHost = '-oProxyCommand=x';
  bad.research.pilot.thresholds = { webhookSilenceMinutes: -1 };
  const errors = validateInstanceConfig(bad).errors.join('\n');
  assert.match(errors, /research\.pilot\.sshHost/);
  assert.match(errors, /thresholds\.webhookSilenceMinutes/);
});
