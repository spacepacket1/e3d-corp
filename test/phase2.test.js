import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { appendEvent, queryEvents, eventsFilePath, verifyEventChain } from '../lib/events/store.js';
import { reconstructChain } from '../lib/events/chain.js';
import { computeRecordHash, sealHash } from '../lib/store/appendOnlyLog.js';
import { publishAnchor, verifyAgainstAnchors, verifyExternalAnchor, listAnchors, computeChainHead } from '../lib/anchor/anchor.js';
import { buildAnchorBody, resolveAnchorRecipient } from '../lib/anchor/emailTransport.js';
import {
  RESERVED_TOKENS_BY_PROVIDER_KIND,
  computeBudgetStatus,
  reserveBudget,
  settleReservation
} from '../lib/llm/budget.js';
import { validateInstanceConfig } from '../lib/config.js';

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
      llm: {
        providers: {
          local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
        }
      },
      research: { knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'example-search' },
      eventSources: [],
      roles: {}
    })
  );
  return { name, instanceDir };
}

function isoUtcDay(offsetDays, hour = 12) {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, hour, 0, 0, 0)
  ).toISOString();
}

function makeBudgetConfig(overrides = {}) {
  return {
    name: 'budget-test',
    dataDir: '.e3d-corp/instance/budget-test',
    llm: {
      providers: {
        grok: { kind: 'grok-cli' },
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      },
      budget: {
        period: 'daily',
        limits: {
          grok: { tokens: 1000 }
        }
      }
    },
    research: { webSearchProvider: 'disabled' },
    eventSources: [],
    roles: {},
    ...overrides
  };
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

test('validateInstanceConfig accepts llm.budget and rejects unsupported period or unknown budget providers', () => {
  const valid = validateInstanceConfig(makeBudgetConfig());
  assert.equal(valid.valid, true);

  const badPeriod = validateInstanceConfig(
    makeBudgetConfig({
      llm: {
        providers: {
          grok: { kind: 'grok-cli' }
        },
        budget: {
          period: 'weekly',
          limits: {
            grok: { tokens: 1000 }
          }
        }
      }
    })
  );
  assert.equal(badPeriod.valid, false);
  assert.ok(badPeriod.errors.some((error) => error.includes('llm.budget.period')));

  const unknownProvider = validateInstanceConfig(
    makeBudgetConfig({
      llm: {
        providers: {
          grok: { kind: 'grok-cli' }
        },
        budget: {
          period: 'daily',
          limits: {
            hosted: { tokens: 1000 }
          }
        }
      }
    })
  );
  assert.equal(unknownProvider.valid, false);
  assert.ok(unknownProvider.errors.some((error) => error.includes('references unknown provider "hosted"')));
});

test('computeBudgetStatus reports settled spend, outstanding reservations, non-negative remaining, and UTC day boundaries', async () => {
  const dataDir = makeTempDataDir();
  const config = makeBudgetConfig();
  try {
    appendEvent(dataDir, {
      type: 'role.provider.completed',
      source: 'role:test',
      subject: { type: 'role', id: 'opportunity.prospect' },
      payload: {
        role: 'opportunity.prospect',
        provider: 'grok',
        model: 'grok-cli-default',
        usage: { promptTokens: 400, completionTokens: 300, totalTokens: 700 },
        costUsd: null
      },
      correlationId: 'phase2-budget-settled',
      occurredAt: isoUtcDay(0, 10)
    });

    let status = computeBudgetStatus(dataDir, config, 'grok');
    assert.equal(status.remaining, 300);
    assert.equal(status.settled, 700);
    assert.equal(status.outstanding, 0);

    appendEvent(dataDir, {
      type: 'role.provider.failed',
      source: 'role:test',
      subject: { type: 'role', id: 'opportunity.prospect' },
      payload: {
        role: 'opportunity.prospect',
        provider: 'grok',
        model: 'grok-cli-default',
        usage: { promptTokens: 200, completionTokens: 300, totalTokens: 500 },
        costUsd: null,
        reason: 'invalid JSON'
      },
      correlationId: 'phase2-budget-over-limit',
      occurredAt: isoUtcDay(0, 11)
    });

    status = computeBudgetStatus(dataDir, config, 'grok');
    assert.equal(status.settled, 1200);
    assert.equal(status.remaining, 0);

    const reservationId = 'phase2-outstanding';
    appendEvent(dataDir, {
      type: 'role.provider.reserved',
      source: 'llm.budget',
      subject: { type: 'provider', id: 'grok' },
      payload: {
        role: null,
        provider: 'grok',
        reservationId,
        estimatedTokens: 500
      },
      correlationId: reservationId,
      occurredAt: isoUtcDay(0, 12)
    });

    const cleanDir = makeTempDataDir();
    try {
      appendEvent(cleanDir, {
        type: 'role.provider.reserved',
        source: 'llm.budget',
        subject: { type: 'provider', id: 'grok' },
        payload: {
          role: null,
          provider: 'grok',
          reservationId,
          estimatedTokens: 500
        },
        correlationId: reservationId,
        occurredAt: isoUtcDay(0, 12)
      });
      const outstandingOnly = computeBudgetStatus(cleanDir, config, 'grok');
      assert.equal(outstandingOnly.settled, 0);
      assert.equal(outstandingOnly.outstanding, 500);
      assert.equal(outstandingOnly.remaining, 500);

      appendEvent(cleanDir, {
        type: 'role.provider.completed',
        source: 'role:test',
        subject: { type: 'role', id: 'opportunity.prospect' },
        payload: {
          role: 'opportunity.prospect',
          provider: 'grok',
          model: 'grok-cli-default',
          reservationId,
          usage: { promptTokens: 300, completionTokens: 200, totalTokens: 500 },
          costUsd: null
        },
        correlationId: reservationId,
        occurredAt: isoUtcDay(0, 13)
      });
      const settledReservation = computeBudgetStatus(cleanDir, config, 'grok');
      assert.equal(settledReservation.outstanding, 0);
      assert.equal(settledReservation.settled, 500);
      assert.equal(settledReservation.remaining, 500);
    } finally {
      fs.rmSync(cleanDir, { recursive: true, force: true });
    }

    appendEvent(dataDir, {
      type: 'role.provider.completed',
      source: 'role:test',
      subject: { type: 'role', id: 'opportunity.prospect' },
      payload: {
        role: 'opportunity.prospect',
        provider: 'grok',
        model: 'grok-cli-default',
        usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 },
        costUsd: null
      },
      correlationId: 'phase2-budget-yesterday',
      occurredAt: isoUtcDay(-1, 23)
    });
    status = computeBudgetStatus(dataDir, config, 'grok');
    assert.equal(status.settled, 1200);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reserveBudget is lock-safe under concurrency and unlimited providers always grant', async () => {
  const dataDir = makeTempDataDir();
  const config = makeBudgetConfig();
  const estimatedTokens = RESERVED_TOKENS_BY_PROVIDER_KIND['grok-cli'];
  try {
    appendEvent(dataDir, {
      type: 'role.provider.completed',
      source: 'role:test',
      subject: { type: 'role', id: 'opportunity.prospect' },
      payload: {
        role: 'opportunity.prospect',
        provider: 'grok',
        model: 'grok-cli-default',
        usage: { promptTokens: 300, completionTokens: 200, totalTokens: 500 },
        costUsd: null
      },
      correlationId: 'phase2-reserve-existing',
      occurredAt: isoUtcDay(0, 9)
    });

    const results = await Promise.allSettled([
      reserveBudget(dataDir, config, 'grok'),
      reserveBudget(dataDir, config, 'grok')
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    assert.equal(fulfilled.length, 2);
    assert.equal(fulfilled.filter((result) => result.granted === true).length, 1);
    assert.equal(fulfilled.filter((result) => result.granted === false).length, 1);

    const reservedEvents = queryEvents(dataDir, { type: 'role.provider.reserved' });
    assert.equal(reservedEvents.length, 1);
    assert.equal(reservedEvents[0].payload.estimatedTokens, estimatedTokens);

    const unlimited = await reserveBudget(dataDir, config, 'local');
    assert.equal(unlimited.granted, true);

    const unlimitedStatus = computeBudgetStatus(dataDir, config, 'local');
    assert.deepEqual(unlimitedStatus, { provider: 'local', unlimited: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('settleReservation records the settled provider event and budget status reflects the settled tokens', async () => {
  const dataDir = makeTempDataDir();
  const config = makeBudgetConfig();
  try {
    const reservation = await reserveBudget(dataDir, config, 'grok');
    assert.equal(reservation.granted, true);

    await settleReservation(dataDir, {
      type: 'role.provider.completed',
      source: 'role:test',
      subject: { type: 'role', id: 'opportunity.prospect' },
      payload: {
        role: 'opportunity.prospect',
        provider: 'grok',
        model: 'grok-cli-default',
        reservationId: reservation.reservationId,
        usage: { promptTokens: 250, completionTokens: 150, totalTokens: 400 },
        costUsd: null
      },
      correlationId: reservation.reservationId
    });

    const completions = queryEvents(dataDir, { type: 'role.provider.completed' });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].payload.reservationId, reservation.reservationId);

    const status = computeBudgetStatus(dataDir, config, 'grok');
    assert.equal(status.settled, 400);
    assert.equal(status.outstanding, 0);
    assert.equal(status.remaining, 600);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: budget status renders computeBudgetStatus numbers for configured providers', () => {
  const { name, instanceDir } = setupTempInstance();
  const dataDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  const configPath = path.join(instanceDir, 'instance.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.llm.providers.grok = { kind: 'grok-cli' };
    config.llm.budget = {
      period: 'daily',
      limits: {
        grok: { tokens: 1000 }
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    appendEvent(dataDir, {
      type: 'role.provider.completed',
      source: 'role:test',
      subject: { type: 'role', id: 'opportunity.prospect' },
      payload: {
        role: 'opportunity.prospect',
        provider: 'grok',
        model: 'grok-cli-default',
        usage: { promptTokens: 400, completionTokens: 300, totalTokens: 700 },
        costUsd: null
      },
      correlationId: 'phase2-cli-budget',
      occurredAt: isoUtcDay(0, 10)
    });

    const direct = computeBudgetStatus(dataDir, config, 'grok');
    const output = runCli(['budget', 'status', '--instance', name]);
    assert.match(output, new RegExp(`grok: spent=${direct.settled} allocated=${direct.limit} outstanding=${direct.outstanding} remaining=${direct.remaining}`));
    assert.match(output, new RegExp(`period: ${direct.periodStart} to ${direct.periodEnd}`));
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
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

    // Hash chaining turns every append into a read-modify-write, so this is
    // also the test that the append lock holds: without it, writers would
    // race to claim the same prevHash and fork the chain.
    const chain = verifyEventChain(instanceDir);
    assert.equal(chain.valid, true, chain.reason ?? '');
    assert.equal(chain.chained, concurrency);
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

// --- hash chain: tamper evidence ---

function makeEvent(overrides = {}) {
  return {
    type: 'market.signal.detected',
    source: 'manual',
    subject: { type: 'market.signal.detected', id: 'sig' },
    payload: { note: 'something' },
    correlationId: 'chain-corr',
    ...overrides
  };
}

function readRecords(dataDir) {
  return fs
    .readFileSync(eventsFilePath(dataDir), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function writeRecords(dataDir, records) {
  fs.writeFileSync(eventsFilePath(dataDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

test('appendEvent links each record to the one before it, and the chain verifies', () => {
  const dataDir = makeTempDataDir();
  try {
    const first = appendEvent(dataDir, makeEvent());
    const second = appendEvent(dataDir, makeEvent({ payload: { note: 'another' } }));

    assert.equal(first.prevHash, null, 'the first record in a fresh log has no predecessor');
    assert.equal(first.hash, computeRecordHash(first));
    assert.equal(second.prevHash, first.hash, 'each record commits to the one before it');
    assert.equal(second.hash, computeRecordHash(second));

    const result = verifyEventChain(dataDir);
    assert.equal(result.valid, true);
    assert.equal(result.total, 2);
    assert.equal(result.chained, 2);
    assert.equal(result.unchained, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verifyEventChain names the first altered record, and reports what a chain alone cannot catch', () => {
  const dataDir = makeTempDataDir();
  try {
    appendEvent(dataDir, makeEvent({ payload: { note: 'one' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'two' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'three' } }));

    const pristine = readRecords(dataDir);

    // Editing a historical record in place: caught at that record.
    const edited = pristine.map((record) => ({ ...record }));
    edited[1].payload = { note: 'quietly changed' };
    writeRecords(dataDir, edited);

    const tampered = verifyEventChain(dataDir);
    assert.equal(tampered.valid, false);
    assert.equal(tampered.brokenAt, 1);
    assert.match(tampered.reason, /this record's own content was altered/);

    // Removing a record from the middle: caught at the record that followed it.
    writeRecords(dataDir, [pristine[0], pristine[2]]);

    const removed = verifyEventChain(dataDir);
    assert.equal(removed.valid, false);
    assert.equal(removed.brokenAt, 1);
    assert.match(removed.reason, /altered or removed/);

    // Truncating the tail is NOT detectable from inside the log: what remains
    // is a valid prefix. Catching that needs an external anchor (a published
    // digest, an offsite copy) — asserted here so the limit stays explicit
    // rather than being assumed away.
    writeRecords(dataDir, [pristine[0], pristine[1]]);
    assert.equal(verifyEventChain(dataDir).valid, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('adopting chaining on an existing unchained log seals the legacy prefix rather than rewriting it', () => {
  const dataDir = makeTempDataDir();
  try {
    // Exactly the shape appendEvent wrote before chaining existed — which is
    // what FutCo's real 71-event log looks like today.
    const legacy = [
      {
        id: 'legacy-1',
        type: 'market.signal.detected',
        occurredAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
        subject: { type: 'market.signal.detected', id: 'sig-1' },
        payload: { note: 'before chaining' },
        causationId: null,
        correlationId: 'legacy-corr'
      },
      {
        id: 'legacy-2',
        type: 'evidence.gathered',
        occurredAt: '2026-01-02T00:00:00.000Z',
        source: 'research.webSearch',
        subject: { type: 'research', id: 'res-1' },
        payload: { kind: 'web-search' },
        causationId: null,
        correlationId: 'legacy-corr'
      }
    ];
    writeRecords(dataDir, legacy);

    const chained = appendEvent(dataDir, makeEvent());
    assert.equal(chained.prevHash, sealHash(legacy), 'the first chained record seals the legacy prefix');

    const result = verifyEventChain(dataDir);
    assert.equal(result.valid, true);
    assert.equal(result.unchained, 2);
    assert.equal(result.chained, 1);

    // The seal is what gives the untouched legacy records tamper evidence:
    // altering one now breaks the first chained record after them.
    const records = readRecords(dataDir);
    records[0].payload = { note: 'rewritten history' };
    writeRecords(dataDir, records);

    const broken = verifyEventChain(dataDir);
    assert.equal(broken.valid, false);
    assert.equal(broken.brokenAt, 2);
    assert.match(broken.reason, /altered or removed/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- external anchors: the checks the chain cannot make about itself ---

function fakeAnchorTransport() {
  const sent = [];
  return {
    name: 'test',
    destination: 'anchors@example.com',
    sent,
    async send(anchor) {
      sent.push(anchor);
      return { transport: 'test', messageId: `msg-${sent.length}` };
    }
  };
}

test('publishAnchor records the head and count, and the anchor event agrees with the chain', async () => {
  const dataDir = makeTempDataDir();
  try {
    appendEvent(dataDir, makeEvent({ payload: { note: 'one' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'two' } }));

    const before = computeChainHead(dataDir);
    const transport = fakeAnchorTransport();
    const published = await publishAnchor(dataDir, { instanceConfig: { name: 'testco' }, transport });

    assert.equal(published.head, before.head);
    assert.equal(published.count, 2, 'the anchor covers the log as it stood, excluding the anchor event itself');
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].head, before.head);

    // The anchor event's own prevHash is the anchored head by construction:
    // the anchor and the chain corroborate each other or neither is useful.
    assert.equal(published.event.prevHash, published.head);

    const anchors = listAnchors(dataDir);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].head, before.head);
    assert.equal(anchors[0].count, 2);
    assert.equal(anchors[0].publishedTo, 'anchors@example.com');

    const verified = verifyAgainstAnchors(dataDir);
    assert.equal(verified.valid, true);
    assert.equal(verified.anchorCount, 1);
    assert.equal(verified.pinnedThrough, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an anchor catches a full rewrite and a truncated tail — the two failures the chain alone cannot see', async () => {
  const dataDir = makeTempDataDir();
  try {
    appendEvent(dataDir, makeEvent({ payload: { note: 'one' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'two' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'three' } }));
    await publishAnchor(dataDir, { instanceConfig: { name: 'testco' }, transport: fakeAnchorTransport() });

    const pristine = readRecords(dataDir);

    // A full rewrite: edit a record and recompute every hash after it, exactly
    // what an operator with write access would do. The chain itself is happy.
    const rewritten = pristine.map((record) => ({ ...record }));
    rewritten[1] = { ...rewritten[1], payload: { note: 'rewritten' } };
    let prevHash = rewritten[0].hash;
    for (let i = 1; i < rewritten.length; i += 1) {
      rewritten[i].prevHash = prevHash;
      delete rewritten[i].hash;
      rewritten[i].hash = computeRecordHash(rewritten[i]);
      prevHash = rewritten[i].hash;
    }
    writeRecords(dataDir, rewritten);

    assert.equal(verifyEventChain(dataDir).valid, true, 'a recomputed chain is internally self-consistent');

    const rewriteCaught = verifyAgainstAnchors(dataDir);
    assert.equal(rewriteCaught.valid, false, 'but the anchor pins what the prefix used to hash to');
    assert.match(rewriteCaught.results[0].reason, /history at or before that point was rewritten/);

    // A truncated tail: what remains is a valid prefix, so the chain passes.
    writeRecords(dataDir, [pristine[0], pristine[1]]);
    assert.equal(verifyEventChain(dataDir).valid, true, 'a truncated log is still a valid chain');

    // The anchor event itself was cut off here, so re-publish a fresh log's
    // worth of context is not possible — instead assert against the anchor as
    // it was recorded, which is what an emailed copy preserves.
    const emailedAnchor = pristine[3];
    assert.equal(emailedAnchor.type, 'anchor.published');
    assert.equal(emailedAnchor.payload.count, 3);
    assert.ok(
      readRecords(dataDir).length < emailedAnchor.payload.count,
      'the surviving log is shorter than the anchor says it should be — detectable only against the external copy'
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('only an externally held anchor catches truncation — in-log anchors structurally cannot', async () => {
  const dataDir = makeTempDataDir();
  try {
    appendEvent(dataDir, makeEvent({ payload: { note: 'one' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'two' } }));
    appendEvent(dataDir, makeEvent({ payload: { note: 'three' } }));

    const transport = fakeAnchorTransport();
    await publishAnchor(dataDir, { instanceConfig: { name: 'testco' }, transport });
    // What the operator actually has in their mailbox.
    const emailed = { head: transport.sent[0].head, count: transport.sent[0].count };

    const pristine = readRecords(dataDir);
    assert.equal(verifyExternalAnchor(dataDir, emailed).valid, true);

    // Cut the tail. The anchor event lived at the end, so it goes too.
    writeRecords(dataDir, pristine.slice(0, 2));

    assert.equal(verifyEventChain(dataDir).valid, true, 'the surviving prefix is a valid chain');

    const inLog = verifyAgainstAnchors(dataDir);
    assert.equal(inLog.anchorCount, 0, 'truncation removed the in-log anchors along with the records');
    assert.equal(inLog.valid, true, 'so the in-log check has nothing left to fail on — it cannot see this');

    // An anchor at index i covers the i records before it, so any log still
    // holding that anchor is necessarily longer than the count it asserts.
    // The emailed copy is the only reference that outlives the cut.
    const external = verifyExternalAnchor(dataDir, emailed);
    assert.equal(external.valid, false);
    assert.equal(external.currentCount, 2);
    assert.match(external.reason, /1 record\(s\) were removed from the end/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('anchor email config fails closed, and the body carries no business content', () => {
  assert.throws(() => resolveAnchorRecipient({}), /no anchor.provider "email" configured/);
  assert.throws(
    () => resolveAnchorRecipient({ anchor: { provider: 'email' } }),
    /missing anchor.toEmailEnvVar/
  );
  assert.throws(
    () => resolveAnchorRecipient({ anchor: { provider: 'email', toEmailEnvVar: 'E3D_CORP_TEST_UNSET_ANCHOR' } }),
    /is not set/
  );

  const body = buildAnchorBody({
    instanceName: 'testco',
    head: 'a'.repeat(64),
    count: 412,
    publishedAt: '2026-08-16T14:00:00.000Z'
  });
  assert.match(body, /a{64}/);
  assert.match(body, /412/);
  assert.match(body, /event verify --instance testco/);
  // The anchor is two numbers and a hash; nothing about a client or a deal
  // may ever ride along in it.
  assert.equal(body.includes('@'), false, 'no email addresses');
  assert.match(body, /nothing in it identifies a client, a deal, or an amount/);
});

test('CLI: event verify reports an intact chain and exits non-zero on a broken one', () => {
  const { name, instanceDir } = setupTempInstance();
  try {
    for (const note of ['one', 'two']) {
      runCli([
        'event',
        'add',
        '--type',
        'market.signal.detected',
        '--source',
        'manual',
        '--payload',
        JSON.stringify({ note }),
        '--instance',
        name
      ]);
    }

    assert.match(runCli(['event', 'verify', '--instance', name]), /Event chain intact: 2 of 2/);

    const records = readRecords(instanceDir);
    records[0].payload = { note: 'tampered' };
    writeRecords(instanceDir, records);

    assert.throws(
      () => runCli(['event', 'verify', '--instance', name]),
      (error) => {
        assert.match(error.stderr.toString(), /Event chain BROKEN at record 0/);
        return true;
      }
    );
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});
