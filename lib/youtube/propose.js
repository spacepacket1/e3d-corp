import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { getOpportunity } from '../opportunities/store.js';
import { buildVideoSeries } from './series.js';
import { analyzeVideo, channelBaseline } from './metrics.js';
import { resolveThresholds } from './thresholds.js';
import { draftYoutubeGrowth, ROLE_NAME } from '../roles/youtubeGrowthDraft.js';
import { proposeYoutubeMetadataChange } from '../proposals/youtubeMetadataChange.js';

const YOUTUBE_OPPORTUNITY_PREFIX = 'youtube-';

const round = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);

function buildContext({ video, series, opportunity, now, thresholds }) {
  const analysis = analyzeVideo(video, series, now, thresholds);
  const baseline = channelBaseline(series, { excludeVideoId: video.videoId, minAgeDays: thresholds.baselineMinAgeDays });
  return {
    signal: { type: opportunity.type, title: opportunity.title, description: opportunity.description },
    video: {
      id: video.videoId,
      title: video.snippet?.title ?? video.title,
      description: (video.snippet?.description ?? '').slice(0, 3000),
      tags: video.snippet?.tags ?? [],
      ageDays: round(analysis.ageDays),
      privacy: video.privacyStatus
    },
    metrics: {
      views: analysis.latest?.viewCount ?? null,
      viewsPerDay: round(analysis.viewsPerDay?.value),
      views24h: analysis.views24h.insufficientData ? null : analysis.views24h.delta,
      views7d: analysis.views7d.insufficientData ? null : analysis.views7d.delta,
      trend: analysis.trend?.label ?? null,
      channelMedianViewsPerDay: round(baseline?.medianViewsPerDay)
    },
    recentComments: video.comments.slice(0, 10).map((c) => ({ commentId: c.commentId, author: c.author ?? null, text: String(c.text ?? '').slice(0, 400) }))
  };
}

// Turns one youtube-* Opportunity into drafts: audience copy and comment replies are level-1 internal drafts recorded
// as `youtube.draftQueued` events (a human posts them natively); a metadata change becomes a level-2 Proposal. Calls
// the LLM once per Opportunity and records that it did, so the same Opportunity is never drafted twice.
export async function proposeFromOpportunity(dataDir, opportunityId, { instanceConfig, llmClient, now = new Date() } = {}) {
  const opportunity = getOpportunity(dataDir, opportunityId);
  if (!opportunity) throw new Error(`Opportunity not found: ${opportunityId}`);
  if (!String(opportunity.type).startsWith(YOUTUBE_OPPORTUNITY_PREFIX) || !opportunity.signal?.videoId) {
    throw new Error(`Opportunity ${opportunityId} is not a YouTube opportunity (type: ${opportunity.type})`);
  }
  const done = queryEvents(dataDir, { type: 'youtube.growthDraft.completed', subject: { type: 'opportunity', id: opportunityId } });
  if (done.length > 0) return { alreadyDrafted: true, event: done[done.length - 1] };

  const series = buildVideoSeries(dataDir);
  const video = series.find((v) => v.videoId === opportunity.signal.videoId);
  if (!video || !video.snippet) throw new Error(`No recorded snippet for video ${opportunity.signal.videoId}; run "youtube sample" first`);
  const thresholds = resolveThresholds(instanceConfig?.research?.youtube?.thresholds);
  const context = buildContext({ video, series, opportunity, now, thresholds });
  const current = { title: video.snippet.title, description: video.snippet.description ?? '', tags: video.snippet.tags ?? [] };

  const oppEvents = queryEvents(dataDir, { subject: { type: 'opportunity', id: opportunityId } });
  const trigger = oppEvents[oppEvents.length - 1];
  const chain = opportunity.correlationId;
  const stamp = now.toISOString();

  let result;
  try {
    result = await draftYoutubeGrowth({ instanceConfig, context, current, commentIds: context.recentComments.map((c) => c.commentId), llmClient });
  } catch (error) {
    appendEvent(dataDir, {
      type: 'role.provider.failed', source: `role:${ROLE_NAME}`, subject: { type: 'role', id: ROLE_NAME },
      payload: { role: ROLE_NAME, reason: error.message, opportunityId }, causationId: trigger?.id ?? null, correlationId: chain, occurredAt: stamp
    });
    return { failed: true, reason: error.message };
  }

  const providerEvent = appendEvent(dataDir, {
    type: 'role.provider.completed', source: `role:${ROLE_NAME}`, subject: { type: 'role', id: ROLE_NAME },
    payload: { role: ROLE_NAME, provider: result.provider, model: result.model, usage: result.usage, costUsd: result.costUsd, latencyMs: result.latencyMs, opportunityId },
    causationId: trigger?.id ?? null, correlationId: chain, occurredAt: stamp
  });
  if (!result.ok) {
    return { failed: true, reason: result.reason, providerEvent };
  }

  const drafts = [];
  for (const item of result.audienceCopy) {
    drafts.push(appendEvent(dataDir, {
      type: 'youtube.draftQueued', source: 'youtube.propose', subject: { type: 'youtubeDraft', id: crypto.randomUUID() },
      payload: { kind: 'audience-copy', platform: item.platform, text: item.text, videoId: video.videoId, opportunityId, status: 'queued-for-human' },
      causationId: providerEvent.id, correlationId: chain, occurredAt: stamp
    }));
  }
  for (const item of result.commentReplies) {
    drafts.push(appendEvent(dataDir, {
      type: 'youtube.draftQueued', source: 'youtube.propose', subject: { type: 'youtubeDraft', id: crypto.randomUUID() },
      payload: { kind: 'comment-reply', commentId: item.commentId, text: item.reply, videoId: video.videoId, opportunityId, status: 'queued-for-human' },
      causationId: providerEvent.id, correlationId: chain, occurredAt: stamp
    }));
  }

  let proposal = null;
  if (result.metadataChange) {
    proposal = proposeYoutubeMetadataChange(dataDir, {
      videoId: video.videoId, videoTitle: current.title, changes: result.metadataChange.changes, current,
      baseSnippetHash: video.snippet.snippetHash, reason: result.metadataChange.rationale,
      hypothesis: `${opportunity.title}: this change should improve how the video is found or clicked`,
      opportunity, proposedBy: { role: ROLE_NAME, provider: result.provider, model: result.model }, instanceConfig
    }).proposal;
  }

  const completed = appendEvent(dataDir, {
    type: 'youtube.growthDraft.completed', source: 'youtube.propose', subject: { type: 'opportunity', id: opportunityId },
    payload: {
      opportunityId, videoId: video.videoId, proposalId: proposal?.id ?? null, draftEventIds: drafts.map((d) => d.id),
      dropped: result.dropped, notes: result.notes
    },
    causationId: providerEvent.id, correlationId: chain, occurredAt: stamp
  });
  return { drafted: true, proposal, drafts, dropped: result.dropped, notes: result.notes, event: completed };
}
