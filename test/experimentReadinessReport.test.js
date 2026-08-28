import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = path.join(ROOT, 'docs', 'e3d-corp-e3d-trade-experiment-readiness.md');

test('Phase 8 readiness report exists and covers the required readiness conclusions', () => {
  assert.equal(fs.existsSync(REPORT_PATH), true, 'expected readiness report to exist');

  const report = fs.readFileSync(REPORT_PATH, 'utf8');

  assert.match(report, /Governed vs\. Ungoverned Experiment Readiness/i);
  assert.match(report, /CONTROL/i);
  assert.match(report, /TREATMENT/i);
  assert.match(report, /live E3D input stream|live input stream/i);
  assert.match(report, /two isolated `e3d-trade` runtimes|second isolated `e3d-trade` paper instance/i);
  assert.match(report, /GO for testability in days/i);
  assert.match(report, /NO-GO until the twin-runtime isolation and environment wiring are in place/i);
  assert.match(report, /remaining work is operator setup, environment wiring, and experiment packaging/i);
});
