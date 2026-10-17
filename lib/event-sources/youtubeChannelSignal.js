import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';
import { resolveYoutubeConfig } from '../research/youtubeConfig.js';
import { YoutubeApiError } from '../research/youtubeApi.js';
import { buildVideoSeries, snippetHash, videoChainId, YOUTUBE_EVENTS } from '../youtube/series.js';

const SOURCE = 'research.youtube';
const MAX_COMMENT_CHARS = 1000;

function lastSampledAt(series) {
  let latest = 0;
  for (const video of series) {
    const last = video.samples[video.samples.length - 1];
    if (last) latest = Math.max(latest, new Date(last.sampledAt).getTime());
  }
  return latest || null;
}

// A failure to reach YouTube is recorded as degraded evidence (the same shape lib/research/adapter.js uses for an
// unavailable provider) and NEVER turned into numbers. Nothing downstream can mistake a gap for a zero.
function recordDegraded(dataDir, { channelId, step, error, now }) {
  return appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: SOURCE,
    subject: { type: 'research', id: crypto.randomUUID() },
    payload: {
      kind: 'youtube-channel-sample',
      query: { channelId, step },
      resultSummary: `YouTube ${step} unavailable (${error.kind ?? 'error'}): ${error.message}`,
      result: { status: 'unavailable', reason: error.kind ?? 'error', summary: error.message, step },
      degraded: true
    },
    causationId: null,
    correlationId: `youtube-sample-run:${crypto.randomUUID()}`,
    occurredAt: now.toISOString()
  });
}

// Authority level 0: read-only ingestion. Samples every upload on the channel and appends:
//   youtube.video.discovered        once per video, the first time it is seen
//   youtube.video.snippet_recorded  the title/description/tags whenever they change (and first time)
//   youtube.video.sampled           views/likes/comments at this moment
//   youtube.comment.discovered      a newly seen top-level comment (only when the comment count grew)
// A minimum sampling interval (research.youtube.minSampleIntervalMinutes) makes repeated runs cheap and
// idempotent: inside the interval it returns { skipped: 'interval' } without a single API call.
export async function sampleChannel({ dataDir, instanceConfig, client, now = new Date(), force = false } = {}) {
  if (!dataDir) throw new Error('sampleChannel requires a dataDir');
  if (!client) throw new Error('sampleChannel requires a client');
  const config = resolveYoutubeConfig(instanceConfig);

  const series = buildVideoSeries(dataDir);
  const last = lastSampledAt(series);
  if (!force && last !== null && now.getTime() - last < config.minSampleIntervalMs) {
    return { skipped: 'interval', nextSampleAt: new Date(last + config.minSampleIntervalMs).toISOString(), sampled: 0, discovered: 0, comments: 0, degraded: false, quotaUnitsUsed: 0 };
  }

  const summary = { skipped: null, sampled: 0, discovered: 0, snippets: 0, comments: 0, degraded: false, errors: [], videoIds: [], quotaUnitsUsed: 0 };
  const known = new Map(series.map((video) => [video.videoId, video]));
  const seenComments = new Set(series.flatMap((video) => video.comments.map((comment) => comment.commentId)));

  let videos;
  try {
    const playlistId = await client.getChannelUploadsPlaylistId(config.channelId);
    const ids = (await client.listUploadVideoIds(playlistId)).slice(0, config.maxVideos);
    videos = await client.getVideos(ids);
  } catch (error) {
    if (!(error instanceof YoutubeApiError)) throw error;
    recordDegraded(dataDir, { channelId: config.channelId, step: 'channel sample', error, now });
    summary.degraded = true;
    summary.errors.push({ step: 'channel sample', kind: error.kind, message: error.message });
    summary.quotaUnitsUsed = client.quotaUnitsUsed ?? 0;
    return summary;
  }

  for (const video of videos) {
    const chain = videoChainId(video.id);
    const prior = known.get(video.id);
    const priorSample = prior?.samples[prior.samples.length - 1] ?? null;
    let discoveredEvent = null;

    if (!prior || !prior.discoveredAt) {
      discoveredEvent = appendEvent(dataDir, {
        type: YOUTUBE_EVENTS.discovered,
        source: SOURCE,
        subject: { type: 'youtube-video', id: video.id },
        payload: { videoId: video.id, title: video.title, publishedAt: video.publishedAt, privacyStatus: video.privacyStatus, discoveredAt: now.toISOString() },
        causationId: null,
        correlationId: chain,
        occurredAt: now.toISOString()
      });
      summary.discovered += 1;
    }

    const hash = snippetHash(video);
    if (prior?.snippet?.snippetHash !== hash) {
      appendEvent(dataDir, {
        type: YOUTUBE_EVENTS.snippetRecorded,
        source: SOURCE,
        subject: { type: 'youtube-video', id: video.id },
        payload: { videoId: video.id, title: video.title, description: video.description, tags: video.tags, categoryId: video.categoryId, snippetHash: hash, recordedAt: now.toISOString() },
        causationId: discoveredEvent?.id ?? null,
        correlationId: chain,
        occurredAt: now.toISOString()
      });
      summary.snippets += 1;
    }

    appendEvent(dataDir, {
      type: YOUTUBE_EVENTS.sampled,
      source: SOURCE,
      subject: { type: 'youtube-video', id: video.id },
      payload: {
        videoId: video.id,
        title: video.title,
        publishedAt: video.publishedAt,
        privacyStatus: video.privacyStatus,
        viewCount: video.viewCount,
        likeCount: video.likeCount,
        commentCount: video.commentCount,
        sampledAt: now.toISOString(),
        snippetHash: hash
      },
      causationId: discoveredEvent?.id ?? null,
      correlationId: chain,
      occurredAt: now.toISOString()
    });
    summary.sampled += 1;
    summary.videoIds.push(video.id);

    // Only spend a call on comments when the public count says there is something new (or this is the first look).
    const grew = video.commentCount !== null && video.commentCount > (priorSample?.commentCount ?? 0);
    if (grew) {
      try {
        const { comments } = await client.listRecentComments(video.id, { maxResults: config.maxCommentsPerVideo });
        for (const comment of comments) {
          if (seenComments.has(comment.commentId)) continue;
          seenComments.add(comment.commentId);
          appendEvent(dataDir, {
            type: YOUTUBE_EVENTS.commentDiscovered,
            source: SOURCE,
            subject: { type: 'youtube-comment', id: comment.commentId },
            payload: {
              videoId: video.id,
              commentId: comment.commentId,
              author: comment.authorDisplayName,
              text: String(comment.text ?? '').slice(0, MAX_COMMENT_CHARS),
              publishedAt: comment.publishedAt,
              likeCount: comment.likeCount
            },
            causationId: null,
            correlationId: chain,
            occurredAt: now.toISOString()
          });
          summary.comments += 1;
        }
      } catch (error) {
        if (!(error instanceof YoutubeApiError)) throw error;
        recordDegraded(dataDir, { channelId: config.channelId, step: `comments for ${video.id}`, error, now });
        summary.degraded = true;
        summary.errors.push({ step: `comments for ${video.id}`, kind: error.kind, message: error.message });
      }
    }
  }

  summary.quotaUnitsUsed = client.quotaUnitsUsed ?? 0;
  return summary;
}
