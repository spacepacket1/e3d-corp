import { appendEvent } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { sendEmailViaSes } from '../outreach/sesTransport.js';

// The actual action-execution function for `send-outreach` proposals,
// registered against lib/actions/registry.js so Phase 5's decide.js can fire
// it on approval. Refuses to run against anything but an approved proposal -
// enforced here via assertProposalAuthorized, not only by the CLI/web layer
// that got it here - and on success appends `outreach.sent`, causationId
// pointing at the approving Decision, same correlationId as the originating
// Opportunity/lead chain (both supplied by decide.js's ctx).
export async function sendOutreach(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, 'send-outreach');

  const { dataDir, causationId = null, correlationId, instanceConfig, transport } = ctx;
  if (!dataDir) {
    throw new Error('sendOutreach requires a dataDir');
  }

  const { to, subject, body } = proposal.payload ?? {};
  if (typeof to !== 'string' || to.trim() === '' || typeof subject !== 'string' || subject.trim() === '' || typeof body !== 'string' || body.trim() === '') {
    throw new Error(`Proposal ${proposal.id} is missing to/subject/body; refusing to send outreach`);
  }

  const send = transport ?? sendEmailViaSes;
  const sendResult = await send({ instanceConfig, to, subject, body });
  const sentAt = new Date().toISOString();

  const event = appendEvent(dataDir, {
    type: 'outreach.sent',
    source: 'action:send-outreach',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      opportunityId: proposal.payload?.opportunityId ?? null,
      to,
      subject,
      body,
      sentAt,
      transport: sendResult.transport,
      providerMessageId: sendResult.messageId ?? null
    },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });

  return { sent: true, sentAt, transport: sendResult.transport, providerMessageId: sendResult.messageId ?? null, event };
}
