import { queryEvents } from './store.js';

export function reconstructChain(dataDir, correlationId) {
  if (typeof correlationId !== 'string' || correlationId.trim() === '') {
    throw new Error('reconstructChain requires a non-empty correlationId');
  }

  return queryEvents(dataDir, { correlationId });
}
