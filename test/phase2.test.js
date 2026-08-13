import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { appendEvent, queryEvents, eventsFilePath } from '../lib/events/store.js';
import { reconstructChain } from '../lib/events/chain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-events-'));
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function setupTempInstance() {
  const name = `phase2-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify({
      name,
      dataDir: `.e3d-corp/instance/${name}`,
      llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
      research: { futcoMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'example-search' },
      eventSources: [],
      roles: {}
    })
  );
  return { name, instanceDir };
}

// --- lib/events/store.js ---

test('appendEvent generates id/occurredAt when absent and persists the record', () => {
  const dataDir = makeTempDataDir();
  const record = appendEvent(dataDir, {
    type: 'market.signal.detected',
    source: 'manual',
    subject: { type: 'market.signal.detected', id: 'sig-1' },
    payload: { note: 'noticed something' },
    correlationId: 'corr-1'
  });

  assert.equal(typeof record.id, 'string');
  assert.ok(record.id.length > 0);
  assert.equal(typeof record.occurredAt, 'string');
  assert.equal(record.causationId, null);

  const lines = fs.readFileSync(eventsFilePath(dataDir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
});

test('appendEvent rejects an event missing required fields', () => {
  const dataDir = makeTempDataDir();
  assert.throws(
    () =>
      appendEvent(dataDir, {
        source: 'manual',
        subject: { type: 'x', id: 'y' },
        payload: {},
        correlationId: 'c1'
      }),
    /type: must be a non-empty string/
  );
});

test('appendEvent rejects a causationId that does not resolve to an existing event', () => {
  const dataDir = makeTempDataDir();
  assert.throws(
    () =>
      appendEvent(dataDir, {
        type: 'evidence.gathered',
        source: 'manual',
        subject: { type: 'evidence.gathered', id: 'e1' },
        payload: {},
        correlationId: 'c1',
        causationId: 'does-not-exist'
      }),
    /causationId "does-not-exist" does not reference an existing event/
  );
});

test('appendEvent accepts a causationId pointing at a real prior event', () => {
  const dataDir = makeTempDataDir();
  const first = appendEvent(dataDir, {
    type: 'market.signal.detected',
    source: 'manual',
    subject: { type: 'market.signal.detected', id: 's1' },
    payload: {},
    correlationId: 'c1'
  });

  const second = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'manual',
    subject: { type: 'evidence.gathered', id: 'e1' },
    payload: {},
    correlationId: 'c1',
    causationId: first.id
  });

  assert.equal(second.causationId, first.id);
});

test('queryEvents filters by type, correlationId, and since', () => {
  const dataDir = makeTempDataDir();
  appendEvent(dataDir, {
    type: 'a',
    source: 'manual',
    subject: { type: 'a', id: '1' },
    payload: {},
    correlationId: 'c1',
    occurredAt: '2026-01-01T00:00:00.000Z'
  });
  appendEvent(dataDir, {
    type: 'b',
    source: 'manual',
    subject: { type: 'b', id: '2' },
    payload: {},
    correlationId: 'c1',
    occurredAt: '2026-02-01T00:00:00.000Z'
  });
  appendEvent(dataDir, {
    type: 'a',
    source: 'manual',
    subject: { type: 'a', id: '3' },
    payload: {},
    correlationId: 'c2',
    occurredAt: '2026-03-01T00:00:00.000Z'
  });

  assert.equal(queryEvents(dataDir, { type: 'a' }).length, 2);
  assert.equal(queryEvents(dataDir, { correlationId: 'c1' }).length, 2);
  assert.equal(queryEvents(dataDir, { since: '2026-02-15T00:00:00.000Z' }).length, 1);
});

// --- lib/events/chain.js ---

test('reconstructChain returns a hand-crafted 4-event chain in correct causal order', () => {
  const dataDir = makeTempDataDir();
  const e1 = appendEvent(dataDir, {
    type: 'market.signal.detected',
    source: 'manual',
    subject: { type: 'signal', id: '1' },
    payload: {},
    correlationId: 'chain-1',
    occurredAt: '2026-01-01T00:00:00.000Z'
  });
  const e2 = appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: 'research',
    subject: { type: 'evidence', id: '2' },
    payload: {},
    correlationId: 'chain-1',
    causationId: e1.id,
    occurredAt: '2026-01-02T00:00:00.000Z'
  });
  const e3 = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'opportunity.prospect',
    subject: { type: 'opportunity', id: '3' },
    payload: {},
    correlationId: 'chain-1',
    causationId: e2.id,
    occurredAt: '2026-01-03T00:00:00.000Z'
  });
  const e4 = appendEvent(dataDir, {
    type: 'opportunity.scored',
    source: 'opportunity.prospect',
    subject: { type: 'opportunity', id: '3' },
    payload: {},
    correlationId: 'chain-1',
    causationId: e3.id,
    occurredAt: '2026-01-04T00:00:00.000Z'
  });

  const chain = reconstructChain(dataDir, 'chain-1');
  assert.deepEqual(chain.map((e) => e.id), [e1.id, e2.id, e3.id, e4.id]);
});

test('reconstructChain orders events by occurredAt regardless of append order', () => {
  const dataDir = makeTempDataDir();
  const late = appendEvent(dataDir, {
    type: 'later',
    source: 'manual',
    subject: { type: 'x', id: '1' },
    payload: {},
    correlationId: 'chain-2',
    occurredAt: '2026-05-01T00:00:00.000Z'
  });
  const early = appendEvent(dataDir, {
    type: 'earlier',
    source: 'manual',
    subject: { type: 'x', id: '2' },
    payload: {},
    correlationId: 'chain-2',
    occurredAt: '2026-01-01T00:00:00.000Z'
  });

  const chain = reconstructChain(dataDir, 'chain-2');
  assert.deepEqual(chain.map((e) => e.id), [early.id, late.id]);
});

// --- CLI: event add / event log ---

test('event add generates a fresh correlationId; a second add with --correlation links to the same chain', () => {
  const { name, instanceDir } = setupTempInstance();
  try {
    const out1 = runCli([
      'event',
      'add',
      '--type',
      'market.signal.detected',
      '--source',
      'manual',
      '--payload',
      '{"note":"first"}',
      '--instance',
      name
    ]);
    const match = out1.match(/correlationId=([^)]+)\)/);
    assert.ok(match, `expected correlationId in output: ${out1}`);
    const correlationId = match[1];

    runCli([
      'event',
      'add',
      '--type',
      'evidence.gathered',
      '--source',
      'manual',
      '--payload',
      '{"note":"second"}',
      '--instance',
      name,
      '--correlation',
      correlationId
    ]);

    const logOut = runCli(['event', 'log', '--correlation', correlationId, '--instance', name]);
    const entryLines = logOut.split('\n').filter((line) => line.startsWith('20'));
    assert.equal(entryLines.length, 2);
    assert.match(logOut, new RegExp(`correlation=${correlationId}`, 'g'));
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

test('event add rejects invalid --payload JSON with a clear error', () => {
  const { name, instanceDir } = setupTempInstance();
  try {
    assert.throws(
      () =>
        runCli(['event', 'add', '--type', 'x', '--source', 'manual', '--payload', 'not-json', '--instance', name]),
      (error) => {
        assert.match(error.stderr.toString(), /Invalid JSON for --payload/);
        return true;
      }
    );
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

test('event add surfaces a causationId validation error through the CLI', () => {
  const { name, instanceDir } = setupTempInstance();
  try {
    assert.throws(
      () =>
        runCli([
          'event',
          'add',
          '--type',
          'evidence.gathered',
          '--source',
          'manual',
          '--payload',
          '{}',
          '--instance',
          name,
          '--causation',
          'nonexistent-id'
        ]),
      (error) => {
        assert.match(
          error.stderr.toString(),
          /causationId "nonexistent-id" does not reference an existing event/
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

test('concurrent event add invocations do not corrupt events.jsonl', async () => {
  const { name, instanceDir } = setupTempInstance();
  try {
    const concurrency = 12;
    const runs = Array.from(
      { length: concurrency },
      (_, i) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              BIN,
              'event',
              'add',
              '--type',
              'concurrent.test',
              '--source',
              'manual',
              '--payload',
              JSON.stringify({ i }),
              '--instance',
              name
            ],
            { cwd: ROOT }
          );
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          child.on('error', reject);
        })
    );

    await Promise.all(runs);

    const dataFile = path.join(instanceDir, 'events.jsonl');
    const raw = fs.readFileSync(dataFile, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, concurrency);

    const ids = new Set();
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if a line was corrupted by interleaved writes
      ids.add(parsed.id);
    }
    assert.equal(ids.size, concurrency);
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});
