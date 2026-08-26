import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { callLocalLlm } from '../lib/llm/localClient.js';
import { callGrokCli } from '../lib/llm/grokCliClient.js';
import { loadInstanceConfig, validateInstanceConfig } from '../lib/config.js';
import { resolveProvider } from '../lib/llm/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function runCli(args, options = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function withEnv(tempEnv, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(tempEnv)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const finalize = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
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

test('help output documents provider status and later-phase commands', () => {
  const output = runCli(['--help']);
  assert.match(output, /providers status --instance <name>/);
  assert.match(output, /opportunities check-shipped <id>/);
  assert.match(output, /evaluate report/);
  assert.match(output, /Implemented so far: `config validate`, `providers status`, `event add`, `event log`/);
});

test('legacy flat llm config fails validation with an explicit llm.providers migration error', () => {
  const result = validateInstanceConfig({
    name: 'legacy',
    dataDir: '.e3d-corp/instance/legacy',
    llm: { baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
    research: { webSearchProvider: 'disabled' },
    eventSources: [],
    roles: { 'opportunity.prospect': { provider: 'local', model: '$LLM_MODEL' } }
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('llm.providers')));
  assert.ok(result.errors.some((error) => error.includes('llm.baseUrlEnvVar')));
  assert.ok(result.errors.some((error) => error.includes('roles.opportunity.prospect.model')));
});

test('unknown role provider fails validation with a role-specific error', () => {
  const result = validateInstanceConfig({
    name: 'unknown-provider',
    dataDir: '.e3d-corp/instance/unknown-provider',
    llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' } } },
    research: { webSearchProvider: 'disabled' },
    eventSources: [],
    roles: { 'opportunity.prospect': { provider: 'grok' } }
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes('roles.opportunity.prospect.provider: references unknown provider "grok"')
    )
  );
});

test('providers status reports missing Grok binary and missing hosted API key without making a call', () => {
  const instanceName = `phase1-status-${process.pid}-${Date.now()}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', instanceName);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify(
      {
        name: instanceName,
        dataDir: `.e3d-corp/instance/${instanceName}`,
        llm: {
          providers: {
            hosted: {
              kind: 'openai-compatible',
              baseUrlEnvVar: 'PHASE1_HOSTED_BASE_URL',
              modelEnvVar: 'PHASE1_HOSTED_MODEL',
              apiKeyEnvVar: 'PHASE1_HOSTED_API_KEY'
            },
            grok: {
              kind: 'grok-cli',
              binEnvVar: 'PHASE1_GROK_BIN'
            }
          }
        },
        research: { webSearchProvider: 'disabled' },
        eventSources: [],
        roles: {}
      },
      null,
      2
    )
  );

  try {
    assert.throws(
      () =>
        withEnv(
          {
            PHASE1_HOSTED_BASE_URL: 'https://hosted.example.invalid/v1',
            PHASE1_HOSTED_MODEL: 'gpt-test',
            PHASE1_HOSTED_API_KEY: undefined,
            PHASE1_GROK_BIN: 'definitely-not-a-real-grok-binary'
          },
          () => runCli(['providers', 'status', '--instance', instanceName])
        ),
      (error) => {
        const stdout = error.stdout.toString();
        assert.match(stdout, /hosted \(openai-compatible\): not-ready/);
        assert.match(stdout, /missing env var PHASE1_HOSTED_API_KEY/);
        assert.match(stdout, /grok \(grok-cli\): not-ready/);
        assert.match(stdout, /missing binary definitely-not-a-real-grok-binary/);
        return true;
      }
    );
  } finally {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
});

test('resolveProvider returns grok-cli-default when no model env var is configured', () => {
  const grokStub = path.join(os.tmpdir(), `phase1-grok-default-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(grokStub, '#!/bin/sh\necho "stub output"\n', 'utf8');
  fs.chmodSync(grokStub, 0o755);

  try {
    const provider = withEnv({ PHASE1_REALISTIC_GROK_BIN: grokStub }, () =>
      resolveProvider(
        {
          llm: {
            providers: {
              grok: { kind: 'grok-cli', binEnvVar: 'PHASE1_REALISTIC_GROK_BIN' }
            }
          }
        },
        'grok'
      )
    );
    assert.equal(typeof provider.call, 'function');
    assert.equal(provider.model, 'grok-cli-default');
  } finally {
    fs.rmSync(grokStub, { force: true });
  }
});

test('resolveProvider names the missing env var for hosted providers', () => {
  assert.throws(
    () =>
      withEnv(
        {
          PHASE1_OAI_BASE_URL: 'https://hosted.example.invalid/v1',
          PHASE1_OAI_MODEL: 'gpt-test',
          PHASE1_OAI_API_KEY: undefined
        },
        () =>
          resolveProvider(
            {
              llm: {
                providers: {
                  hosted: {
                    kind: 'openai-compatible',
                    baseUrlEnvVar: 'PHASE1_OAI_BASE_URL',
                    modelEnvVar: 'PHASE1_OAI_MODEL',
                    apiKeyEnvVar: 'PHASE1_OAI_API_KEY'
                  }
                }
              }
            },
            'hosted'
          )
      ),
    /Provider "hosted" is not ready: LLM API key env var "PHASE1_OAI_API_KEY" is not set/
  );
});

test('local HTTP provider aborts on timeout instead of hanging', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  try {
    await assert.rejects(
      callLocalLlm({
        baseUrl: 'http://llm.example.invalid',
        model: 'timeout-test',
        systemPrompt: 'system',
        userPrompt: 'user',
        timeoutMs: 50
      }),
      /timed out after 50ms/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('local HTTP provider returns text plus normalized usage', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: 'OK.' } }],
        usage: { prompt_tokens: 38, completion_tokens: 0, total_tokens: 39 }
      };
    }
  });

  try {
    const result = await callLocalLlm({
      baseUrl: 'http://llm.example.invalid',
      model: 'usage-test',
      systemPrompt: 'system',
      userPrompt: 'user'
    });
    assert.deepEqual(result, {
      text: 'OK.',
      usage: { promptTokens: 38, completionTokens: 0, totalTokens: 39 },
      costUsd: null
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('grok CLI provider kills the subprocess on timeout', async () => {
  const scriptPath = path.join(os.tmpdir(), `phase1-grok-timeout-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(
    scriptPath,
    '#!/bin/sh\nsleep 5\nprintf "too late\\n"\n',
    'utf8'
  );
  fs.chmodSync(scriptPath, 0o755);

  try {
    await assert.rejects(
      callGrokCli({
        binaryPath: scriptPath,
        model: 'grok-cli-default',
        systemPrompt: 'system',
        userPrompt: 'user',
        timeoutMs: 50
      }),
      /timed out after 50ms/
    );
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
});

test('grok CLI provider parses JSON output into text, usage, and cost', async () => {
  const scriptPath = path.join(os.tmpdir(), `phase1-grok-json-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(
    scriptPath,
    '#!/bin/sh\nprintf \'{"text":"OK.","usage":{"input_tokens":2551,"output_tokens":26,"total_tokens":14097},"total_cost_usd":0.00187306}\\n\'\n',
    'utf8'
  );
  fs.chmodSync(scriptPath, 0o755);

  try {
    const result = await callGrokCli({
      binaryPath: scriptPath,
      model: 'grok-cli-default',
      systemPrompt: 'system',
      userPrompt: 'user',
      timeoutMs: 1_000
    });
    assert.deepEqual(result, {
      text: 'OK.',
      usage: { promptTokens: 2551, completionTokens: 26, totalTokens: 14097 },
      costUsd: 0.00187306
    });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
});

test('grok CLI provider treats malformed JSON output as a call failure', async () => {
  const scriptPath = path.join(os.tmpdir(), `phase1-grok-bad-json-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf "not-json\\n"\n', 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  try {
    await assert.rejects(
      callGrokCli({
        binaryPath: scriptPath,
        model: 'grok-cli-default',
        systemPrompt: 'system',
        userPrompt: 'user',
        timeoutMs: 1_000
      }),
      /invalid JSON/
    );
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
});

test('futco instance directory placeholder exists', () => {
  const keepPath = path.join(ROOT, '.e3d-corp', 'instance', 'futco', '.gitkeep');
  assert.equal(fs.existsSync(keepPath), true);
  assert.equal(fs.statSync(path.dirname(keepPath)).isDirectory(), true);
});

test('example and futco configs use the provider registry shape', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'instance.example.json'), 'utf8'));
  const futco = JSON.parse(fs.readFileSync(path.join(ROOT, '.e3d-corp', 'instance', 'futco', 'instance.json'), 'utf8'));

  assert.equal(example.name, 'exampleco');
  assert.equal(example.eventSources.length, 0);
  assert.deepEqual(example.roles['opportunity.prospect'], { provider: 'local' });
  assert.equal(example.llm.providers.local.kind, 'local');

  assert.deepEqual(futco.roles['opportunity.communicator'], { provider: 'local' });
  assert.equal(futco.llm.providers.grok.kind, 'grok-cli');
});
