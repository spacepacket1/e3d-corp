import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { normalizePilotNudgePayload } from '../proposals/pilotRetentionNudgeSchema.js';

// The action for approved `pilot-retention-nudge` proposals (level 2). It is deliberately a RECORDED NO-OP HANDOFF:
// e3d-corp holds no addresses and sends nothing. Approving writes a handoff artifact (cohort, count, the approved
// copy) under <dataDir>/pilot-nudges/ and appends `pilot-retention-nudge.handed-off`, so the owner can see exactly
// what was approved. The actual send is a future Pilot-side command that will resolve the cohort to recipients on
// the Pilot server, where the addresses live.
// Properties: assertProposalAuthorized first; idempotent per proposal; re-validates the payload (still no addresses).
export async function recordPilotRetentionNudgeHandoff(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, 'pilot-retention-nudge');
  const { dataDir, causationId = null, correlationId } = ctx;
  if (!dataDir) throw new Error('recordPilotRetentionNudgeHandoff requires a dataDir');
  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const now = (ctx.now ?? (() => new Date()))();

  const prior = queryEvents(dataDir, { type: 'pilot-retention-nudge.handed-off', subject: { type: 'proposal', id: proposal.id } });
  if (prior.length > 0) return { handedOff: false, alreadyHandedOff: true, event: prior[prior.length - 1] };

  const payload = normalizePilotNudgePayload(proposal.payload);
  const dir = path.join(dataDir, 'pilot-nudges');
  fs.mkdirSync(dir, { recursive: true });
  const artifactPath = path.join(dir, `${proposal.id}.json`);
  const artifact = {
    proposalId: proposal.id,
    status: 'handoff-recorded-not-sent',
    note: 'e3d-corp sent nothing and holds no addresses. A Pilot-side command must resolve this cohort to recipients and send the approved copy.',
    cohort: payload.cohort,
    count: payload.count,
    copy: payload.copy,
    opportunityId: payload.opportunityId,
    approvedAt: now.toISOString()
  };
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });

  const event = append({
    type: 'pilot-retention-nudge.handed-off',
    source: 'action:pilot-retention-nudge',
    subject: { type: 'proposal', id: proposal.id },
    payload: { proposalId: proposal.id, cohort: payload.cohort, count: payload.count, artifactPath, sent: false, handedOffAt: now.toISOString() },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });
  return { handedOff: true, sent: false, artifactPath, event };
}
