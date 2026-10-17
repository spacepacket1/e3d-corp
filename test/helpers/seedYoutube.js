// Writes youtube.* events directly into a data dir so scan/metric/outcome tests can start from a known series
// (instead of simulating days of sampler runs). Mirrors exactly what lib/event-sources/youtubeChannelSignal.js writes.
import { appendEvent } from '../../lib/events/store.js';
import { snippetHash, videoChainId, YOUTUBE_EVENTS } from '../../lib/youtube/series.js';

export const NOW = new Date('2026-10-20T00:00:00.000Z');
const H = 3_600_000;
export const isoAgo = (hoursAgo, from = NOW) => new Date(from.getTime() - hoursAgo * H).toISOString();

// samples: [{ hoursAgo, views, comments }]
export function seedVideo(dataDir, { id, title = `Video ${id}`, ageDays, description = `About ${id}`, tags = ['ai'], categoryId = '28', privacyStatus = 'public', samples = [], comments = [], from = NOW }) {
  const chain = videoChainId(id);
  const publishedAt = new Date(from.getTime() - ageDays * 24 * H).toISOString();
  const first = samples.length ? Math.max(...samples.map((s) => s.hoursAgo)) : 0;
  const hash = snippetHash({ title, description, tags, categoryId });
  const discovered = appendEvent(dataDir, {
    type: YOUTUBE_EVENTS.discovered, source: 'research.youtube', subject: { type: 'youtube-video', id },
    payload: { videoId: id, title, publishedAt, privacyStatus, discoveredAt: isoAgo(first, from) },
    causationId: null, correlationId: chain, occurredAt: isoAgo(first, from)
  });
  appendEvent(dataDir, {
    type: YOUTUBE_EVENTS.snippetRecorded, source: 'research.youtube', subject: { type: 'youtube-video', id },
    payload: { videoId: id, title, description, tags, categoryId, snippetHash: hash, recordedAt: isoAgo(first, from) },
    causationId: discovered.id, correlationId: chain, occurredAt: isoAgo(first, from)
  });
  const sampleEvents = [];
  for (const sample of [...samples].sort((a, b) => b.hoursAgo - a.hoursAgo)) {
    sampleEvents.push(appendEvent(dataDir, {
      type: YOUTUBE_EVENTS.sampled, source: 'research.youtube', subject: { type: 'youtube-video', id },
      payload: { videoId: id, title, publishedAt, privacyStatus, viewCount: sample.views, likeCount: sample.likes ?? 0, commentCount: sample.comments ?? 0, sampledAt: isoAgo(sample.hoursAgo, from), snippetHash: hash },
      causationId: null, correlationId: chain, occurredAt: isoAgo(sample.hoursAgo, from)
    }));
  }
  const commentEvents = comments.map((comment) => appendEvent(dataDir, {
    type: YOUTUBE_EVENTS.commentDiscovered, source: 'research.youtube', subject: { type: 'youtube-comment', id: comment.commentId },
    payload: { videoId: id, commentId: comment.commentId, author: comment.author ?? 'someone', text: comment.text, publishedAt: comment.publishedAt ?? isoAgo(2, from), likeCount: 0 },
    causationId: null, correlationId: chain, occurredAt: comment.publishedAt ?? isoAgo(2, from)
  }));
  return { publishedAt, sampleEvents, commentEvents };
}

// A steadily growing video: `perDay` views/day for `ageDays`, sampled every 6h over the last `daysOfSamples` days.
export function steadySamples({ ageDays, perDay, daysOfSamples = 4, comments = () => 0 }) {
  const out = [];
  for (let hoursAgo = Math.min(daysOfSamples * 24, ageDays * 24); hoursAgo >= 0; hoursAgo -= 6) {
    out.push({ hoursAgo, views: Math.round(perDay * (ageDays - hoursAgo / 24)), comments: comments(hoursAgo) });
  }
  return out;
}
