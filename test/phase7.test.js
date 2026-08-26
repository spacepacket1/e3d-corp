import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent, queryEvents } from '../lib/events/store.js';
import { createProposal } from '../lib/proposals/create.js';
import { getProposal } from '../lib/proposals/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { decideProposal } from '../lib/decisions/decide.js';
import { listExecutedActions } from '../lib/actions/log.js';
import {
  runOpportunityCommunicator,
  deriveRecipient,
  parseDraftJson,
  validateOutreachDraft
} from '../lib/roles/communicator.js';
import { sendOutreach } from '../lib/actions/sendOutreach.js';
import { createRequestListener } from '../lib/web/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

const ORIGINAL_LLM_BASE_URL = process.env.LLM_BASE_URL;
const ORIGINAL_LLM_MODEL = process.env.LLM_MODEL;
process.env.LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://127.0.0.1:9999';
process.env.LLM_MODEL = process.env.LLM_MODEL ?? 'test-local-model';
test.after(() => {
  if (ORIGINAL_LLM_BASE_URL === undefined) {
    delete process.env.LLM_BASE_URL;
  } else {
    process.env.LLM_BASE_URL = ORIGINAL_LLM_BASE_URL;
  }
  if (ORIGINAL_LLM_MODEL === undefined) {
    delete process.env.LLM_MODEL;
  } else {
    process.env.LLM_MODEL = ORIGINAL_LLM_MODEL;
  }
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-outreach-'));
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeTempInstance(extra = {}) {
  const name = `phase7-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  const config = {
    name,
    dataDir,
    llm: {
      providers: {
        local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      }
    },
    research: { knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
    eventSources: [],
    roles: { 'opportunity.communicator': { provider: 'local' } },
    ...extra
  };
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify(config, null, 2));
  return { name, instanceDir, config, dataDir: path.join(ROOT, dataDir) };
}

function cleanupTempInstance(instance) {
  fs.rmSync(instance.instanceDir, { recursive: true, force: true });
}

async function invokeGet(listener, url, headers = {}) {
  const req = new PassThrough();
  req.method = 'GET';
  req.url = url;
  req.headers = headers;
  req.end();

  let body = '';
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headersToSet = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headersToSet)) {
        this.headers[name.toLowerCase()] = value;
      }
    },
    end(chunk = '') {
      body += chunk;
      resolveDone();
    }
  };

  await listener(req, res);
  await done;
  return { statusCode: res.statusCode, body, headers: res.headers };
}

// Sets up a pursuing Opportunity with a real causal chain (a lead with an
// email, opportunity.created, opportunity.scored, opportunity.reviewed ->
// pursuing) - the shape runOpportunityCommunicator expects.
function seedPursuingOpportunity(dataDir, { opportunityId = 'opp-pursue', email = 'prospect@example.com' } = {}) {
  const correlationId = `phase7-${opportunityId}`;
  const lead = appendEvent(dataDir, {
    type: 'lead.received',
    source: 'e3d-applied.contact-delivery',
    subject: { type: 'lead', id: email },
    payload: { submission: { email, name: 'Prospect Person', workflowProblem: 'manual reporting' } },
    correlationId
  });
  const created = appendEvent(dataDir, {
    type: 'opportunity.created',
    source: 'role:opportunity.prospect',
    subject: { type: 'opportunity', id: opportunityId },
    payload: {
      id: opportunityId,
      type: 'consulting-engagement',
      title: 'Automate reporting for Prospect Co',
      description: 'Prospect Co spends 10 hrs/week on manual reporting.',
      evidence: [],
      score: null,
      status: 'candidate',
      sourceEventIds: [lead.id],
      correlationId,
      createdAt: lead.occurredAt
    },
    causationId: lead.id,
    correlationId
  });
  appendEvent(dataDir, {
    type: 'opportunity.scored',
    source: 'opportunity.engine',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { id: opportunityId, score: { value: 0.8, rationale: 'strong fit' }, status: 'scored' },
    causationId: created.id,
    correlationId
  });
  const reviewed = appendEvent(dataDir, {
    type: 'opportunity.reviewed',
    source: 'decision:cli',
    subject: { type: 'opportunity', id: opportunityId },
    payload: { decision: 'pursuing', status: 'pursuing', reason: 'Worth pursuing', decidedBy: 'chris', via: 'cli' },
    causationId: created.id,
    correlationId
  });

  return {
    correlationId,
    reviewedEvent: reviewed,
    opportunity: {
      id: opportunityId,
      type: 'consulting-engagement',
      title: 'Automate reporting for Prospect Co',
      description: 'Prospect Co spends 10 hrs/week on manual reporting.',
      status: 'pursuing',
      score: { value: 0.8, rationale: 'strong fit' },
      correlationId
    }
  };
}

function llmResponse(text, overrides = {}) {
  return {
    text,
    usage: { promptTokens: 13, completionTokens: 9, totalTokens: 22 },
    costUsd: 0.0125,
    ...overrides
  };
}

function stubDraftLlmClient(draft) {
  return async () => llmResponse(JSON.stringify(draft));
}

test('communicator produces a correctly-structured outreach draft and a pending send-outreach Proposal, never a directly-sent message', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingOpportunity(dataDir);
    const instanceConfig = {
      llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' } } },
      roles: { 'opportunity.communicator': { provider: 'local' } }
    };
    const llmClient = stubDraftLlmClient({
      subject: 'Cut your reporting time to zero',
      body: 'Hi - saw Prospect Co spends 10 hrs/week on manual reporting...',
      rationale: 'Directly addresses the workflow problem from their inbound lead.'
    });

    const { draft, proposal, event } = await runOpportunityCommunicator({ instanceConfig, dataDir, opportunity, llmClient });

    assert.equal(draft.to, 'prospect@example.com');
    assert.match(draft.subject, /reporting/i);
    assert.equal(proposal.type, 'send-outreach');
    assert.equal(proposal.authorityLevel, 2);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.payload.to, 'prospect@example.com');
    assert.equal(proposal.payload.opportunityId, opportunity.id);
    assert.equal(event.type, 'proposal.created');
    assert.equal(event.correlationId, opportunity.correlationId);

    assert.equal(queryEvents(dataDir, { type: 'outreach.sent' }).length, 0);
    const providerEvents = queryEvents(dataDir, { type: 'role.provider.completed', correlationId: opportunity.correlationId });
    assert.equal(providerEvents.length, 1);
    assert.deepEqual(providerEvents[0].payload.usage, { promptTokens: 13, completionTokens: 9, totalTokens: 22 });
    assert.equal(providerEvents[0].payload.costUsd, 0.0125);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('multi-provider communicator produces grouped sibling drafts with shared correlationId and provider attribution', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE7_MULTI_USER', authPassEnvVar: 'PHASE7_MULTI_PASS', port: 3998 },
    llm: {
      providers: {
        alpha: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' },
        beta: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
      }
    },
    roles: { 'opportunity.communicator': { provider: ['alpha', 'beta'] } }
  });
  process.env.PHASE7_MULTI_USER = 'chris';
  process.env.PHASE7_MULTI_PASS = 'secret';

  try {
    const { opportunity } = seedPursuingOpportunity(instance.dataDir, { opportunityId: 'opp-multi-provider' });
    const result = await runOpportunityCommunicator({
      instanceConfig: instance.config,
      dataDir: instance.dataDir,
      opportunity,
      llmClient: {
        alpha: stubDraftLlmClient({
          subject: 'Alpha outreach angle',
          body: 'Alpha body',
          rationale: 'Alpha rationale'
        }),
        beta: stubDraftLlmClient({
          subject: 'Beta outreach angle',
          body: 'Beta body',
          rationale: 'Beta rationale'
        })
      }
    });

    assert.equal(result.proposals.length, 2);
    assert.equal(result.drafts.length, 2);
    for (const proposal of result.proposals) {
      assert.equal(proposal.status, 'pending');
      assert.equal(proposal.type, 'send-outreach');
      assert.equal(proposal.authorityLevel, 2);
      assert.equal(proposal.correlationId, opportunity.correlationId);
      assert.equal(proposal.payload.opportunityId, opportunity.id);
    }
    assert.deepEqual(
      result.proposals.map((proposal) => proposal.proposedBy.provider).sort(),
      ['alpha', 'beta']
    );

    const listener = createRequestListener({ config: instance.config, dataDir: instance.dataDir });
    const auth = { authorization: `Basic ${Buffer.from('chris:secret').toString('base64')}` };
    const listRes = await invokeGet(listener, '/proposals', auth);
    assert.equal(listRes.statusCode, 200);
    assert.match(listRes.body, /Outreach alternatives for opportunity opp-multi-provider/);
    assert.match(listRes.body, /2 drafts/);
    assert.match(listRes.body, /Alpha outreach angle/);
    assert.match(listRes.body, /Beta outreach angle/);

    const detailRes = await invokeGet(listener, `/proposals/${result.proposals[0].id}`, auth);
    assert.equal(detailRes.statusCode, 200);
    assert.match(detailRes.body, /Sibling drafts/);
    assert.match(detailRes.body, /These proposals are alternatives for the same outreach opportunity/);

    const listOutput = runCli(['proposals', 'list', '--instance', instance.name]);
    assert.match(listOutput, /Outreach alternatives for opportunity opp-multi-provider/);
    assert.match(listOutput, /2 drafts/);

    const showOutput = runCli(['proposals', 'show', result.proposals[0].id, '--instance', instance.name]);
    assert.match(showOutput, /sibling drafts \(2 total\)/i);
    assert.match(showOutput, /provider=alpha|provider=beta/);
  } finally {
    delete process.env.PHASE7_MULTI_USER;
    delete process.env.PHASE7_MULTI_PASS;
    cleanupTempInstance(instance);
  }
});

test('communicator refuses to draft outreach for an opportunity that is not "pursuing"', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingOpportunity(dataDir, { opportunityId: 'opp-not-pursuing' });
    const notPursuing = { ...opportunity, status: 'scored' };
    const instanceConfig = {
      llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' } } },
      roles: { 'opportunity.communicator': { provider: 'local' } }
    };

    await assert.rejects(
      runOpportunityCommunicator({ instanceConfig, dataDir, opportunity: notPursuing, llmClient: stubDraftLlmClient({}) }),
      /not "pursuing"/
    );
    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('malformed role output (invalid JSON, or missing required fields) is rejected and appends no proposal.created event', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { opportunity } = seedPursuingOpportunity(dataDir, { opportunityId: 'opp-malformed' });
    const instanceConfig = {
      llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' } } },
      roles: { 'opportunity.communicator': { provider: 'local' } }
    };

    await assert.rejects(
      runOpportunityCommunicator({
        instanceConfig,
        dataDir,
        opportunity,
        llmClient: async () => llmResponse('not json at all')
      }),
      /invalid JSON/
    );

    await assert.rejects(
      runOpportunityCommunicator({
        instanceConfig,
        dataDir,
        opportunity,
        llmClient: async () => llmResponse(JSON.stringify({ subject: 'x' }))
      }),
      /Invalid outreach draft/
    );

    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
    const failures = queryEvents(dataDir, { type: 'role.provider.failed', correlationId: opportunity.correlationId });
    assert.equal(failures.length, 2);
    assert.deepEqual(failures[0].payload.usage, { promptTokens: 13, completionTokens: 9, totalTokens: 22 });
    assert.deepEqual(failures[1].payload.usage, { promptTokens: 13, completionTokens: 9, totalTokens: 22 });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parseDraftJson strips a markdown fence; validateOutreachDraft rejects a missing field', () => {
  const fenced = '```json\n{"subject":"s","body":"b","rationale":"r"}\n```';
  assert.deepEqual(parseDraftJson(fenced), { subject: 's', body: 'b', rationale: 'r' });
  assert.equal(validateOutreachDraft({ subject: 's', body: 'b' }).valid, false);
});

test('deriveRecipient prefers a lead email from the evidence chain, falls back to outreach.fallbackToEmail, and refuses when neither is available', () => {
  const leadChain = [{ type: 'lead.received', payload: { submission: { email: 'lead@example.com' } } }];
  assert.equal(deriveRecipient({ chain: leadChain, instanceConfig: {} }), 'lead@example.com');

  const noLeadChain = [{ type: 'market.signal.detected', payload: {} }];
  assert.equal(
    deriveRecipient({ chain: noLeadChain, instanceConfig: { outreach: { fallbackToEmail: 'support@futco.ai' } } }),
    'support@futco.ai'
  );
  assert.equal(deriveRecipient({ chain: noLeadChain, instanceConfig: {} }), null);
});

test('communicator refuses to draft outreach when no recipient can be derived', async () => {
  const dataDir = makeTempDataDir();
  try {
    const correlationId = 'phase7-no-recipient';
    const signal = appendEvent(dataDir, {
      type: 'market.signal.detected',
      source: 'discovery.scheduled',
      subject: { type: 'research-topic', id: 'ai tools' },
      payload: { topic: 'ai tools' },
      correlationId
    });
    const created = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-no-recipient' },
      payload: {
        id: 'opp-no-recipient',
        type: 'market-trend',
        title: 'A market trend',
        description: 'desc',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [signal.id],
        correlationId,
        createdAt: signal.occurredAt
      },
      causationId: signal.id,
      correlationId
    });

    const opportunity = {
      id: 'opp-no-recipient',
      type: 'market-trend',
      title: 'A market trend',
      status: 'pursuing',
      correlationId
    };
    const instanceConfig = {
      llm: { providers: { local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' } } },
      roles: { 'opportunity.communicator': { provider: 'local' } }
    };

    await assert.rejects(
      runOpportunityCommunicator({ instanceConfig, dataDir, opportunity, llmClient: stubDraftLlmClient({}) }),
      /no recipient email found/
    );
    assert.ok(created.id);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function proposedBy(overrides = {}) {
  return { role: 'opportunity.communicator', provider: 'local', model: 'test-model', ...overrides };
}

test('sendOutreach refuses a pending or rejected proposal, and refuses a proposal missing to/subject/body', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-send-guard' },
      payload: {},
      correlationId: 'phase7-send-guard'
    });
    const { proposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com', subject: 's', body: 'b' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    await assert.rejects(sendOutreach(proposal, { dataDir }), /not approved \(status: pending\)/);

    const { proposal: incomplete } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    await assert.rejects(sendOutreach({ ...incomplete, status: 'approved' }, { dataDir }), /missing to\/subject\/body/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sendOutreach against an approved proposal sends via the injected transport and emits outreach.sent with correct causationId/correlationId', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-send-ok' },
      payload: {},
      correlationId: 'phase7-send-ok'
    });
    const { proposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com', subject: 'Hello', body: 'Body text', opportunityId: 'opp-send-ok' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    const approved = { ...proposal, status: 'approved' };

    let transportCalls = 0;
    const fakeTransport = async ({ to, subject, body }) => {
      transportCalls += 1;
      assert.equal(to, 'prospect@example.com');
      assert.equal(subject, 'Hello');
      assert.equal(body, 'Body text');
      return { transport: 'fake', messageId: 'fake-message-id' };
    };

    const approvalEvent = appendEvent(dataDir, {
      type: 'proposal.approved',
      source: 'decision:cli',
      subject: { type: 'proposal', id: proposal.id },
      payload: { decision: 'approved' },
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    const result = await sendOutreach(approved, {
      dataDir,
      causationId: approvalEvent.id,
      correlationId: proposal.correlationId,
      transport: fakeTransport
    });

    assert.equal(transportCalls, 1);
    assert.equal(result.sent, true);
    assert.equal(result.event.type, 'outreach.sent');
    assert.equal(result.event.causationId, approvalEvent.id);
    assert.equal(result.event.correlationId, trigger.correlationId);
    assert.equal(result.event.payload.to, 'prospect@example.com');
    assert.equal(result.event.payload.providerMessageId, 'fake-message-id');

    const sentEvents = queryEvents(dataDir, { type: 'outreach.sent' });
    assert.equal(sentEvents.length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('approving one sibling outreach proposal blocks later approval of the other before any second approval event is appended', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('send-outreach', (proposal, ctx) =>
    sendOutreach(proposal, {
      ...ctx,
      transport: async () => ({ transport: 'fake', messageId: 'msg-sibling-1' })
    })
  );

  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-sibling-guard' },
      payload: {},
      correlationId: 'phase7-sibling-guard'
    });
    const proposalA = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com', subject: 'Alpha', body: 'Body A', opportunityId: 'opp-sibling-guard' },
      proposedBy: proposedBy({ provider: 'alpha' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    }).proposal;
    const proposalB = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com', subject: 'Beta', body: 'Body B', opportunityId: 'opp-sibling-guard' },
      proposedBy: proposedBy({ provider: 'beta' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    }).proposal;

    const approved = await decideProposal(dataDir, proposalA.id, 'approved', 'send alpha', 'chris', 'cli', {});
    assert.equal(approved.executed, true);

    await assert.rejects(
      decideProposal(dataDir, proposalB.id, 'approved', 'send beta', 'chris', 'cli', {}),
      /outreach already sent for this opportunity/
    );

    assert.equal(getProposal(dataDir, proposalA.id).status, 'approved');
    assert.equal(getProposal(dataDir, proposalB.id).status, 'pending');
    assert.equal(queryEvents(dataDir, { type: 'proposal.approved' }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'outreach.sent' }).length, 1);
  } finally {
    clearActionExecutor('send-outreach');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('concurrent approval of sibling outreach proposals results in one success, one refusal, and one outreach.sent event', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('send-outreach', (proposal, ctx) =>
    sendOutreach(proposal, {
      ...ctx,
      transport: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { transport: 'fake', messageId: `msg-${proposal.id}` };
      }
    })
  );

  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-sibling-race' },
      payload: {},
      correlationId: 'phase7-sibling-race'
    });
    const proposalA = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com', subject: 'Alpha', body: 'Body A', opportunityId: 'opp-sibling-race' },
      proposedBy: proposedBy({ provider: 'alpha' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    }).proposal;
    const proposalB = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com', subject: 'Beta', body: 'Body B', opportunityId: 'opp-sibling-race' },
      proposedBy: proposedBy({ provider: 'beta' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    }).proposal;

    const results = await Promise.allSettled([
      decideProposal(dataDir, proposalA.id, 'approved', 'send alpha', 'chris', 'cli', {}),
      decideProposal(dataDir, proposalB.id, 'approved', 'send beta', 'chris', 'cli', {})
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /outreach already sent for this opportunity/);
    assert.equal(queryEvents(dataDir, { type: 'proposal.approved' }).length, 1);
    assert.equal(queryEvents(dataDir, { type: 'outreach.sent' }).length, 1);

    const statuses = [getProposal(dataDir, proposalA.id).status, getProposal(dataDir, proposalB.id).status].sort();
    assert.deepEqual(statuses, ['approved', 'pending']);
  } finally {
    clearActionExecutor('send-outreach');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('level-2 send-outreach proposal: approving via decideProposal fires sendOutreach exactly once, and /actions lists it with links back to proposal and opportunity', async () => {
  const instance = makeTempInstance({
    web: { authUserEnvVar: 'PHASE7_ACTIONS_USER', authPassEnvVar: 'PHASE7_ACTIONS_PASS', port: 3999 }
  });
  process.env.PHASE7_ACTIONS_USER = 'chris';
  process.env.PHASE7_ACTIONS_PASS = 'secret';

  let fireCount = 0;
  const fakeTransport = async () => {
    fireCount += 1;
    return { transport: 'fake', messageId: 'msg-1' };
  };
  registerActionExecutor('send-outreach', (proposal, ctx) => sendOutreach(proposal, { ...ctx, transport: fakeTransport }));

  try {
    const trigger = appendEvent(instance.dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-actions-view' },
      payload: {},
      correlationId: 'phase7-actions-view'
    });
    const { proposal } = createProposal(instance.dataDir, {
      type: 'send-outreach',
      payload: {
        to: 'prospect@example.com',
        subject: 'Automate your reporting',
        body: 'Body',
        opportunityId: 'opp-actions-view'
      },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    const result = await decideProposal(instance.dataDir, proposal.id, 'approved', 'Go ahead', 'chris', 'cli', instance.config);
    assert.equal(result.executed, true);
    assert.equal(fireCount, 1);
    assert.equal(getProposal(instance.dataDir, proposal.id).status, 'approved');

    const actions = listExecutedActions(instance.dataDir);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].proposalId, proposal.id);
    assert.equal(actions[0].opportunityId, 'opp-actions-view');

    const listener = createRequestListener({ config: instance.config, dataDir: instance.dataDir });
    const res = await invokeGet(listener, '/actions', {
      authorization: `Basic ${Buffer.from('chris:secret').toString('base64')}`
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(`/proposals/${proposal.id}`));
    assert.ok(res.body.includes('/opportunities/opp-actions-view'));
    assert.ok(res.body.includes('prospect@example.com'));
  } finally {
    clearActionExecutor('send-outreach');
    delete process.env.PHASE7_ACTIONS_USER;
    delete process.env.PHASE7_ACTIONS_PASS;
    cleanupTempInstance(instance);
  }
});

test('CLI: pursue reports cleanly when there are no pursuing opportunities', () => {
  const instance = makeTempInstance();
  try {
    const output = runCli(['pursue', '--instance', instance.name]);
    assert.match(output, /No pursuing opportunities found/);
  } finally {
    cleanupTempInstance(instance);
  }
});
