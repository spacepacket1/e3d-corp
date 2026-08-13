import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function eventsFilePath(dataDir) {
  return path.join(dataDir, 'events.jsonl');
}

function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readAllEvents(dataDir) {
  const filePath = eventsFilePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateEventInput(event, errors) {
  if (!isNonEmptyString(event.type)) {
    errors.push('type: must be a non-empty string');
  }
  if (!isNonEmptyString(event.source)) {
    errors.push('source: must be a non-empty string');
  }
  if (event.subject === undefined || event.subject === null || typeof event.subject !== 'object') {
    errors.push('subject: must be an object with { type, id }');
  } else {
    if (!isNonEmptyString(event.subject.type)) {
      errors.push('subject.type: must be a non-empty string');
    }
    if (!isNonEmptyString(event.subject.id)) {
      errors.push('subject.id: must be a non-empty string');
    }
  }
  if (event.payload === undefined) {
    errors.push('payload: is required');
  }
  if (!isNonEmptyString(event.correlationId)) {
    errors.push('correlationId: must be a non-empty string');
  }
  if (
    event.causationId !== null &&
    event.causationId !== undefined &&
    !isNonEmptyString(event.causationId)
  ) {
    errors.push('causationId: must be a non-empty string or null');
  }
}

export function appendEvent(dataDir, event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Event must be an object');
  }

  const errors = [];
  validateEventInput(event, errors);
  if (errors.length > 0) {
    throw new Error(`Invalid event:\n- ${errors.join('\n- ')}`);
  }

  const causationId = event.causationId ?? null;
  if (causationId !== null) {
    const found = readAllEvents(dataDir).some((existing) => existing.id === causationId);
    if (!found) {
      throw new Error(
        `Invalid event: causationId "${causationId}" does not reference an existing event`
      );
    }
  }

  const record = {
    id: event.id ?? crypto.randomUUID(),
    type: event.type,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    source: event.source,
    subject: { type: event.subject.type, id: event.subject.id },
    payload: event.payload,
    causationId,
    correlationId: event.correlationId
  };

  ensureDataDir(dataDir);
  // A single appendFileSync call with the O_APPEND flag is one write() syscall
  // for lines under PIPE_BUF, which the OS guarantees not to interleave across
  // concurrent writers — that's what keeps concurrent appends from corrupting
  // the file without needing a separate lock file.
  fs.appendFileSync(eventsFilePath(dataDir), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'a'
  });

  return record;
}

export function queryEvents(dataDir, { type, subject, correlationId, since } = {}) {
  let events = readAllEvents(dataDir);

  if (type) {
    events = events.filter((event) => event.type === type);
  }
  if (subject) {
    events = events.filter((event) => {
      if (!event.subject) return false;
      if (subject.type !== undefined && event.subject.type !== subject.type) return false;
      if (subject.id !== undefined && event.subject.id !== subject.id) return false;
      return true;
    });
  }
  if (correlationId) {
    events = events.filter((event) => event.correlationId === correlationId);
  }
  if (since) {
    const sinceTime = new Date(since).getTime();
    events = events.filter((event) => new Date(event.occurredAt).getTime() >= sinceTime);
  }

  return events.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
}
