import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents } from '../lib/events/store.js';
import { ACTION_POLICY, ACTION_POLICY_VERSION, assertProposalAuthorized } from '../lib/authority/policy.js';
import { samplePilotMetrics } from '../lib/event-sources/pilotMetrics.js';
import { scanPilotSignals, PILOT_RETENTION_TYPE } from '../lib/opportunities/pilotOpportunities.js';
import { proposeRetentionNudge } from '../lib/pilot/nudge.js';
import { createProposal } from '../lib/proposals/create.js';
import { getProposal, listProposals } from '../lib/proposals/store.js';
import { normalizePilotNudgePayload } from '../lib/proposals/pilotRetentionNudgeSchema.js';
import { validateNudgeCopy } from '../lib/roles/pilotRetentionCopy.js';
import { recordPilotRetentionNudgeHandoff } from '../lib/actions/pilotRetentionNudge.js';
import { registerActionExecutor } from '../lib/actions/registry.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { listExecutedActions } from '../lib/actions/log.js';
import { renderPilot } from '../lib/web/render.js';
import { buildPilotSummary } from '../lib/pilot/summary.js';
import { renderPilotDigestHtml } from '../lib/pilot/digestHtml.js';
import { fakePilotTransport } from './helpers/fakePilotServer.js';

process.env.PILOT_NUDGE_TEST_BASE = 'http://127.0.0.1:1';
process.env.PILOT_NUDGE_TEST_MODEL = 'fake-model';
const NOW = new Date('2026-10-28T12:00:00.000Z');
const instanceConfig = {
  research: { pilot: { sshHost: 'pilot.test', remoteCommand: 'x' } },
  roles: { 'pilot.retentionCopy': { provider: 'fake' } },
  llm: { providers: { fake: { kind: 'local', baseUrlEnvVar: 'PILOT_NUDGE_TEST_BASE', modelEnvVar: 'PILOT_NUDGE_TEST_MODEL' } } }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilot-nudge-'));
const llm = (payload) => async () => ({ text: typeof payload === 'string' ? payload : JSON.stringify(payload), usage: { inputTokens: 5, outputTokens: 5 }, costUsd: 0 });
const GOOD = { subject: 'Your Pilot credits ran out', body: 'Hi,\n\nYou used up your credits. If a second opinion is still useful, you can top up at https://pilot.e3d.ai .' };

async function seed(dataDir) {
  await samplePilotMetrics({ dataDir, instanceConfig, transport: fakePilotTransport(), now: NOW });
  return scanPilotSignals({ dataDir, instanceConfig, now: NOW }).created.find((o) => o.type === PILOT_RETENTION_TYPE && o.signal.cohort === 'outOfCredits');
}

test('policy v8: pilot-retention-nudge is level 2', () => {
  assert.equal(ACTION_POLICY_VERSION, 9);
  assert.equal(ACTION_POLICY['pilot-retention-nudge'], 2);
});

test('payload carries cohort, count and copy only: addresses, foreign links and extra fields are refused', () => {
  const ok = normalizePilotNudgePayload({ cohort: 'outOfCredits', count: 6, copy: GOOD });
  assert.deepEqual(Object.keys(ok).sort(), ['cohort', 'copy', 'count', 'opportunityId', 'rationale', 'sampleEventId']);
  const bad = (over) => assert.throws(() => normalizePilotNudgePayload({ cohort: 'outOfCredits', count: 6, copy: GOOD, ...over }));
  bad({ copy: { ...GOOD, body: 'write to jane@example.com' } });
  bad({ copy: { ...GOOD, body: 'see https://evil.example/x' } });
  bad({ recipients: ['a@b.co'] });
  bad({ cohort: 'everyone' });
  bad({ count: 0 });
  assert.throws(() => normalizePilotNudgePayload({ cohort: 'outOfCredits', count: 1, copy: { ...GOOD, to: 'x' } }), /unsupported field/);
});

test('copy validation drops addresses, clickbait and non-JSON; accepts honest copy', () => {
  assert.equal(validateNudgeCopy(JSON.stringify(GOOD)).ok, true);
  assert.equal(validateNudgeCopy('prose').ok, false);
  assert.equal(validateNudgeCopy(JSON.stringify({ subject: 'Hi', body: 'mail me bob@example.org' })).ok, false);
  assert.equal(validateNudgeCopy(JSON.stringify({ subject: "You won't believe this", body: 'x' })).ok, false);
});

test('opportunity -> drafted proposal (cohort, count, copy; no addresses) -> approve -> recorded no-op handoff', async () => {
  const dataDir = tmp();
  try {
    registerActionExecutor('pilot-retention-nudge', recordPilotRetentionNudgeHandoff);
    const opp = await seed(dataDir);
    assert.ok(opp, 'fixture raises an outOfCredits retention recommendation');
    assert.equal(opp.type, 'pilot-retention-recommendation');

    const r = await proposeRetentionNudge(dataDir, opp.id, { instanceConfig, llmClient: llm(GOOD), now: NOW });
    assert.equal(r.proposal.type, 'pilot-retention-nudge');
    assert.equal(r.proposal.authorityLevel, 2);
    assert.equal(r.proposal.status, 'pending');
    assert.equal(r.proposal.payload.cohort, 'outOfCredits');
    assert.equal(r.proposal.payload.count, 6);
    assert.deepEqual(r.proposal.proposedBy.role, 'pilot.retentionCopy');
    assert.equal(r.proposal.correlationId, opp.correlationId);
    assert.equal(/@/.test(JSON.stringify(r.proposal)), false);

    // one model call per opportunity
    const again = await proposeRetentionNudge(dataDir, opp.id, { instanceConfig, llmClient: llm('should not be called') });
    assert.equal(again.alreadyProposed, true);
    assert.equal(listProposals(dataDir, { type: 'pilot-retention-nudge' }).length, 1);

    // unapproved: refused
    await assert.rejects(recordPilotRetentionNudgeHandoff(r.proposal, { dataDir }), /not approved/);

    const decided = await decideProposal(dataDir, r.proposal.id, 'approved', 'send it', 'chris', 'cli', instanceConfig);
    assert.equal(decided.executed, true);
    assert.equal(decided.executionResult.sent, false);
    const artifact = JSON.parse(fs.readFileSync(decided.executionResult.artifactPath, 'utf8'));
    assert.equal(artifact.status, 'handoff-recorded-not-sent');
    assert.deepEqual(Object.keys(artifact.copy).sort(), ['body', 'subject']);
    assert.equal(/@/.test(JSON.stringify(artifact)), false);
    const [handoff] = queryEvents(dataDir, { type: 'pilot-retention-nudge.handed-off' });
    assert.equal(handoff.payload.sent, false);
    assert.equal(handoff.correlationId, opp.correlationId);
    assert.match(listExecutedActions(dataDir).map((a) => JSON.stringify(a)).join(), /handed off to the owner \(not sent\)/);

    // idempotent
    const approved = getProposal(dataDir, r.proposal.id);
    assert.equal((await recordPilotRetentionNudgeHandoff(approved, { dataDir })).alreadyHandedOff, true);
    assert.equal(queryEvents(dataDir, { type: 'pilot-retention-nudge.handed-off' }).length, 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a model that returns an address produces no proposal; a non-retention opportunity is refused', async () => {
  const dataDir = tmp();
  try {
    const opp = await seed(dataDir);
    const r = await proposeRetentionNudge(dataDir, opp.id, { instanceConfig, llmClient: llm({ subject: 'Hi', body: 'reply to ceo@example.com' }) });
    assert.equal(r.failed, true);
    assert.equal(listProposals(dataDir, { type: 'pilot-retention-nudge' }).length, 0);
    const other = scanPilotSignals({ dataDir, instanceConfig, now: NOW });
    assert.equal(other.created.length, 0);
    const { listOpportunities } = await import('../lib/opportunities/store.js');
    const nonRetention = listOpportunities(dataDir).find((o) => o.type !== PILOT_RETENTION_TYPE);
    await assert.rejects(proposeRetentionNudge(dataDir, nonRetention.id, { instanceConfig, llmClient: llm(GOOD) }), /not a Pilot retention recommendation/);
    assert.throws(() => createProposal(dataDir, { type: 'pilot-retention-nudge', payload: { cohort: 'outOfCredits', count: 1, copy: { subject: 'a', body: 'b@c.io' } }, proposedBy: { role: 'x', provider: 'y', model: 'z' }, correlationId: 'c' }), /email address/);
    assert.throws(() => assertProposalAuthorized({ type: 'pilot-retention-nudge', authorityLevel: 3, status: 'approved', id: 'p' }, 'pilot-retention-nudge'), /requires 2/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('web page and email digest block render the Pilot summary, escaped', async () => {
  const dataDir = tmp();
  try {
    await seed(dataDir);
    const s = buildPilotSummary(dataDir, { now: NOW });
    const page = renderPilot(s);
    assert.match(page, /signupsTotal/);
    assert.match(page, /Open Pilot opportunities/);
    assert.match(page, /\$25/);
    const mail = renderPilotDigestHtml(s);
    assert.match(mail, /Open Pilot opportunities/);
    assert.match(mail, /webhook signature failures: 3/);
    assert.match(renderPilot({ available: false, opportunities: [], lastDegradedAt: '2026-10-28T00:00:00Z', lastDegradedReason: '<b>ssh</b>' }), /&lt;b&gt;ssh/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
