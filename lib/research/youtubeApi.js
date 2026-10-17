// Thin YouTube Data API v3 client (stdlib fetch, no SDK). Read-only methods work with a plain API key
// (public statistics need no OAuth, and an API key does not expire); the one write method
// (updateVideoSnippet) needs an OAuth access token and is the only thing here that can change the channel.
//
// Quota (default 10,000 units/day): every list/get below costs 1 unit, videos.update costs 50.
// `client.quotaUnitsUsed` tracks this process's own spend so callers can report it.

const DEFAULT_BASE_URL = 'https://www.googleapis.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const VIDEOS_PER_REQUEST = 50;
const UNIT_COST = { read: 1, write: 50 };

export class YoutubeApiError extends Error {
  // kind: quota | auth | not_found | unavailable | network | invalid
  constructor(message, { kind, status = null, reason = null } = {}) {
    super(message);
    this.name = 'YoutubeApiError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']);
const AUTH_REASONS = new Set(['keyInvalid', 'forbidden', 'accessNotConfigured', 'ipRefererBlocked', 'insufficientPermissions', 'authError']);

function classifyError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;
  const message = body?.error?.message ?? `HTTP ${status}`;
  let kind = 'invalid';
  if (QUOTA_REASONS.has(reason)) kind = 'quota';
  else if (status === 401 || AUTH_REASONS.has(reason) || /API key/i.test(message)) kind = 'auth';
  else if (status === 404) kind = 'not_found';
  else if (status === 429 || status >= 500) kind = status === 429 ? 'quota' : 'unavailable';
  return new YoutubeApiError(`YouTube API ${status}${reason ? ` (${reason})` : ''}: ${message}`, { kind, status, reason });
}

const num = (value) => (value === undefined || value === null || value === '' ? null : Number(value));

function normalizeVideo(item) {
  const snippet = item.snippet ?? {};
  const stats = item.statistics ?? {};
  return {
    id: item.id,
    channelId: snippet.channelId ?? null,
    title: snippet.title ?? null,
    description: snippet.description ?? '',
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    categoryId: snippet.categoryId ?? null,
    publishedAt: snippet.publishedAt ?? null,
    privacyStatus: item.status?.privacyStatus ?? null,
    // statistics fields are strings, and are absent (not zero) when the owner hides them
    viewCount: num(stats.viewCount),
    likeCount: num(stats.likeCount),
    commentCount: num(stats.commentCount)
  };
}

export function createYoutubeClient({
  baseUrl = DEFAULT_BASE_URL,
  apiKey = null,
  getAccessToken = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const client = { quotaUnitsUsed: 0 };

  async function request({ method = 'GET', path, query = {}, body, requireOAuth = false, cost }) {
    const headers = { accept: 'application/json' };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    if (requireOAuth) {
      if (typeof getAccessToken !== 'function') {
        throw new YoutubeApiError('This call changes the channel and needs OAuth, which is not configured (research.youtube.oauth)', { kind: 'auth' });
      }
      headers.authorization = `Bearer ${await getAccessToken()}`;
    } else if (apiKey) {
      params.set('key', apiKey);
    } else if (typeof getAccessToken === 'function') {
      headers.authorization = `Bearer ${await getAccessToken()}`;
    } else {
      throw new YoutubeApiError('No YouTube API key or OAuth configured (research.youtube)', { kind: 'auth' });
    }
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(`${root}${path}?${params.toString()}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new YoutubeApiError(`YouTube API network error: ${error.message}`, { kind: 'network' });
    }
    client.quotaUnitsUsed += cost;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) throw classifyError(response.status, payload);
    return payload ?? {};
  }

  client.getChannelUploadsPlaylistId = async (channelId) => {
    const data = await request({ path: '/youtube/v3/channels', query: { part: 'contentDetails', id: channelId }, cost: UNIT_COST.read });
    const playlist = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlist) throw new YoutubeApiError(`Channel ${channelId} not found or has no uploads playlist`, { kind: 'not_found' });
    return playlist;
  };

  client.listUploadVideoIds = async (playlistId, { maxPages = 10 } = {}) => {
    const ids = [];
    let pageToken;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await request({
        path: '/youtube/v3/playlistItems',
        query: { part: 'contentDetails', playlistId, maxResults: 50, pageToken },
        cost: UNIT_COST.read
      });
      for (const item of data.items ?? []) {
        const id = item.contentDetails?.videoId;
        if (id) ids.push(id);
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  };

  client.getVideos = async (ids) => {
    const videos = [];
    for (let i = 0; i < ids.length; i += VIDEOS_PER_REQUEST) {
      const batch = ids.slice(i, i + VIDEOS_PER_REQUEST);
      const data = await request({
        path: '/youtube/v3/videos',
        query: { part: 'snippet,statistics,status', id: batch.join(',') },
        cost: UNIT_COST.read
      });
      for (const item of data.items ?? []) videos.push(normalizeVideo(item));
    }
    return videos;
  };

  // Newest-first top-level comments. A video with comments turned off is not an error worth degrading over.
  client.listRecentComments = async (videoId, { maxResults = 20 } = {}) => {
    try {
      const data = await request({
        path: '/youtube/v3/commentThreads',
        query: { part: 'snippet', videoId, order: 'time', maxResults, textFormat: 'plainText' },
        cost: UNIT_COST.read
      });
      const comments = (data.items ?? []).map((thread) => {
        const top = thread.snippet?.topLevelComment;
        return {
          commentId: top?.id ?? thread.id,
          authorDisplayName: top?.snippet?.authorDisplayName ?? null,
          text: top?.snippet?.textDisplay ?? top?.snippet?.textOriginal ?? '',
          publishedAt: top?.snippet?.publishedAt ?? null,
          likeCount: num(top?.snippet?.likeCount) ?? 0
        };
      });
      return { comments, disabled: false };
    } catch (error) {
      if (error instanceof YoutubeApiError && error.reason === 'commentsDisabled') return { comments: [], disabled: true };
      throw error;
    }
  };

  // The raw, complete snippet. videos.update REPLACES unspecified snippet fields, so a write must start from this.
  client.getVideoSnippet = async (videoId) => {
    const data = await request({ path: '/youtube/v3/videos', query: { part: 'snippet', id: videoId }, cost: UNIT_COST.read });
    const item = data.items?.[0];
    if (!item) throw new YoutubeApiError(`Video ${videoId} not found`, { kind: 'not_found' });
    return item.snippet ?? {};
  };

  // The only write. Requires OAuth. Callers must pass the FULL snippet (see getVideoSnippet).
  client.updateVideoSnippet = (videoId, snippet) =>
    request({ method: 'PUT', path: '/youtube/v3/videos', query: { part: 'snippet' }, body: { id: videoId, snippet }, requireOAuth: true, cost: UNIT_COST.write });

  return client;
}

export { UNIT_COST, VIDEOS_PER_REQUEST };
