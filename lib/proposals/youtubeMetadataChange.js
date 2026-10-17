import { queryEvents } from '../events/store.js';
import { createProposal } from './create.js';
import { getProposal } from './store.js';
import { YOUTUBE_METADATA_PROPOSAL_TYPE } from './youtubeMetadataSchema.js';
import { videoChainId, YOUTUBE_EVENTS } from '../youtube/series.js';

const latest = (events) => events[events.length - 1] ?? null;

// Proposes a title/description/tags change for a video. `current` is the video's present snippet as last recorded
// (the caller reads it from the event log or live); every changed field's current value becomes the rollback.
export function proposeYoutubeMetadataChange(dataDir, { videoId, videoTitle = null, changes, current, baseSnippetHash = null, reason, hypothesis = null, opportunity = null, proposedBy, instanceConfig, rollbackOf = null } = {}) {
  if (!videoId) throw new Error('proposeYoutubeMetadataChange requires a videoId');
  const before = {};
  for (const key of Object.keys(changes ?? {})) before[key] = current?.[key];
  const chain = opportunity?.correlationId ?? videoChainId(videoId);
  const causation = opportunity
    ? latest(queryEvents(dataDir, { subject: { type: 'opportunity', id: opportunity.id } }))
    : latest(queryEvents(dataDir, { type: YOUTUBE_EVENTS.snippetRecorded, subject: { type: 'youtube-video', id: videoId } }));
  return createProposal(dataDir, {
    type: YOUTUBE_METADATA_PROPOSAL_TYPE,
    payload: { videoId, videoTitle, changes, before, baseSnippetHash, reason, hypothesis, opportunityId: opportunity?.id ?? null, rollbackOf },
    proposedBy: proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    causationId: causation?.id ?? null,
    correlationId: chain,
    instanceConfig
  });
}

// A rollback is just another pending proposal, so it needs the same human approval: it restores `before` for exactly
// the fields the original changed, and its own `before` is what the original wrote.
export function proposeYoutubeRollback(dataDir, proposalId, { proposedBy, instanceConfig } = {}) {
  const original = getProposal(dataDir, proposalId);
  if (!original || original.type !== YOUTUBE_METADATA_PROPOSAL_TYPE) throw new Error(`Proposal ${proposalId} is not a youtube-metadata-change proposal`);
  const applied = latest(queryEvents(dataDir, { type: 'youtube-metadata-change.applied', subject: { type: 'proposal', id: proposalId } }));
  if (!applied) throw new Error(`Proposal ${proposalId} was never applied; there is nothing to roll back`);
  return proposeYoutubeMetadataChange(dataDir, {
    videoId: original.payload.videoId,
    videoTitle: original.payload.videoTitle,
    changes: original.payload.before,
    current: applied.payload.after,
    baseSnippetHash: applied.payload.afterSnippetHash ?? null,
    reason: `Rollback of proposal ${proposalId}: ${original.payload.reason}`,
    hypothesis: null,
    proposedBy: proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    instanceConfig,
    rollbackOf: proposalId
  });
}
