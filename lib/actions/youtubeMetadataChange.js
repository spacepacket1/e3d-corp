import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { createYoutubeClientFromConfig } from '../research/youtubeConfig.js';
import { YoutubeApiError } from '../research/youtubeApi.js';
import { buildVideoSeries, snippetHash } from '../youtube/series.js';
import { channelBaseline, latestSample, viewsPerDay } from '../youtube/metrics.js';

const FIELDS = ['title', 'description', 'tags'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The action for approved `youtube-metadata-change` proposals (level 2: approval and execution are one call).
// It is the only code that writes to the channel. Properties, each covered by test/youtubeMetadataChange.test.js:
//  - assertProposalAuthorized first; never runs for an unapproved proposal;
//  - idempotent: a proposal that already has an applied event is never written twice;
//  - refuses on conflict: if the video's snippet changed since the proposal was made, nothing is written;
//  - fails closed without OAuth (an API key cannot write);
//  - videos.update REPLACES unspecified snippet fields, so the PUT carries the full current snippet merged with the change.
// A refusal is recorded as a `youtube-metadata-change.failed` event and returned (not thrown), so an approved
// proposal can be retried with `youtube apply <proposalId>` once the cause is fixed.
export async function applyYoutubeMetadataChange(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, 'youtube-metadata-change');
  const { dataDir, causationId = null, correlationId, instanceConfig, now = () => new Date() } = ctx;
  if (!dataDir) throw new Error('applyYoutubeMetadataChange requires a dataDir');
  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const chain = correlationId ?? proposal.correlationId;
  const { videoId, changes, before, baseSnippetHash } = proposal.payload;

  const prior = queryEvents(dataDir, { type: 'youtube-metadata-change.applied', subject: { type: 'proposal', id: proposal.id } });
  if (prior.length > 0) return { applied: false, alreadyApplied: true, event: prior[prior.length - 1] };

  const fail = (reason, extra = {}) => ({
    applied: false,
    reason,
    event: append({
      type: 'youtube-metadata-change.failed', source: 'action:youtube-metadata-change',
      subject: { type: 'proposal', id: proposal.id },
      payload: { proposalId: proposal.id, videoId, reason, failedAt: now().toISOString(), ...extra },
      causationId, correlationId: chain
    })
  });

  const client = ctx.client ?? createYoutubeClientFromConfig(instanceConfig);
  let current;
  try {
    current = await client.getVideoSnippet(videoId);
  } catch (error) {
    if (error instanceof YoutubeApiError) return fail(`could not read the video before changing it: ${error.message}`, { errorKind: error.kind });
    throw error;
  }

  const currentFields = { title: current.title, description: current.description ?? '', tags: current.tags ?? [] };
  const currentHash = snippetHash({ ...currentFields, categoryId: current.categoryId });
  const driftedFields = FIELDS.filter((f) => f in before && !same(before[f], currentFields[f]));
  if (driftedFields.length > 0 || (baseSnippetHash && baseSnippetHash !== currentHash)) {
    return fail('conflict: the video was edited after this proposal was made; nothing was changed', {
      conflict: true, driftedFields, expectedSnippetHash: baseSnippetHash, currentSnippetHash: currentHash
    });
  }
  if (!current.title || !current.categoryId) return fail('the current snippet has no title or categoryId, so a safe full-snippet update is impossible');

  const merged = { ...current, ...changes };
  const after = {};
  for (const key of Object.keys(changes)) after[key] = changes[key];

  const series = buildVideoSeries(dataDir);
  const video = series.find((v) => v.videoId === videoId);
  const vpd = video ? viewsPerDay(video) : null;
  const sample = video ? latestSample(video) : null;
  const channel = channelBaseline(series, { excludeVideoId: videoId });

  try {
    await client.updateVideoSnippet(videoId, merged);
  } catch (error) {
    if (error instanceof YoutubeApiError) return fail(`YouTube refused the update: ${error.message}`, { errorKind: error.kind });
    throw error;
  }

  const appliedAt = now().toISOString();
  const event = append({
    type: 'youtube-metadata-change.applied', source: 'action:youtube-metadata-change',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id, videoId, appliedAt,
      before: Object.fromEntries(Object.keys(changes).map((k) => [k, currentFields[k]])),
      after,
      afterSnippetHash: snippetHash({ ...currentFields, ...after, categoryId: current.categoryId }),
      rollbackOf: proposal.payload.rollbackOf ?? null,
      baseline: {
        viewCount: sample?.viewCount ?? null,
        sampledAt: sample?.sampledAt ?? null,
        viewsPerDay: vpd?.value ?? null,
        channelMedianViewsPerDay: channel?.medianViewsPerDay ?? null
      },
      quotaUnitsUsed: client.quotaUnitsUsed ?? null
    },
    causationId, correlationId: chain
  });
  return { applied: true, event };
}
