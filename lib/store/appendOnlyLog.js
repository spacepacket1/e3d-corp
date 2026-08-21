// Tamper-evidence primitives for the append-only JSON-lines stores.
//
// `events.jsonl` (and, from Phase 11, `ledger.jsonl`) are append-only by
// convention - nothing structurally prevented a past record from being
// edited in place, which is exactly the property an audit trail is supposed
// to have. Each record carries a `prevHash` linking it to the one before it
// and a `hash` over its own content including that link, so altering any
// historical record invalidates every record written after it. Detection,
// not prevention: a single operator can still rewrite the whole file and
// recompute every hash downstream. What this buys is that a *partial* edit -
// the realistic failure, whether malicious or a botched script - cannot pass
// unnoticed, and that a hash published elsewhere pins the whole history.
//
// Deliberately not a blockchain: the adversary model for a company's own
// books is not mutually distrusting parties needing consensus, and the
// content here (client names, deal amounts, revenue) is exactly what the
// spec forbids ever leaving the private instance directory.

import crypto from 'node:crypto';
import fs from 'node:fs';

export const HASH_ALGORITHM = 'sha256';

// Canonical serialization: object keys sorted recursively so the same
// logical record always produces the same digest regardless of the key order
// it happened to be constructed in. Mirrors JSON.stringify's treatment of
// undefined-valued keys (dropped) so a record round-tripped through
// JSON.parse hashes identically to the one that was written.
export function canonicalizeJson(value) {
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Covers every field except `hash` itself - `prevHash` included, which is
// what makes each link commit to the entire history behind it rather than
// just to its immediate predecessor's content.
export function computeRecordHash(record) {
  const { hash, ...rest } = record;
  return crypto.createHash(HASH_ALGORITHM).update(canonicalizeJson(rest)).digest('hex');
}

// Seals a run of records written before hash-chaining existed. The first
// chained record's prevHash is this digest, so pre-existing history still
// cannot be altered without breaking the chain that follows it - no
// rewriting of the historical file required to adopt chaining.
export function sealHash(records) {
  const canonical = records.map((record) => canonicalizeJson(record)).join('\n');
  return crypto.createHash(HASH_ALGORITHM).update(canonical).digest('hex');
}

function isChained(record) {
  return typeof record?.hash === 'string' && record.hash !== '';
}

// The prevHash the next appended record should carry, given everything
// already in the log.
export function resolveNextPrevHash(records) {
  if (records.length === 0) {
    return null;
  }
  const last = records[records.length - 1];
  if (isChained(last)) {
    return last.hash;
  }
  return sealHash(records);
}

// Walks the log and reports the first break. Records written before chaining
// was introduced are reported as `unchained`, not as failures - they are a
// known, bounded prefix, and the seal means they are still covered from the
// first chained record onward.
export function verifyHashChain(records) {
  const firstChainedIndex = records.findIndex((record) => isChained(record));

  if (firstChainedIndex === -1) {
    return {
      valid: true,
      total: records.length,
      chained: 0,
      unchained: records.length,
      brokenAt: null,
      reason: null
    };
  }

  const legacy = records.slice(0, firstChainedIndex);
  let expectedPrevHash = firstChainedIndex === 0 ? null : sealHash(legacy);

  for (let index = firstChainedIndex; index < records.length; index += 1) {
    const record = records[index];

    if (!isChained(record)) {
      return {
        valid: false,
        total: records.length,
        chained: index - firstChainedIndex,
        unchained: legacy.length,
        brokenAt: index,
        reason: `record ${index} (id ${record?.id ?? 'unknown'}) has no hash but follows chained records`
      };
    }

    const expected = expectedPrevHash === undefined ? null : expectedPrevHash;
    const actual = record.prevHash ?? null;
    if (actual !== expected) {
      return {
        valid: false,
        total: records.length,
        chained: index - firstChainedIndex,
        unchained: legacy.length,
        brokenAt: index,
        reason:
          `record ${index} (id ${record.id}) has prevHash ${actual ?? 'null'}, ` +
          `but the preceding history hashes to ${expected ?? 'null'} — a record before this one was altered or removed`
      };
    }

    const recomputed = computeRecordHash(record);
    if (recomputed !== record.hash) {
      return {
        valid: false,
        total: records.length,
        chained: index - firstChainedIndex,
        unchained: legacy.length,
        brokenAt: index,
        reason: `record ${index} (id ${record.id}) hashes to ${recomputed}, but carries ${record.hash} — this record's own content was altered`
      };
    }

    expectedPrevHash = record.hash;
  }

  return {
    valid: true,
    total: records.length,
    chained: records.length - firstChainedIndex,
    unchained: legacy.length,
    brokenAt: null,
    reason: null
  };
}

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// An exclusive lock around read-then-append. O_APPEND alone keeps concurrent
// writes from interleaving, but hash chaining adds a read-modify-write: two
// writers that both read the same tail would both claim the same prevHash and
// fork the chain. A daily discovery pass and a periodic calendar poll can
// genuinely overlap, and the lead webhook can fire at any moment - so this is
// a real race, not a theoretical one.
export function withFileLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      // Reclaim a lock left behind by a process that died mid-append.
      // Appends take milliseconds, so anything this old is abandoned.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') {
          throw statError;
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for append lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}
