import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadInstanceConfig, validateInstanceConfig } from '../lib/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('validateInstanceConfig accepts the example config', () => {
  const configPath = path.join(ROOT, 'examples', 'instance.example.json');
  const config = loadInstanceConfig(configPath);
  const result = validateInstanceConfig(config);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('cli config validate passes for the example config', () => {
  const output = runCli(['config', 'validate', 'examples/instance.example.json']);
  assert.match(output, /examples\/instance\.example\.json: valid/);
});

test('cli config validate fails clearly for a missing file', () => {
  assert.throws(
    () => runCli(['config', 'validate', 'examples/does-not-exist.json']),
    (error) => {
      assert.match(error.stderr.toString(), /Config file not found: .*does-not-exist\.json/);
      return true;
    }
  );
});

test('cli config validate accepts the futco instance config', () => {
  const output = runCli(['config', 'validate', '.e3d-corp/instance/futco/instance.json']);
  assert.match(output, /\.e3d-corp\/instance\/futco\/instance\.json: valid/);
});

test('help output documents phase 1 and later-phase commands', () => {
  const output = runCli(['--help']);
  assert.match(output, /config validate <instance-config-path>/);
  assert.match(output, /opportunities check-shipped <id>/);
  assert.match(output, /evaluate report/);
  assert.match(output, /Implemented so far: `config validate`, `event add`, `event log`/);
});

test('futco instance directory placeholder exists', () => {
  const keepPath = path.join(ROOT, '.e3d-corp', 'instance', 'futco', '.gitkeep');
  assert.equal(fs.existsSync(keepPath), true);
  assert.equal(fs.statSync(path.dirname(keepPath)).isDirectory(), true);
});

test('example config is valid JSON with expected instance name', () => {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'instance.example.json'), 'utf8'));
  assert.equal(json.name, 'exampleco');
  assert.equal(json.eventSources.length, 0);
});
