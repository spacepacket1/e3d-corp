import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queryEvents } from '../lib/events/store.js';
import { registerActionExecutor, clearActionExecutor } from '../lib/actions/registry.js';
import { proposeMetaCampaignChange } from '../lib/proposals/metaCampaignChange.js';
import { changeMetaCampaignStatus } from '../lib/actions/metaCampaignChange.js';
import { decideProposal, confirmAndExecute } from '../lib/decisions/decide.js';
import { getProposal } from '../lib/proposals/store.js';

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-meta-campaign-change-'));
}

test('proposeMetaCampaignChange requires campaignId/toStatus/reason and derives authorityLevel 3 (FINANCIAL_ACTION)', () => {
  const dataDir = makeTempDataDir();
  try {
    assert.throws(() => proposeMetaCampaignChange(dataDir, { toStatus: 'PAUSED', reason: 'test' }), /campaignId/);
    assert.throws(() => proposeMetaCampaignChange(dataDir, { campaignId: 'camp-1', toStatus: 'DELETED', reason: 'test' }), /toStatus/);
    assert.throws(() => proposeMetaCampaignChange(dataDir, { campaignId: 'camp-1', toStatus: 'PAUSED' }), /reason/);

    const { proposal } = proposeMetaCampaignChange(dataDir, {
      campaignId: 'camp-1',
      campaignLabel: 'Free Summary - US - v2 (LPV)',
      toStatus: 'PAUSED',
      reason: 'Cost per landing page view degraded 43.6% over 7 days'
    });
    assert.equal(proposal.type, 'meta-campaign-change');
    assert.equal(proposal.authorityLevel, 3);
    assert.equal(proposal.status, 'pending');
    assert.deepEqual(proposal.payload, {
      campaignId: 'camp-1',
      campaignLabel: 'Free Summary - US - v2 (LPV)',
      toStatus: 'PAUSED',
      reason: 'Cost per landing page view degraded 43.6% over 7 days'
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function approvedProposal(dataDir, overrides = {}) {
  const { proposal } = proposeMetaCampaignChange(dataDir, {
    campaignId: 'camp-1',
    campaignLabel: 'Free Summary - US - v2 (LPV)',
    toStatus: 'PAUSED',
    reason: 'Cost degraded',
    ...overrides
  });
  await decideProposal(dataDir, proposal.id, 'approved', 'Pausing while we investigate', 'chris', 'cli');
  return getProposal(dataDir, proposal.id);
}

test('changeMetaCampaignStatus refuses an unapproved proposal and never calls the Meta API', async () => {
  const dataDir = makeTempDataDir();
  try {
    const { proposal } = proposeMetaCampaignChange(dataDir, { campaignId: 'camp-1', toStatus: 'PAUSED', reason: 'test' });
    let called = false;
    await assert.rejects(
      changeMetaCampaignStatus(proposal, {
        dataDir,
        instanceConfig: { research: { meta: {} } },
        token: 'tok',
        getMetaCampaignStatus: async () => {
          called = true;
          return { status: 'ACTIVE' };
        }
      }),
      /not approved/
    );
    assert.equal(called, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('changeMetaCampaignStatus requires authority-level-3 FINANCIAL_ACTION - approving alone never fires it', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('meta-campaign-change', changeMetaCampaignStatus);
  try {
    const approved = await approvedProposal(dataDir);
    // decideProposal only auto-executes EXTERNAL_ACTION (level 2); level 3
    // requires the separate confirmAndExecute call.
    assert.equal(approved.status, 'approved');
    const events = queryEvents(dataDir, { type: 'meta-campaign-change.applied' });
    assert.equal(events.length, 0);
  } finally {
    clearActionExecutor('meta-campaign-change');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('confirmAndExecute reaches the real executor and fails closed with no Meta token configured', async () => {
  const dataDir = makeTempDataDir();
  registerActionExecutor('meta-campaign-change', changeMetaCampaignStatus);
  try {
    const approved = await approvedProposal(dataDir);
    await assert.rejects(
      confirmAndExecute(dataDir, approved.id, 'chris', 'cli', {
        research: { meta: { tokenEnvVar: 'DEFINITELY_UNSET_VAR_XYZ' } }
      }),
      /env var "DEFINITELY_UNSET_VAR_XYZ"/
    );
    assert.equal(queryEvents(dataDir, { type: 'meta-campaign-change.applied' }).length, 0);
  } finally {
    clearActionExecutor('meta-campaign-change');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('changeMetaCampaignStatus applies the change and records fromStatus/toStatus, and is idempotent on a duplicate confirm', async () => {
  const dataDir = makeTempDataDir();
  try {
    const approved = await approvedProposal(dataDir);
    const getCalls = [];
    const setCalls = [];
    const ctx = {
      dataDir,
      instanceConfig: { research: { meta: {} } },
      token: 'tok',
      getMetaCampaignStatus: async (args) => {
        getCalls.push(args);
        return { id: args.campaignId, name: 'Free Summary - US - v2 (LPV)', status: 'ACTIVE', effectiveStatus: 'ACTIVE' };
      },
      setMetaCampaignStatus: async (args) => {
        setCalls.push(args);
        return { campaignId: args.campaignId, status: args.status, metaResponse: { success: true } };
      }
    };

    const first = await changeMetaCampaignStatus(approved, ctx);
    assert.equal(first.applied, true);
    assert.equal(first.idempotent, false);
    assert.equal(first.fromStatus, 'ACTIVE');
    assert.equal(first.toStatus, 'PAUSED');
    assert.equal(getCalls.length, 1);
    assert.equal(setCalls.length, 1);

    const appliedEvents = queryEvents(dataDir, { type: 'meta-campaign-change.applied' });
    assert.equal(appliedEvents.length, 1);
    assert.equal(appliedEvents[0].payload.campaignId, 'camp-1');
    assert.equal(appliedEvents[0].payload.fromStatus, 'ACTIVE');
    assert.equal(appliedEvents[0].payload.toStatus, 'PAUSED');

    const second = await changeMetaCampaignStatus(getProposal(dataDir, approved.id), ctx);
    assert.equal(second.idempotent, true);
    assert.equal(setCalls.length, 1, 'a duplicate confirm must never call the Meta API again');
    assert.equal(queryEvents(dataDir, { type: 'meta-campaign-change.applied' }).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('changeMetaCampaignStatus fails closed when no token env var is configured or set', async () => {
  const dataDir = makeTempDataDir();
  try {
    const approved = await approvedProposal(dataDir);
    await assert.rejects(
      changeMetaCampaignStatus(approved, { dataDir, instanceConfig: { research: { meta: { tokenEnvVar: 'DEFINITELY_UNSET_VAR_XYZ' } } } }),
      /env var "DEFINITELY_UNSET_VAR_XYZ"/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
