import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appendEvent } from '../lib/events/store.js';
import { reconstructChain } from '../lib/events/chain.js';
import {
  AUTHORITY_LEVELS,
  ACTION_POLICY,
  getRequiredAuthorityLevel,
  assertProposalAuthorized
} from '../lib/authority/policy.js';
import { authorityNotify } from '../lib/authority/notify.js';
import { createProposal } from '../lib/proposals/create.js';
import { getProposal } from '../lib/proposals/store.js';
import { decideOpportunity, decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { getOpportunity } from '../lib/opportunities/store.js';
import { run } from '../lib/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'e3d-corp');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-decisions-'));
}

function runCli(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makeTempInstance(extra = {}) {
  const name = `phase5-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const dataDir = `.e3d-corp/instance/${name}`;
  fs.writeFileSync(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify(
      {
        name,
        dataDir,
        llm: {
          providers: {
            local: { kind: 'local', baseUrlEnvVar: 'LLM_BASE_URL', modelEnvVar: 'LLM_MODEL' }
          }
        },
        research: { knowledgeBaseMcpUrl: 'http://127.0.0.1:4110', webSearchProvider: 'disabled' },
        eventSources: [],
        roles: {},
        ...extra
      },
      null,
      2
    )
  );
  return { name, instanceDir, dataDir: path.join(ROOT, dataDir) };
}

function cleanupTempInstance(instanceDir) {
  fs.rmSync(instanceDir, { recursive: true, force: true });
}

function proposedBy(overrides = {}) {
  return { role: 'opportunity.communicator', provider: 'local', model: 'test-model', ...overrides };
}

// A stand-in for a Phase-7-style action-execution function ("send-outreach").
// The important thing under test is that it calls assertProposalAuthorized as
// its own first line - the guard every real action-execution function must
// use - not that it does anything real.
async function fakeActionExecutor(type) {
  return async (proposal) => {
    assertProposalAuthorized(proposal, type);
    return { fired: true, proposalId: proposal.id };
  };
}

test('authority policy: known action types map to documented levels; unknown types fail closed', () => {
  assert.equal(getRequiredAuthorityLevel('send-outreach'), AUTHORITY_LEVELS.EXTERNAL_ACTION);
  assert.equal(getRequiredAuthorityLevel('pilot-handoff'), AUTHORITY_LEVELS.EXTERNAL_ACTION);
  assert.equal(getRequiredAuthorityLevel('capital_mandate'), AUTHORITY_LEVELS.FINANCIAL_ACTION);
  assert.equal(getRequiredAuthorityLevel('issue-invoice'), AUTHORITY_LEVELS.FINANCIAL_ACTION);
  assert.equal(getRequiredAuthorityLevel('mark-deal-closed'), AUTHORITY_LEVELS.IRREVERSIBLE_ACTION);
  assert.throws(() => getRequiredAuthorityLevel('not-a-real-action'), /No authority policy defined/);
  assert.ok(Object.values(ACTION_POLICY).every((level) => level >= AUTHORITY_LEVELS.EXTERNAL_ACTION));
});

test('assertProposalAuthorized refuses a pending proposal and passes an approved one at the matching type/level', () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-guard' },
      payload: {},
      correlationId: 'phase5-guard-chain'
    });

    const { proposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    // Calling the action function directly, bypassing both CLI and UI, with a
    // pending proposal: it must refuse, every time.
    assert.throws(() => assertProposalAuthorized(proposal, 'send-outreach'), /not approved \(status: pending\)/);

    // Wrong type / wrong level are also refused.
    assert.throws(() => assertProposalAuthorized(proposal, 'issue-invoice'), /expected "issue-invoice"/);
    assert.throws(
      () => assertProposalAuthorized({ ...proposal, status: 'approved', authorityLevel: 3 }, 'send-outreach'),
      /policy v3 requires 2/
    );

    const approved = { ...proposal, status: 'approved' };
    assert.equal(assertProposalAuthorized(approved, 'send-outreach'), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createProposal derives authorityLevel from the policy table and rejects malformed input without a partial write', () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-create' },
      payload: {},
      correlationId: 'phase5-create-chain'
    });

    const { proposal, event } = createProposal(dataDir, {
      type: 'issue-invoice',
      payload: { amount: 500 },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.equal(proposal.authorityLevel, AUTHORITY_LEVELS.FINANCIAL_ACTION);
    assert.equal(proposal.status, 'pending');
    assert.equal(event.type, 'proposal.created');
    assert.equal(event.causationId, trigger.id);
    assert.equal(event.correlationId, trigger.correlationId);
    assert.equal(getProposal(dataDir, proposal.id).id, proposal.id);

    assert.throws(
      () =>
        createProposal(dataDir, {
          type: 'send-outreach',
          payload: {},
          proposedBy: { role: '', provider: 'local', model: 'x' },
          correlationId: 'phase5-bad'
        }),
      /Invalid proposal/
    );
    assert.throws(() => createProposal(dataDir, { type: 'not-a-real-action', payload: {}, proposedBy: proposedBy(), correlationId: 'x' }), /No authority policy defined/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('decideOpportunity requires a reason, rejects unknown decisions, and appends opportunity.reviewed with via recorded', async () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-decide' },
      payload: {},
      correlationId: 'phase5-opp-chain'
    });
    const created = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-decide' },
      payload: {
        id: 'opp-decide',
        type: 'consulting-engagement',
        title: 'Test opportunity',
        description: 'desc',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [trigger.id],
        correlationId: trigger.correlationId,
        createdAt: trigger.occurredAt
      },
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    assert.throws(
      () => decideOpportunity(dataDir, 'opp-decide', 'pursuing', '', 'chris', 'cli'),
      /non-empty reason is required/
    );
    assert.throws(
      () => decideOpportunity(dataDir, 'opp-decide', 'not-a-decision', 'because', 'chris', 'cli'),
      /Unknown opportunity decision/
    );

    const { decision, event } = decideOpportunity(dataDir, 'opp-decide', 'pursuing', 'Looks worth pursuing', 'chris', 'web');
    assert.equal(decision.decision, 'pursuing');
    assert.equal(decision.via, 'web');
    assert.equal(event.type, 'opportunity.reviewed');
    assert.equal(event.causationId, created.id);
    assert.equal(event.correlationId, trigger.correlationId);
    assert.equal(event.payload.via, 'web');

    const opportunity = getOpportunity(dataDir, 'opp-decide');
    assert.equal(opportunity.status, 'pursuing');

    assert.throws(() => decideOpportunity(dataDir, 'does-not-exist', 'pursuing', 'x', 'chris', 'cli'), /Opportunity not found/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('level-2 proposal: approval and execution are the same call; a pending proposal refuses the action directly', async () => {
  const dataDir = makeTempDataDir();
  const executor = await fakeActionExecutor('send-outreach');
  registerActionExecutor('send-outreach', executor);
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-l2' },
      payload: {},
      correlationId: 'phase5-l2-chain'
    });
    const { proposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: { to: 'prospect@example.com' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    // Direct call against the pending proposal must refuse.
    await assert.rejects(executor(proposal), /not approved \(status: pending\)/);

    const result = await decideProposal(dataDir, proposal.id, 'approved', 'Good fit, send it', 'chris', 'cli');
    assert.equal(result.executed, true);
    assert.deepEqual(result.executionResult, { fired: true, proposalId: proposal.id });
    assert.equal(getProposal(dataDir, proposal.id).status, 'approved');

    // Deciding again on an already-decided proposal is refused.
    await assert.rejects(
      decideProposal(dataDir, proposal.id, 'approved', 'again', 'chris', 'cli'),
      /already approved/
    );
  } finally {
    clearActionExecutor('send-outreach');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('level-3/4 proposals require the separate confirmAndExecute step and do not fire on approval alone', async () => {
  const dataDir = makeTempDataDir();
  const invoiceExecutor = await fakeActionExecutor('issue-invoice');
  const dealExecutor = await fakeActionExecutor('mark-deal-closed');
  registerActionExecutor('issue-invoice', invoiceExecutor);
  registerActionExecutor('mark-deal-closed', dealExecutor);
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-l34' },
      payload: {},
      correlationId: 'phase5-l34-chain'
    });

    const { proposal: invoiceProposal } = createProposal(dataDir, {
      type: 'issue-invoice',
      payload: { amount: 1000 },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    // confirmAndExecute before approval is refused.
    await assert.rejects(confirmAndExecute(dataDir, invoiceProposal.id, 'chris', 'cli'), /must be approved before confirmAndExecute/);

    const approveResult = await decideProposal(dataDir, invoiceProposal.id, 'approved', 'Approved, not yet fired', 'chris', 'cli');
    assert.equal(approveResult.executed, false);
    assert.equal(getProposal(dataDir, invoiceProposal.id).status, 'approved');

    const { executionResult } = await confirmAndExecute(dataDir, invoiceProposal.id, 'chris', 'cli');
    assert.deepEqual(executionResult, { fired: true, proposalId: invoiceProposal.id });

    const { proposal: dealProposal } = createProposal(dataDir, {
      type: 'mark-deal-closed',
      payload: { dealId: 'deal-1', outcome: 'won' },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    const dealApprove = await decideProposal(dataDir, dealProposal.id, 'approved', 'Deal confirmed by client', 'chris', 'cli');
    assert.equal(dealApprove.executed, false);
    // confirmAndExecute is required before this level-4 action fires.
    await confirmAndExecute(dataDir, dealProposal.id, 'chris', 'cli');

    // Level-2 proposals never use confirmAndExecute (already executed on approval).
    const outreachExecutor = await fakeActionExecutor('send-outreach');
    registerActionExecutor('send-outreach', outreachExecutor);
    const { proposal: outreachProposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: {},
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    await decideProposal(dataDir, outreachProposal.id, 'approved', 'go', 'chris', 'cli');
    await assert.rejects(
      confirmAndExecute(dataDir, outreachProposal.id, 'chris', 'cli'),
      /already execute on approval/
    );
    clearActionExecutor('send-outreach');
  } finally {
    clearActionExecutor('issue-invoice');
    clearActionExecutor('mark-deal-closed');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rejecting a proposal never executes its action, at any level', async () => {
  const dataDir = makeTempDataDir();
  const executor = await fakeActionExecutor('send-outreach');
  let callCount = 0;
  registerActionExecutor('send-outreach', async (proposal, ctx) => {
    callCount += 1;
    return executor(proposal, ctx);
  });
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-reject' },
      payload: {},
      correlationId: 'phase5-reject-chain'
    });
    const { proposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: {},
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    const result = await decideProposal(dataDir, proposal.id, 'rejected', 'Not a good fit', 'chris', 'cli');
    assert.equal(result.executed, false);
    assert.equal(callCount, 0);
    assert.equal(getProposal(dataDir, proposal.id).status, 'rejected');
  } finally {
    clearActionExecutor('send-outreach');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('full causal chain from originating event through opportunity.reviewed and proposal.created -> proposal.approved is reconstructable via correlationId, with via recorded', async () => {
  const dataDir = makeTempDataDir();
  const executor = await fakeActionExecutor('pilot-handoff');
  registerActionExecutor('pilot-handoff', executor);
  try {
    const correlationId = 'phase5-full-chain';
    const originating = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-chain' },
      payload: {},
      correlationId
    });
    const created = appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-chain' },
      payload: {
        id: 'opp-chain',
        type: 'product-opportunity',
        title: 'Chain test opportunity',
        description: 'desc',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [originating.id],
        correlationId,
        createdAt: originating.occurredAt
      },
      causationId: originating.id,
      correlationId
    });
    appendEvent(dataDir, {
      type: 'opportunity.scored',
      source: 'opportunity.engine',
      subject: { type: 'opportunity', id: 'opp-chain' },
      payload: { id: 'opp-chain', score: { value: 0.8, rationale: 'good' }, status: 'scored' },
      causationId: created.id,
      correlationId
    });

    const { event: reviewedEvent } = decideOpportunity(dataDir, 'opp-chain', 'pursuing', 'Worth handing off', 'chris', 'web');

    const { proposal } = createProposal(dataDir, {
      type: 'pilot-handoff',
      payload: { objective: 'Ship it' },
      proposedBy: proposedBy({ role: 'opportunity.prospect' }),
      causationId: reviewedEvent.id,
      correlationId
    });

    const { event: approvedEvent } = await decideProposal(dataDir, proposal.id, 'approved', 'Go build it', 'chris', 'web');

    const chain = reconstructChain(dataDir, correlationId);
    const types = chain.map((e) => e.type);
    assert.deepEqual(types, [
      'lead.received',
      'opportunity.created',
      'opportunity.scored',
      'opportunity.reviewed',
      'proposal.created',
      'proposal.approved'
    ]);
    assert.ok(chain.every((e) => e.correlationId === correlationId));
    assert.equal(chain.find((e) => e.type === 'opportunity.reviewed').payload.via, 'web');
    assert.equal(chain.find((e) => e.type === 'proposal.approved').payload.via, 'web');
    assert.equal(approvedEvent.causationId, chain.find((e) => e.type === 'proposal.created').id);
  } finally {
    clearActionExecutor('pilot-handoff');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('authorityNotify is best-effort: absent config, and a failing command, never throw or block proposal creation', () => {
  const dataDir = makeTempDataDir();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-notify' },
      payload: {},
      correlationId: 'phase5-notify-chain'
    });

    const noConfigResult = authorityNotify(undefined, { id: 'x', type: 'send-outreach', authorityLevel: 2 });
    assert.equal(noConfigResult.notified, false);

    const { proposal } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: {},
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId,
      instanceConfig: { authorityNotify: { command: 'definitely-not-a-real-command-xyz', email: 'ops@example.com' } }
    });

    assert.equal(proposal.status, 'pending');
    assert.equal(getProposal(dataDir, proposal.id).id, proposal.id);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: a hand-crafted proposal at each authority level can be approved or rejected via the CLI wrapper', () => {
  const { name, instanceDir, dataDir } = makeTempInstance();
  // pilot-handoff (level 2, like send-outreach) is real and side-effecting as
  // of Phase 8 - lib/cli.js registers real executors for every level-2 type,
  // so this generic "approve/reject/list/show across authority levels" test
  // gives it a valid, harmless payload (a real opportunity + a throwaway
  // target repo with a minimal valid .e3d-pilot/config.json) rather than
  // relying on an unregistered type to silently no-op.
  const targetRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-pilot-target-'));
  fs.mkdirSync(path.join(targetRepoDir, '.e3d-pilot'), { recursive: true });
  fs.writeFileSync(
    path.join(targetRepoDir, '.e3d-pilot', 'config.json'),
    JSON.stringify({
      verify: [],
      protected_paths: [],
      research_topics: '',
      pr: { base_branch: 'main', draft: true, labels: [], backend: 'local' },
      providers: { discover: 'claude', ideate: 'claude', draft: 'codex', negotiate: ['claude', 'codex'], review: 'claude' },
      max_diff_files: 25,
      max_diff_lines: 600
    })
  );
  try {
    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-cli-proposals' },
      payload: {},
      correlationId: 'phase5-cli-chain'
    });
    appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-cli-proposals' },
      payload: {
        id: 'opp-cli-proposals',
        type: 'product-opportunity',
        title: 'CLI wrapper test opportunity',
        description: 'desc',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [trigger.id],
        correlationId: trigger.correlationId,
        createdAt: trigger.occurredAt
      },
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    const { proposal: level2 } = createProposal(dataDir, {
      type: 'pilot-handoff',
      payload: { opportunityId: 'opp-cli-proposals', targetRepo: targetRepoDir, reason: 'test' },
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    const { proposal: level3 } = createProposal(dataDir, {
      type: 'issue-invoice',
      payload: { amount: 200 },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    const { proposal: level4 } = createProposal(dataDir, {
      type: 'mark-deal-closed',
      payload: { dealId: 'd1' },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    const approveOutput = runCli(['proposals', 'approve', level2.id, '--reason', 'send it', '--instance', name]);
    assert.match(approveOutput, /approved/);
    assert.equal(getProposal(dataDir, level2.id).status, 'approved');

    const approveL3Output = runCli(['proposals', 'approve', level3.id, '--reason', 'ok to invoice', '--instance', name]);
    assert.match(approveL3Output, /approved/);
    assert.equal(getProposal(dataDir, level3.id).status, 'approved');

    const rejectOutput = runCli(['proposals', 'reject', level4.id, '--reason', 'not yet', '--instance', name]);
    assert.match(rejectOutput, /rejected/);
    assert.equal(getProposal(dataDir, level4.id).status, 'rejected');

    const listOutput = runCli(['proposals', 'list', '--instance', name]);
    assert.match(listOutput, new RegExp(level2.id));
    assert.match(listOutput, new RegExp(level3.id));
    assert.match(listOutput, new RegExp(level4.id));

    const showOutput = runCli(['proposals', 'show', level2.id, '--instance', name]);
    assert.match(showOutput, new RegExp(`Proposal ${level2.id}`));
    assert.match(showOutput, /causal chain/);
  } finally {
    cleanupTempInstance(instanceDir);
    fs.rmSync(targetRepoDir, { recursive: true, force: true });
  }
});

test('CLI: opportunities decide transitions status and requires --status and --reason', () => {
  const { name, instanceDir, dataDir } = makeTempInstance();
  try {
    const trigger = appendEvent(dataDir, {
      type: 'lead.received',
      source: 'e3d-applied',
      subject: { type: 'lead', id: 'lead-cli-decide' },
      payload: {},
      correlationId: 'phase5-cli-opp-chain'
    });
    appendEvent(dataDir, {
      type: 'opportunity.created',
      source: 'role:opportunity.prospect',
      subject: { type: 'opportunity', id: 'opp-cli-decide' },
      payload: {
        id: 'opp-cli-decide',
        type: 'consulting-engagement',
        title: 'CLI decide test',
        description: 'desc',
        evidence: [],
        score: null,
        status: 'candidate',
        sourceEventIds: [trigger.id],
        correlationId: trigger.correlationId,
        createdAt: trigger.occurredAt
      },
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    const output = runCli([
      'opportunities',
      'decide',
      'opp-cli-decide',
      '--status',
      'pursuing',
      '--reason',
      'Worth pursuing',
      '--instance',
      name
    ]);
    assert.match(output, /pursuing/);
    assert.equal(getOpportunity(dataDir, 'opp-cli-decide').status, 'pursuing');

    assert.throws(
      () => runCli(['opportunities', 'decide', 'opp-cli-decide', '--instance', name]),
      (error) => {
        assert.match(error.stderr.toString(), /requires --status and --reason/);
        return true;
      }
    );
  } finally {
    cleanupTempInstance(instanceDir);
  }
});

// The CLI counterpart of Phase 6's confirm button. Both surfaces call the
// same confirmAndExecute, so what is under test here is that the command is
// reachable, that approving a level-3 proposal through the CLI still does
// not fire its action, that the separate confirm invocation is what does,
// and that every refusal confirmAndExecute owns surfaces as a non-zero exit
// rather than being re-implemented (or softened) at the CLI layer.
test('CLI: `proposals confirm` is the level-3/4 second step, and refuses what confirmAndExecute refuses', async () => {
  const { name, instanceDir, dataDir } = makeTempInstance();

  let invoicesFired = 0;
  let confirmedVia = null;
  let confirmedBy = null;
  registerActionExecutor('issue-invoice', async (proposal, context) => {
    assertProposalAuthorized(proposal, 'issue-invoice');
    invoicesFired += 1;
    confirmedVia = context.via;
    confirmedBy = context.confirmedBy;
    return { fired: true, proposalId: proposal.id };
  });
  // Overrides the real send-outreach executor lib/cli.js registers on import,
  // so approving the level-2 proposal below cannot reach SES from a test.
  let outreachFired = 0;
  registerActionExecutor('send-outreach', async (proposal) => {
    assertProposalAuthorized(proposal, 'send-outreach');
    outreachFired += 1;
    return { fired: true };
  });

  try {
    assert.match(runCli(['--help']), /proposals confirm <id>/);

    assert.throws(
      () => runCli(['proposals', 'confirm']),
      (error) => {
        assert.match(error.stderr.toString(), /proposals confirm requires an <id>/);
        return true;
      }
    );

    const trigger = appendEvent(dataDir, {
      type: 'opportunity.reviewed',
      source: 'test',
      subject: { type: 'opportunity', id: 'opp-cli-confirm' },
      payload: {},
      correlationId: 'phase5-cli-confirm-chain'
    });

    const { proposal: invoice } = createProposal(dataDir, {
      type: 'issue-invoice',
      payload: { amount: 2500 },
      proposedBy: proposedBy({ role: 'finance.bookkeeper' }),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });

    // Confirming before approval is refused; the CLI exits non-zero.
    assert.equal(await run(['proposals', 'confirm', invoice.id, '--instance', name]), 1);
    assert.equal(invoicesFired, 0);

    // Approving a level-3 proposal from the CLI must not fire its action.
    assert.equal(
      await run(['proposals', 'approve', invoice.id, '--reason', 'Invoice agreed', '--instance', name]),
      0
    );
    assert.equal(getProposal(dataDir, invoice.id).status, 'approved');
    assert.equal(invoicesFired, 0, 'approval alone never fires a level-3 action');

    // The separate confirm invocation is what actually fires it.
    assert.equal(await run(['proposals', 'confirm', invoice.id, '--instance', name]), 0);
    assert.equal(invoicesFired, 1);
    assert.equal(confirmedVia, 'cli', 'the executor sees which surface confirmed it');
    assert.ok(confirmedBy, 'confirmedBy is resolved and passed through, never blank');

    // A level-2 proposal already executed on approval and is refused here.
    const { proposal: outreach } = createProposal(dataDir, {
      type: 'send-outreach',
      payload: {},
      proposedBy: proposedBy(),
      causationId: trigger.id,
      correlationId: trigger.correlationId
    });
    assert.equal(await run(['proposals', 'approve', outreach.id, '--reason', 'go', '--instance', name]), 0);
    assert.equal(outreachFired, 1, 'level-2 fires on approval');
    assert.equal(await run(['proposals', 'confirm', outreach.id, '--instance', name]), 1);
    assert.equal(outreachFired, 1, 'confirm never double-fires a level-2 action');
  } finally {
    clearActionExecutor('issue-invoice');
    clearActionExecutor('send-outreach');
    cleanupTempInstance(instanceDir);
  }
});
