import fs from 'node:fs';
import path from 'node:path';

// Append-only, mirroring events.jsonl's own discipline - each recorded
// Outcome (lib/outcomes/record.js) appends a fresh snapshot rather than
// rewriting a prior line, so `readExperience` takes the latest line for a
// correlationId, same "fold, latest wins" pattern
// assembleOpportunities/assembleProposals already use over events.jsonl.
export function experienceFilePath(dataDir) {
  return path.join(dataDir, 'experience.jsonl');
}

export function appendExperience(dataDir, record) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(experienceFilePath(dataDir), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
  return record;
}

export function listExperience(dataDir) {
  const filePath = experienceFilePath(dataDir);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function readExperience(dataDir, correlationId) {
  const matches = listExperience(dataDir).filter((record) => record.correlationId === correlationId);
  return matches[matches.length - 1] ?? null;
}
