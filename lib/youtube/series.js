import crypto from 'node:crypto';
import { queryEvents } from '../events/store.js';

export const YOUTUBE_EVENTS = Object.freeze({
  discovered: 'youtube.video.discovered',
  sampled: 'youtube.video.sampled',
  snippetRecorded: 'youtube.video.snippet_recorded',
  commentDiscovered: 'youtube.comment.discovered'
});

// Every video's events share one correlation chain, so reconstructChain(videoChainId(id)) shows its whole history.
export const videoChainId = (videoId) => `youtube-video:${videoId}`;

export function snippetHash({ title, description, tags, categoryId }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ title: title ?? '', description: description ?? '', tags: tags ?? [], categoryId: categoryId ?? '' }))
    .digest('hex')
    .slice(0, 16);
}

// Folds the event log into per-video series. Nothing is stored anywhere else: this is a pure read.
export function buildVideoSeries(dataDir) {
  const byId = new Map();
  const ensure = (id) => {
    if (!byId.has(id)) {
      byId.set(id, { videoId: id, title: null, publishedAt: null, privacyStatus: null, discoveredAt: null, samples: [], snippet: null, comments: [] });
    }
    return byId.get(id);
  };

  for (const event of queryEvents(dataDir, { type: YOUTUBE_EVENTS.discovered })) {
    const video = ensure(event.payload.videoId);
    video.title = event.payload.title ?? video.title;
    video.publishedAt = event.payload.publishedAt ?? video.publishedAt;
    video.discoveredAt = event.payload.discoveredAt ?? event.occurredAt;
  }
  for (const event of queryEvents(dataDir, { type: YOUTUBE_EVENTS.snippetRecorded })) {
    ensure(event.payload.videoId).snippet = { ...event.payload, eventId: event.id };
  }
  for (const event of queryEvents(dataDir, { type: YOUTUBE_EVENTS.sampled })) {
    const p = event.payload;
    const video = ensure(p.videoId);
    video.title = p.title ?? video.title;
    video.publishedAt = p.publishedAt ?? video.publishedAt;
    video.privacyStatus = p.privacyStatus ?? video.privacyStatus;
    video.samples.push({
      eventId: event.id,
      sampledAt: p.sampledAt,
      viewCount: p.viewCount,
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      snippetHash: p.snippetHash ?? null
    });
  }
  for (const event of queryEvents(dataDir, { type: YOUTUBE_EVENTS.commentDiscovered })) {
    ensure(event.payload.videoId).comments.push({ eventId: event.id, ...event.payload });
  }

  for (const video of byId.values()) {
    video.samples.sort((a, b) => new Date(a.sampledAt) - new Date(b.sampledAt));
    video.comments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }
  return [...byId.values()].filter((video) => video.samples.length > 0 || video.discoveredAt);
}
