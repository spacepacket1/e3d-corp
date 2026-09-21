import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEvent, queryEvents, readAllEventRecords } from '../lib/events/store.js';
import { listExecutedActions } from '../lib/actions/log.js';
import { getActionExecutor } from '../lib/actions/registry.js';
import { run } from '../lib/cli.js';
import { runRiskAssess } from '../lib/roles/riskAssess.js';

const ORIGINAL_ENV = {
  RISK_LLM_BASE_URL: process.env.RISK_LLM_BASE_URL,
  RISK_LLM_MODEL: process.env.RISK_LLM_MODEL,
  RISK_LLM_MODEL_ALPHA: process.env.RISK_LLM_MODEL_ALPHA,
  RISK_LLM_MODEL_BETA: process.env.RISK_LLM_MODEL_BETA
};

process.env.RISK_LLM_BASE_URL = process.env.RISK_LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.RISK_LLM_MODEL = process.env.RISK_LLM_MODEL ?? 'risk-model-local';
process.env.RISK_LLM_MODEL_ALPHA = process.env.RISK_LLM_MODEL_ALPHA ?? 'risk-model-alpha';
process.env.RISK_LLM_MODEL_BETA = process.env.RISK_LLM_MODEL_BETA ?? 'risk-model-beta';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

test.after(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
      continue;
    }
    process.env[name] = value;
  }
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-risk-assess-'));
}

function runCli(args, options = {}) {
  const { env, ...rest } = options;
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    ...rest
  });
}

function makeTempInstance(extra = {}) {
  const name = `risk-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  const dataDir = `.e3d-corp/instance/${name}`;
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify(
      {
        name,
        dataDir,
        llm: {
          providers: {
            local: {
              kind: 'local',
              baseUrlEnvVar: 'RISK_CLI_TEST_BASE_URL',
              modelEnvVar: 'RISK_CLI_TEST_MODEL'
            }
          }
        },
        research: {
          webSearchProvider: 'disabled'
        },
        eventSources: [],
        roles: {
          'risk.assess': {
            provider: 'local'
          }
        },
        ...extra
      },
      null,
      2
    )
  );

  return {
    name,
    instanceDir,
    dataDir: path.join(ROOT, dataDir)
  };
}

function cleanupTempInstance(instance) {
  fs.rmSync(instance.instanceDir, { recursive: true, force: true });
}

function readStoredEvents(dataDir) {
  const eventLogPath = path.join(dataDir, 'events.jsonl');
  if (!fs.existsSync(eventLogPath)) {
    return [];
  }
  return readAllEventRecords(dataDir);
}

async function captureRun(args, { env = {}, fetchImpl } = {}) {
  const stdout = [];
  const stderr = [];
  const previousExitCode = process.exitCode;
  const previousFetch = globalThis.fetch;
  const previousEnv = new Map();
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk, encoding, callback) => {
    stdout.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  });
  process.stderr.write = ((chunk, encoding, callback) => {
    stderr.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  });

  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  if (fetchImpl !== undefined) {
    globalThis.fetch = fetchImpl;
  }

  process.exitCode = undefined;

  try {
    const code = await run(args);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = previousExitCode;
    if (fetchImpl !== undefined) {
      globalThis.fetch = previousFetch;
    }
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function baseInstanceConfig(overrides = {}) {
  return {
    name: 'ExampleCo',
    llm: {
      providers: {
        local: {
          kind: 'local',
          baseUrlEnvVar: 'RISK_LLM_BASE_URL',
          modelEnvVar: 'RISK_LLM_MODEL'
        }
      }
    },
    roles: {
      'risk.assess': {
        provider: 'local'
      }
    },
    ...overrides
  };
}

function appendHistoryEvent(
  dataDir,
  { id, occurredAt, subject = { type: 'vendor', id: 'vendor-42' }, payload = {}, correlationId = `history-${id}` }
) {
  return appendEvent(dataDir, {
    type: 'invoice.recorded',
    source: 'test',
    subject,
    payload,
    causationId: null,
    correlationId,
    occurredAt
  });
}

function appendRequestEvent(dataDir, overrides = {}) {
  const requestId = overrides.requestId ?? 'request-1';
  const correlationId = overrides.correlationId ?? 'risk-corr-1';
  return appendEvent(dataDir, {
    type: 'payment-request.received',
    source: 'cli',
    subject: { type: 'payment-request', id: requestId },
    payload: {
      requestId,
      vendorId: ' vendor-42 ',
      vendorName: '  Vendor Forty Two  ',
      amount: 2500,
      currency: ' usd ',
      description: '  September invoice  ',
      ...(overrides.payload ?? {})
    },
    causationId: null,
    correlationId,
    occurredAt: overrides.occurredAt ?? '2026-09-18T10:30:00.000Z'
  });
}

function llmResponse(text) {
  return { text };
}

test('runRiskAssess builds a bounded vendor-history prompt and creates one pending flag-payment-request proposal', async () => {
  const dataDir = makeTempDataDir();

  try {
    const relevantIds = [];
    for (let index = 0; index < 22; index += 1) {
      const id = `history-${String(index).padStart(2, '0')}`;
      relevantIds.push(
        appendHistoryEvent(dataDir, {
          id,
          occurredAt: `2026-09-18T09:${String(index).padStart(2, '0')}:00.000Z`,
          payload: { vendorId: 'vendor-42', note: `history ${index}` }
        }).id
      );
    }

    appendHistoryEvent(dataDir, {
      id: 'unrelated-history',
      occurredAt: '2026-09-18T09:59:00.000Z',
      subject: { type: 'vendor', id: 'vendor-other' },
      payload: { vendorId: 'vendor-other' }
    });

    const requestEvent = appendRequestEvent(dataDir);

    appendHistoryEvent(dataDir, {
      id: 'future-history',
      occurredAt: '2026-09-18T10:31:00.000Z',
      payload: { vendorId: 'vendor-42' }
    });

    let capturedPrompt = null;
    const result = await runRiskAssess({
      instanceConfig: baseInstanceConfig(),
      dataDir,
      requestEvent,
      llmClient: async ({ systemPrompt, userPrompt }) => {
        const parsedUserPrompt = JSON.parse(userPrompt);
        capturedPrompt = {
          systemPrompt,
          userPrompt: parsedUserPrompt
        };
        return llmResponse(
          JSON.stringify({
            verdict: 'HOLD',
            reasoning: '  Hold until vendor callback confirms details.  ',
            riskFactors: ['  bank details changed  '],
            evidenceEventIds: [requestEvent.id, parsedUserPrompt.allowedEvidenceEventIds[1]]
          })
        );
      }
    });

    assert.ok(capturedPrompt);
    assert.match(capturedPrompt.systemPrompt, /APPROVE is only a recommendation/i);
    assert.match(capturedPrompt.systemPrompt, /Use CHECK when the evidence is insufficient/i);
    assert.match(capturedPrompt.systemPrompt, /ambiguous/i);
    assert.equal(capturedPrompt.userPrompt.requestEvent.id, requestEvent.id);
    assert.equal(capturedPrompt.userPrompt.priorVendorEvents.length, 20);
    assert.deepEqual(
      capturedPrompt.userPrompt.priorVendorEvents.map((event) => event.id),
      relevantIds.slice(-20).reverse()
    );
    assert.ok(!capturedPrompt.userPrompt.priorVendorEvents.some((event) => event.id === 'unrelated-history'));
    assert.ok(!capturedPrompt.userPrompt.priorVendorEvents.some((event) => event.id === 'future-history'));
    assert.deepEqual(capturedPrompt.userPrompt.allowedEvidenceEventIds, [requestEvent.id, ...relevantIds.slice(-20).reverse()]);

    assert.equal(result.proposal.type, 'flag-payment-request');
    assert.equal(result.proposal.authorityLevel, 3);
    assert.equal(result.proposal.status, 'pending');
    assert.equal(result.proposal.causationId, requestEvent.id);
    assert.equal(result.proposal.correlationId, requestEvent.correlationId);
    assert.deepEqual(result.proposal.proposedBy, {
      role: 'risk.assess',
      provider: 'local',
      model: 'risk-model-local'
    });
    assert.deepEqual(result.proposal.payload.request, {
      requestId: 'request-1',
      vendorId: 'vendor-42',
      vendorName: 'Vendor Forty Two',
      amount: 2500,
      currency: 'USD',
      description: 'September invoice'
    });
    assert.deepEqual(result.proposal.payload.assessment, {
      verdict: 'HOLD',
      reasoning: 'Hold until vendor callback confirms details.',
      riskFactors: ['bank details changed'],
      evidenceEventIds: [requestEvent.id, capturedPrompt.userPrompt.allowedEvidenceEventIds[1]]
    });
    assert.equal(result.event.type, 'proposal.created');
    assert.equal(result.event.causationId, requestEvent.id);
    assert.equal(result.event.correlationId, requestEvent.correlationId);

    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'proposal.approved' }).length, 0);
    assert.equal(queryEvents(dataDir, { type: 'proposal.rejected' }).length, 0);
    assert.equal(queryEvents(dataDir, { type: 'role.provider.completed' }).length, 0);
    assert.equal(queryEvents(dataDir, { type: 'role.provider.failed' }).length, 0);
    assert.deepEqual(listExecutedActions(dataDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runRiskAssess creates a pending level-3 proposal for HOLD, CHECK, and APPROVE without decisions or actions', async () => {
  for (const verdict of ['HOLD', 'CHECK', 'APPROVE']) {
    const dataDir = makeTempDataDir();
    try {
      const requestEvent = appendRequestEvent(dataDir, {
        requestId: `request-${verdict.toLowerCase()}`,
        correlationId: `corr-${verdict.toLowerCase()}`
      });

      const result = await runRiskAssess({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        requestEvent,
        llmClient: async () =>
          llmResponse(
            JSON.stringify({
              verdict,
              reasoning: ` ${verdict} reasoning `,
              riskFactors: [],
              evidenceEventIds: []
            })
          )
      });

      assert.equal(result.proposal.status, 'pending');
      assert.equal(result.proposal.authorityLevel, 3);
      assert.equal(result.proposal.payload.assessment.verdict, verdict);
      assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 1);
      assert.equal(queryEvents(dataDir, { type: 'proposal.approved' }).length, 0);
      assert.equal(queryEvents(dataDir, { type: 'proposal.rejected' }).length, 0);
      assert.deepEqual(listExecutedActions(dataDir), []);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test('invalid or ungrounded model output leaves the request event in place and creates no proposal', async () => {
  const dataDir = makeTempDataDir();

  try {
    appendHistoryEvent(dataDir, {
      id: 'history-evidence',
      occurredAt: '2026-09-18T09:15:00.000Z',
      payload: { vendorId: 'vendor-42' }
    });
    const requestEvent = appendRequestEvent(dataDir, {
      requestId: 'request-invalid',
      correlationId: 'corr-invalid'
    });

    await assert.rejects(
      runRiskAssess({
        instanceConfig: baseInstanceConfig(),
        dataDir,
        requestEvent,
        llmClient: async () =>
          llmResponse(
            JSON.stringify({
              verdict: 'CHECK',
              reasoning: 'Need more validation.',
              riskFactors: ['unverified bank change'],
              evidenceEventIds: ['fabricated-evidence-id']
            })
          )
      }),
      /evidenceEventIds must only cite supplied event ids/
    );

    const records = readAllEventRecords(dataDir);
    assert.equal(records.filter((event) => event.type === 'payment-request.received').length, 1);
    assert.equal(records.filter((event) => event.type === 'proposal.created').length, 0);
    assert.equal(records.at(-1).id, requestEvent.id);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('provider and model attribution come from the configured first provider, not model output', async () => {
  const dataDir = makeTempDataDir();

  try {
    const requestEvent = appendRequestEvent(dataDir, {
      requestId: 'request-provider-array',
      correlationId: 'corr-provider-array'
    });
    let calls = 0;

    const result = await runRiskAssess({
      instanceConfig: baseInstanceConfig({
        llm: {
          providers: {
            alpha: {
              kind: 'local',
              baseUrlEnvVar: 'RISK_LLM_BASE_URL',
              modelEnvVar: 'RISK_LLM_MODEL_ALPHA'
            },
            beta: {
              kind: 'local',
              baseUrlEnvVar: 'RISK_LLM_BASE_URL',
              modelEnvVar: 'RISK_LLM_MODEL_BETA'
            }
          }
        },
        roles: {
          'risk.assess': {
            provider: ['alpha', 'beta']
          }
        }
      }),
      dataDir,
      requestEvent,
      llmClient: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            verdict: 'CHECK',
            reasoning: 'The model might mention beta, but config still wins.',
            riskFactors: [],
            evidenceEventIds: []
          }),
          model: 'invented-model-output'
        };
      }
    });

    assert.equal(calls, 1);
    assert.deepEqual(result.proposal.proposedBy, {
      role: 'risk.assess',
      provider: 'alpha',
      model: 'risk-model-alpha'
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('missing roles.risk.assess config throws before any provider call', async () => {
  const dataDir = makeTempDataDir();

  try {
    const requestEvent = appendRequestEvent(dataDir, {
      requestId: 'request-missing-config',
      correlationId: 'corr-missing-config'
    });
    let calls = 0;

    await assert.rejects(
      runRiskAssess({
        instanceConfig: {
          name: 'ExampleCo',
          llm: {
            providers: {
              local: {
                kind: 'local',
                baseUrlEnvVar: 'RISK_LLM_BASE_URL',
                modelEnvVar: 'RISK_LLM_MODEL'
              }
            }
          },
          roles: {}
        },
        dataDir,
        requestEvent,
        llmClient: async () => {
          calls += 1;
          return llmResponse('{}');
        }
      }),
      /missing roles\.risk\.assess\.provider/
    );

    assert.equal(calls, 0);
    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('request submit help shows the public command shape', () => {
  const output = runCli(['request', 'submit', '--help']);
  assert.match(
    output,
    /request submit --instance <name> --vendor-id <id> --vendor-name <name> --amount <number> --currency <code> --description <text>/
  );
});

test('request submit rejects invalid flags before writing events or calling a provider', { concurrency: false }, async () => {
  const instance = makeTempInstance();
  let fetchCalls = 0;
  const env = {
    RISK_CLI_TEST_BASE_URL: 'http://risk-cli-test.invalid',
    RISK_CLI_TEST_MODEL: 'risk-cli-model'
  };

  const cases = [
    {
      args: [
        'request',
        'submit',
        '--instance',
        instance.name,
        '--vendor-id',
        'vendor-42',
        '--amount',
        '2500',
        '--currency',
        'USD',
        '--description',
        'September invoice'
      ],
      error: /request submit requires --vendor-name <name>/
    },
    {
      args: [
        'request',
        'submit',
        '--instance',
        instance.name,
        '--vendor-id',
        'vendor-42',
        '--vendor-name',
        'Vendor Forty Two',
        '--amount',
        '--currency',
        'USD',
        '--description',
        'September invoice'
      ],
      error: /request submit requires --amount <number>/
    },
    {
      args: [
        'request',
        'submit',
        '--instance',
        instance.name,
        '--vendor-id',
        'vendor-42',
        '--vendor-name',
        'Vendor Forty Two',
        '--amount',
        'not-a-number',
        '--currency',
        'USD',
        '--description',
        'September invoice'
      ],
      error: /request submit requires --amount <number> as a positive number/
    },
    {
      args: [
        'request',
        'submit',
        '--instance',
        instance.name,
        '--vendor-id',
        'vendor-42',
        '--vendor-name',
        'Vendor Forty Two',
        '--amount',
        '2500',
        '--currency',
        'US',
        '--description',
        'September invoice'
      ],
      error: /request submit requires --currency <code> as a 3-letter ISO code/
    },
    {
      args: [
        'request',
        'submit',
        '--instance',
        instance.name,
        '--vendor-id',
        'vendor-42',
        '--vendor-name',
        'Vendor Forty Two',
        '--amount',
        '2500',
        '--currency',
        'USD',
        '--description',
        'September invoice',
        '--due-date',
        'not-a-date'
      ],
      error: /request submit requires --due-date <iso> to be a valid date string/
    }
  ];

  try {
    for (const testCase of cases) {
      const result = await captureRun(testCase.args, {
        env,
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error('fetch should not be called for invalid request submit input');
        }
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, testCase.error);
      assert.equal(fetchCalls, 0);
      assert.deepEqual(readStoredEvents(instance.dataDir), []);
    }
  } finally {
    cleanupTempInstance(instance);
  }
});

test('request submit records a normalized request event and one pending proposal end to end', { concurrency: false }, async () => {
  const instance = makeTempInstance();
  const requests = [];

  try {
    const result = await captureRun(
      [
        'request',
        'submit',
        '--instance',
        instance.name,
        '--vendor-id',
        ' Vendor-42 ',
        '--vendor-name',
        '  Vendor Forty Two  ',
        '--amount',
        ' 2500.5 ',
        '--currency',
        ' usd ',
        '--description',
        '  September invoice  ',
        '--due-date',
        '2026-10-31',
        '--reference',
        '  INV-42  '
      ],
      {
        env: {
          RISK_CLI_TEST_BASE_URL: 'http://risk-cli-test.invalid',
          RISK_CLI_TEST_MODEL: 'risk-cli-model'
        },
        fetchImpl: async (url, options = {}) => {
          const body = JSON.parse(options.body);
          requests.push({ url, body });
          const userPrompt = JSON.parse(body.messages[1].content);
          const requestEventId = userPrompt.requestEvent.id;
          return {
            ok: true,
            async json() {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        verdict: 'CHECK',
                        reasoning: '  Need a human to verify the new banking details.  ',
                        riskFactors: ['  new banking details  '],
                        evidenceEventIds: [` ${requestEventId} `]
                      })
                    }
                  }
                ],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
              };
            }
          };
        }
      }
    );

    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /Submitted request [0-9a-f-]+: verdict=CHECK, proposal=[0-9a-f-]+, status=pending, authorityLevel=3/
    );
    assert.equal(result.stderr, '');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://risk-cli-test.invalid/chat/completions');
    assert.equal(requests[0].body.model, 'risk-cli-model');

    const events = readStoredEvents(instance.dataDir);
    const requestEvents = events.filter((event) => event.type === 'payment-request.received');
    const proposalEvents = events.filter((event) => event.type === 'proposal.created');

    assert.equal(requestEvents.length, 1);
    assert.equal(proposalEvents.length, 1);
    assert.equal(events.filter((event) => event.type === 'proposal.approved').length, 0);
    assert.equal(events.filter((event) => event.type === 'proposal.rejected').length, 0);
    assert.equal(events.filter((event) => event.type === 'action.executed').length, 0);
    assert.equal(events.filter((event) => event.type === 'decision.recorded').length, 0);
    assert.deepEqual(listExecutedActions(instance.dataDir), []);

    const [requestEvent] = requestEvents;
    assert.equal(requestEvent.source, 'cli');
    assert.equal(requestEvent.subject.type, 'payment-request');
    assert.equal(requestEvent.subject.id, requestEvent.payload.requestId);
    assert.equal(requestEvent.causationId, null);
    assert.deepEqual(requestEvent.payload, {
      requestId: requestEvent.subject.id,
      vendorId: 'vendor-42',
      vendorName: 'Vendor Forty Two',
      amount: 2500.5,
      currency: 'USD',
      description: 'September invoice',
      dueDate: '2026-10-31',
      reference: 'INV-42'
    });

    const [proposalEvent] = proposalEvents;
    assert.equal(proposalEvent.payload.type, 'flag-payment-request');
    assert.equal(proposalEvent.payload.status, 'pending');
    assert.equal(proposalEvent.payload.authorityLevel, 3);
    assert.equal(proposalEvent.causationId, requestEvent.id);
    assert.equal(proposalEvent.correlationId, requestEvent.correlationId);
    assert.deepEqual(proposalEvent.payload.proposedBy, {
      role: 'risk.assess',
      provider: 'local',
      model: 'risk-cli-model'
    });
    assert.deepEqual(proposalEvent.payload.payload.request, {
      requestId: requestEvent.subject.id,
      vendorId: 'vendor-42',
      vendorName: 'Vendor Forty Two',
      amount: 2500.5,
      currency: 'USD',
      description: 'September invoice',
      dueDate: '2026-10-31',
      reference: 'INV-42'
    });
    assert.deepEqual(proposalEvent.payload.payload.assessment, {
      verdict: 'CHECK',
      reasoning: 'Need a human to verify the new banking details.',
      riskFactors: ['new banking details'],
      evidenceEventIds: [requestEvent.id]
    });
  } finally {
    cleanupTempInstance(instance);
  }
});

test('unknown request subcommands, including bare request, print help and return nonzero', () => {
  const cases = [
    { args: ['request'], error: /Unknown request command:/ },
    { args: ['request', 'unknown'], error: /Unknown request command: unknown/ }
  ];

  for (const testCase of cases) {
    assert.throws(
      () => runCli(testCase.args),
      (error) => {
        assert.match(error.stderr.toString(), testCase.error);
        assert.match(error.stdout.toString(), /Usage:/);
        assert.match(error.stdout.toString(), /request submit --instance <name>/);
        return true;
      }
    );
  }
});

test('cli module does not register a flag-payment-request action executor', () => {
  assert.equal(getActionExecutor('flag-payment-request'), null);
});
