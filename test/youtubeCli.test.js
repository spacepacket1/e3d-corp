// End-to-end through the real `bin/e3d-corp` binary against local fakes only: a fake YouTube Data API/OAuth server and
// a fake OpenAI-compatible LLM server. No real network, no model spend, nothing is ever sent to the real channel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { queryEvents, verifyEventChain } from '../lib/events/store.js';
import { FAKE_KEY, FAKE_CHANNEL_ID, FAKE_REFRESH_TOKEN, makeVideo, startFakeYoutube } from './helpers/fakeYoutubeServer.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');
const H = 3_600_000;

async function startFakeLlm(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

async function setup(t) {
  const T = Date.now();
  const published = (hoursAgo) => new Date(T - hoursAgo * H).toISOString();
  const fake = await startFakeYoutube({
    videos: [
      makeVideo('old1', { title: 'Older one', publishedAt: published(24 * 20), views: 4000 }),
      makeVideo('old2', { title: 'Older two', publishedAt: published(24 * 15), views: 6000 }),
      makeVideo('old3', { title: 'Older three', publishedAt: published(24 * 12), views: 3600 }),
      makeVideo('flat', { title: 'Untitled recording 3', description: 'Notes', tags: ['misc'], publishedAt: published(24 * 8), views: 40 })
    ],
    comments: { flat: [] }
  });
  const llm = await startFakeLlm({
    metadataChange: { title: 'Three AIs debate a decision: how the round table works', rationale: 'The title says nothing about the content.' },
    audienceCopy: [{ platform: 'linkedin', text: 'We let three models argue about one decision. Here is what we learned.' }],
    commentReplies: [], notes: 'ok'
  });
  const name = `youtube-cli-test-${process.pid}-${Date.now()}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-youtube-cli-'));
  fs.writeFileSync(path.join(secretsDir, 'tokens.json'), JSON.stringify({ access_token: 'stale', expiry_date: 1, refresh_token: FAKE_REFRESH_TOKEN }));
  fs.writeFileSync(path.join(secretsDir, 'client.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret' } }));
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify({
    name, dataDir: `.e3d-corp/instance/${name}`,
    llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'YT_CLI_LLM_BASE', modelEnvVar: 'YT_CLI_LLM_MODEL' } } },
    research: {
      knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled',
      youtube: {
        channelId: FAKE_CHANNEL_ID, apiBaseUrl: fake.baseUrl, apiKeyEnvVar: 'YT_CLI_KEY',
        oauth: { tokenFile: path.join(secretsDir, 'tokens.json'), clientSecretFile: path.join(secretsDir, 'client.json'), tokenUrl: fake.tokenUrl },
        thresholds: { measureMinViews: 1 }
      }
    },
    eventSources: [], roles: { 'youtube.growthDraft': { provider: 'local' } }
  }, null, 2));
  t.after(async () => {
    await fake.close(); await llm.close();
    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });
  const env = { ...process.env, YT_CLI_KEY: FAKE_KEY, YT_CLI_LLM_BASE: llm.baseUrl, YT_CLI_LLM_MODEL: 'fake-model' };
  const cli = async (...args) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args, '--instance', name], { cwd: ROOT, env, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  return { T, fake, llm, name, cli, dataDir: path.join(ROOT, '.e3d-corp', 'instance', name) };
}

test('the whole loop through the CLI: sample, scan, report, propose, approve, measure, rollback', async (t) => {
  const s = await setup(t);
  const at = (hours) => new Date(s.T + hours * H).toISOString();

  // history: a sample every 12h from -60h to now. Old videos grow; the flat one barely moves.
  for (let h = -60; h <= 0; h += 12) {
    const step = (h + 60) / 24;
    s.fake.setViews('old1', 4000 + Math.round(200 * step));
    s.fake.setViews('old2', 6000 + Math.round(400 * step));
    s.fake.setViews('old3', 3600 + Math.round(300 * step));
    s.fake.setViews('flat', 40 + Math.floor((h + 60) / 12));
    const r = await s.cli('youtube', 'sample', '--force', '--now', at(h));
    assert.equal(r.code, 0, r.stderr);
  }
  assert.match((await s.cli('youtube', 'sample', '--now', at(0))).stdout, /Skipped: sampled recently/, 'the interval gate makes a repeat run free');

  const scan = await s.cli('youtube', 'scan', '--now', at(0));
  assert.equal(scan.code, 0, scan.stderr);
  assert.match(scan.stdout, /1 new opportunity/);
  const oppId = /(opp[-\w]*|[0-9a-f-]{36})\s+\[youtube-underperforming-video\]/.exec(scan.stdout)?.[1];
  assert.ok(oppId, scan.stdout);
  assert.match((await s.cli('youtube', 'scan', '--now', at(0))).stdout, /0 new opportunities, 1 already handled/);

  const report = await s.cli('youtube', 'report', '--now', at(0));
  assert.match(report.stdout, /Untitled recording 3 \[flat\]/);
  assert.match(report.stdout, /Open opportunities \(1\)/);
  assert.match(report.stdout, /Channel baseline: median/);

  const propose = await s.cli('youtube', 'propose', oppId, '--now', at(0));
  assert.equal(propose.code, 0, propose.stderr);
  assert.match(propose.stdout, /1 draft\(s\) queued for a human to post, 1 metadata proposal/);
  const proposalId = /metadata proposal ([0-9a-f-]{36})/.exec(propose.stdout)[1];
  assert.equal(s.llm.seen.length, 1, 'exactly one model call');
  assert.match((await s.cli('youtube', 'propose', oppId)).stdout, /already drafted/);
  assert.equal(s.llm.seen.length, 1);
  assert.equal(s.fake.state.updates.length, 0, 'nothing is written before approval');

  const approve = await s.cli('proposals', 'approve', proposalId, '--reason', 'clearer title', '--decided-by', 'tester');
  assert.equal(approve.code, 0, approve.stderr);
  assert.match(approve.stdout, /approved \(action executed immediately\)/);
  assert.equal(s.fake.state.updates.length, 1);
  assert.equal(s.fake.state.updates[0].snippet.title, 'Three AIs debate a decision: how the round table works');
  assert.equal(s.fake.state.updates[0].snippet.categoryId, '28');
  assert.equal((await s.cli('youtube', 'apply', proposalId)).stdout.includes('already applied'), true);
  assert.equal(s.fake.state.updates.length, 1);

  // after the change: samples for the next ~2 days (real clock moves little, so appliedAt ~= T), flat video picks up
  for (let h = 12; h <= 60; h += 12) {
    const step = (h + 60) / 24;
    s.fake.setViews('old1', 4000 + Math.round(200 * step));
    s.fake.setViews('old2', 6000 + Math.round(400 * step));
    s.fake.setViews('old3', 3600 + Math.round(300 * step));
    s.fake.setViews('flat', 40 + 5 + Math.round(h * 2));
    assert.equal((await s.cli('youtube', 'sample', '--force', '--now', at(h))).code, 0);
  }
  const measure = await s.cli('youtube', 'measure', '--now', at(60));
  assert.equal(measure.code, 0, measure.stderr);
  assert.match(measure.stdout, /1 outcome\(s\) recorded/);
  assert.match(measure.stdout, /flat 24h: improved/);
  assert.match((await s.cli('youtube', 'report', '--now', at(60))).stdout, /Measured changes \(1\)[\s\S]*correlation, not causation/);

  const rollback = await s.cli('youtube', 'rollback', proposalId);
  assert.equal(rollback.code, 0, rollback.stderr);
  const rollbackId = /Rollback proposal ([0-9a-f-]{36})/.exec(rollback.stdout)[1];
  assert.equal(s.fake.state.updates.length, 1, 'proposing a rollback changes nothing');
  assert.equal((await s.cli('proposals', 'approve', rollbackId, '--reason', 'revert', '--decided-by', 'tester')).code, 0);
  assert.equal(s.fake.state.videos.get('flat').snippet.title, 'Untitled recording 3');
  assert.deepEqual(s.fake.state.videos.get('flat').snippet.tags, ['misc']);

  assert.equal(verifyEventChain(s.dataDir).valid, true, 'the hash chain is intact after the whole run');
  assert.ok(queryEvents(s.dataDir, { type: 'youtube-metadata-change.applied' }).length === 2);
  assert.equal(s.fake.state.calls.filter((c) => c.method === 'PUT').every((c) => /^Bearer /.test(c.auth)), true);
});

test('a conflict at approval time is reported loudly on stderr and `youtube apply` retries after the cause is gone', async (t) => {
  const s = await setup(t);
  const at = (hours) => new Date(s.T + hours * H).toISOString();
  for (let h = -60; h <= 0; h += 12) {
    const step = (h + 60) / 24;
    s.fake.setViews('old1', 4000 + Math.round(200 * step));
    s.fake.setViews('old2', 6000 + Math.round(400 * step));
    s.fake.setViews('old3', 3600 + Math.round(300 * step));
    s.fake.setViews('flat', 40 + Math.floor((h + 60) / 12));
    await s.cli('youtube', 'sample', '--force', '--now', at(h));
  }
  const oppId = /([0-9a-f-]{36})\s+\[youtube-underperforming-video\]/.exec((await s.cli('youtube', 'scan', '--now', at(0))).stdout)[1];
  const proposalId = /metadata proposal ([0-9a-f-]{36})/.exec((await s.cli('youtube', 'propose', oppId, '--now', at(0))).stdout)[1];

  s.fake.state.videos.get('flat').snippet.title = 'Edited in Studio meanwhile';
  const approve = await s.cli('proposals', 'approve', proposalId, '--reason', 'go', '--decided-by', 'tester');
  assert.match(approve.stderr, /Action NOT applied: conflict/);
  assert.equal(s.fake.state.updates.length, 0);

  const retry = await s.cli('youtube', 'apply', proposalId);
  assert.equal(retry.code, 1);
  assert.match(retry.stderr, /NOT applied: conflict/);
  assert.equal(s.fake.state.updates.length, 0, 'a conflict is never overwritten, not even on retry');
});

test('a degraded sample (bad key) exits 2 from poll, records no numbers, and the report says the data is stale', async (t) => {
  const s = await setup(t);
  s.fake.state.failNext = { status: 400, reason: 'keyInvalid', message: 'API key not valid. Please pass a valid API key.' };
  const poll = await s.cli('youtube', 'poll');
  assert.equal(poll.code, 2, poll.stderr);
  assert.match(poll.stdout, /DEGRADED/);
  assert.equal(queryEvents(s.dataDir, { type: 'youtube.video.sampled' }).length, 0, 'a failure never becomes zeros');
  assert.match((await s.cli('youtube', 'report')).stdout, /No samples yet/);
});

test('help lists the youtube commands, and a missing --instance or id is a clear error', async (t) => {
  const { stdout } = await execFileAsync(process.execPath, [BIN, '--help'], { cwd: ROOT, encoding: 'utf8' });
  for (const c of ['youtube sample', 'youtube scan', 'youtube report', 'youtube propose', 'youtube apply', 'youtube rollback', 'youtube measure', 'youtube poll']) assert.match(stdout, new RegExp(c));
  const s = await setup(t);
  const bad = await s.cli('youtube', 'propose');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /requires an <opportunity-id>/);
});

test('the cron entry point (ops/reports/pollYoutube.js) samples, reports JSON, is free on a repeat run, and exits 2 when degraded', async (t) => {
  const s = await setup(t);
  const script = path.join(ROOT, 'ops', 'reports', 'pollYoutube.js');
  const env = { ...process.env, YT_CLI_KEY: FAKE_KEY };
  const run = async () => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, '--instance', s.name], { cwd: ROOT, env, encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const first = await run();
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.stdout).sampled, 4);
  const callsAfterFirst = s.fake.state.calls.length;
  const second = JSON.parse((await run()).stdout);
  assert.equal(second.skipped, 'interval');
  assert.equal(s.fake.state.calls.length, callsAfterFirst, 'the repeat run made zero API calls');

  const bad = await execFileAsync(process.execPath, [script, '--instance', s.name, '--force'], { cwd: ROOT, env: { ...env, YT_CLI_KEY: 'wrong-key' }, encoding: 'utf8' }).then(() => ({ code: 0 }), (e) => ({ code: e.code, stdout: e.stdout }));
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.stdout).degraded, true);
});
