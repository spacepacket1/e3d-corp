#!/usr/bin/env node
// Transitions an instance config to Pilot (pilot.e3d.ai). DRY-RUN BY DEFAULT:
// prints a summary and the full new JSON path, writes nothing. With --apply it
// first copies instance.json to instance.json.pre-pilot.<timestamp>.bak, then
// writes atomically. Old crypto/oppscan/consulting topics move to `archived`.
//   node ops/migrate-instance-to-pilot.js --instance futco            # dry run
//   node ops/migrate-instance-to-pilot.js --instance futco --apply
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { instanceConfigPath, validateInstanceConfig } from '../lib/config.js';
import { migrateConfigToPilot } from '../lib/pilot/pilotInstanceConfig.js';

export function summarizeChange(before, after) {
  const lines = [];
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  lines.push(`researchTopics: ${count(before.researchTopics)} -> ${count(after.researchTopics)} (old ones archived: ${count(after.archived?.researchTopics)})`);
  lines.push(`research.x.searchQueries: ${count(before.research?.x?.searchQueries)} -> ${count(after.research?.x?.searchQueries)}`);
  lines.push(`research.x.topics: ${count(before.research?.x?.topics)} -> ${count(after.research?.x?.topics)}`);
  lines.push(`research.x.grounding: ${before.research?.x?.grounding ?? '(unset = e3d-findings)'} -> ${after.research?.x?.grounding ?? '(no research.x)'}`);
  lines.push(`scoring.typeWeights: ${Object.keys(before.scoring?.typeWeights ?? {}).join(',') || '(none)'} -> ${Object.keys(after.scoring.typeWeights).join(',')}`);
  lines.push(`ownDomains: ${(before.ownDomains ?? []).join(',')} -> ${after.ownDomains.join(',')}`);
  lines.push(`new roles: ${Object.keys(after.roles).filter((r) => !(r in (before.roles ?? {}))).join(', ') || '(none)'}`);
  lines.push(`pilotGrowth block: ${before.pilotGrowth ? 'merged' : 'added'}`);
  return lines;
}

export function migrateInstanceFile(filePath, { apply = false, now = () => new Date() } = {}) {
  const before = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const after = migrateConfigToPilot(before);
  const validation = validateInstanceConfig ? validateInstanceConfig(after) : null;
  const errors = validation?.errors ?? [];
  const result = { before, after, errors, summary: summarizeChange(before, after), applied: false, backupPath: null };
  if (apply) {
    if (errors.length) throw new Error(`Refusing to apply: migrated config fails validation\n- ${errors.join('\n- ')}`);
    result.backupPath = `${filePath}.pre-pilot.${now().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(filePath, result.backupPath);
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(after, null, 2)}\n`);
    fs.renameSync(tmp, filePath);
    result.applied = true;
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const instance = args.includes('--instance') ? args[args.indexOf('--instance') + 1] : null;
  const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
  if (!instance && !fileArg) throw new Error('usage: migrate-instance-to-pilot.js --instance <name> | --file <path> [--apply]');
  const filePath = fileArg ?? instanceConfigPath(instance);
  const result = migrateInstanceFile(filePath, { apply: args.includes('--apply') });
  process.stdout.write(`${result.applied ? 'APPLIED' : 'DRY RUN (nothing written; pass --apply)'}: ${filePath}\n`);
  result.summary.forEach((line) => process.stdout.write(`  ${line}\n`));
  if (result.errors.length) process.stdout.write(`  validation errors:\n${result.errors.map((e) => `    - ${e}`).join('\n')}\n`);
  if (result.backupPath) process.stdout.write(`  backup: ${result.backupPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
