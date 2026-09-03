import { queryEvents } from '../events/store.js';

// The event types that represent an action actually firing (as opposed to
// being proposed/approved). Extended as later phases register real
// executors (issue-invoice, ...). Exported so lib/experience/assemble.js can
// find "the action" in a chain without duplicating this list.
export const ACTION_FIRED_EVENT_TYPES = [
  'outreach.sent',
  'pilot-handoff.created',
  'capital-mandate.submitted',
  'financial-stress-change.published'
];

function summarizeAction(event) {
  if (event.type === 'outreach.sent') {
    return `outreach sent to ${event.payload?.to ?? '?'}: "${event.payload?.subject ?? ''}"`;
  }
  if (event.type === 'pilot-handoff.created') {
    return `pilot handoff written to ${event.payload?.targetRepo ?? '?'}`;
  }
  if (event.type === 'capital-mandate.submitted') {
    return `capital mandate ${event.payload?.mandateId ?? '?'} submitted to e3d-trade`;
  }
  if (event.type === 'financial-stress-change.published') {
    const status = event.payload?.success === false ? 'failed publishing' : 'published';
    return `financial stress change ${event.payload?.runId ?? '?'} ${status} to e3d`;
  }
  return event.type;
}

// Purely observational - Phase 5's Decision already happened upstream at the
// Proposal, so this is never something to "approve," just a log of what
// actually fired, folded from the event log like Opportunities/Proposals are.
export function listExecutedActions(dataDir) {
  const events = ACTION_FIRED_EVENT_TYPES.flatMap((type) => queryEvents(dataDir, { type }));

  return events
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      proposalId: event.payload?.proposalId ?? event.subject?.id ?? null,
      opportunityId: event.payload?.opportunityId ?? null,
      summary: summarizeAction(event)
    }));
}
