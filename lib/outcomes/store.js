import { queryEvents } from '../events/store.js';
import { OUTCOME_TYPES } from './schema.js';

// Folded from the event log, same pattern Opportunities/Proposals/Actions
// already use - no second store.
export function listOutcomes(dataDir) {
  const events = OUTCOME_TYPES.flatMap((type) => queryEvents(dataDir, { type }));

  return events
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .map((event) => ({
      id: event.payload?.id ?? event.id,
      type: event.type,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      payload: event.payload
    }));
}
