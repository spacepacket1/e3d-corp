// A local fake of the parts of the YouTube Data API v3 and Google's OAuth token endpoint that e3d-corp uses.
// Deterministic: all data comes from `state`, which tests mutate between calls. No real network.
import http from 'node:http';

export const FAKE_KEY = 'fake-api-key';
export const FAKE_ACCESS_TOKEN = 'fake-access-token';
export const FAKE_REFRESH_TOKEN = 'fake-refresh-token';
export const FAKE_CHANNEL_ID = 'UC_FAKE_CHANNEL';

export function makeVideo(id, { title, description = '', tags = [], publishedAt, views = 0, likes = 0, comments = 0, privacyStatus = 'public', categoryId = '28' } = {}) {
  return {
    id,
    snippet: { channelId: FAKE_CHANNEL_ID, title: title ?? `Video ${id}`, description, tags, categoryId, publishedAt, defaultLanguage: 'en' },
    statistics: { viewCount: String(views), likeCount: String(likes), commentCount: String(comments) },
    status: { privacyStatus }
  };
}

export async function startFakeYoutube({ videos = [], comments = {} } = {}) {
  const state = {
    videos: new Map(videos.map((video) => [video.id, video])),
    comments, // videoId -> [{ id, author, text, publishedAt, likes }]
    pageSize: 50, // lower it to test paging
    failNext: null, // { status, reason, message }: consumed by the next API call
    commentsDisabledFor: new Set(),
    calls: [],
    updates: [],
    tokenRequests: 0,
    refreshTokenValid: true
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const apiError = (res, status, reason, message) =>
    json(res, status, { error: { code: status, message, errors: [{ reason, message }], status: reason } });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const query = Object.fromEntries(url.searchParams);
      const auth = req.headers.authorization ?? null;
      state.calls.push({ method: req.method, path: url.pathname, query, auth });

      if (url.pathname === '/token') {
        state.tokenRequests += 1;
        const form = new URLSearchParams(raw);
        if (!state.refreshTokenValid || form.get('refresh_token') !== FAKE_REFRESH_TOKEN) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        }
        return json(res, 200, { access_token: FAKE_ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' });
      }

      if (state.failNext) {
        const { status, reason, message } = state.failNext;
        state.failNext = null;
        return apiError(res, status, reason, message ?? reason);
      }

      const keyOk = query.key === FAKE_KEY;
      const bearerOk = auth === `Bearer ${FAKE_ACCESS_TOKEN}`;
      if (!keyOk && !bearerOk) return apiError(res, 400, 'keyInvalid', 'API key not valid. Please pass a valid API key.');

      if (url.pathname === '/youtube/v3/channels') {
        if (query.id !== FAKE_CHANNEL_ID) return json(res, 200, { items: [] });
        return json(res, 200, { items: [{ id: FAKE_CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: 'UU_FAKE_UPLOADS' } } }] });
      }

      if (url.pathname === '/youtube/v3/playlistItems') {
        const ordered = [...state.videos.values()].sort((a, b) => b.snippet.publishedAt.localeCompare(a.snippet.publishedAt));
        const start = Number(query.pageToken ?? 0);
        const page = ordered.slice(start, start + Math.min(Number(query.maxResults ?? 50), state.pageSize));
        const next = start + page.length < ordered.length ? String(start + page.length) : undefined;
        return json(res, 200, {
          items: page.map((video) => ({ contentDetails: { videoId: video.id, videoPublishedAt: video.snippet.publishedAt } })),
          nextPageToken: next
        });
      }

      if (url.pathname === '/youtube/v3/videos' && req.method === 'GET') {
        const ids = (query.id ?? '').split(',').filter(Boolean);
        if (ids.length > 50) return apiError(res, 400, 'invalidRequest', 'too many ids');
        const parts = (query.part ?? '').split(',');
        const items = ids.filter((id) => state.videos.has(id)).map((id) => {
          const video = state.videos.get(id);
          const item = { id };
          if (parts.includes('snippet')) item.snippet = structuredClone(video.snippet);
          if (parts.includes('statistics')) item.statistics = structuredClone(video.statistics);
          if (parts.includes('status')) item.status = structuredClone(video.status);
          return item;
        });
        return json(res, 200, { items });
      }

      if (url.pathname === '/youtube/v3/videos' && req.method === 'PUT') {
        if (!bearerOk) return apiError(res, 401, 'authError', 'This call requires OAuth');
        const body = JSON.parse(raw || '{}');
        const video = state.videos.get(body.id);
        if (!video) return apiError(res, 404, 'videoNotFound', 'The video could not be found.');
        // the real API rejects an update whose snippet has no title or categoryId
        if (!body.snippet?.title || !body.snippet?.categoryId) return apiError(res, 400, 'invalidVideoMetadata', 'snippet.title and snippet.categoryId are required');
        state.updates.push(structuredClone(body));
        video.snippet = { ...video.snippet, ...structuredClone(body.snippet) };
        return json(res, 200, { id: body.id, snippet: structuredClone(video.snippet) });
      }

      if (url.pathname === '/youtube/v3/commentThreads') {
        if (state.commentsDisabledFor.has(query.videoId)) return apiError(res, 403, 'commentsDisabled', 'The video has disabled comments.');
        const list = (state.comments[query.videoId] ?? []).slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
        return json(res, 200, {
          items: list.slice(0, Number(query.maxResults ?? 20)).map((comment) => ({
            id: `thread-${comment.id}`,
            snippet: { topLevelComment: { id: comment.id, snippet: { authorDisplayName: comment.author, textDisplay: comment.text, publishedAt: comment.publishedAt, likeCount: comment.likes ?? 0 } } }
          }))
        });
      }

      return apiError(res, 404, 'notFound', `fake server has no route for ${req.method} ${url.pathname}`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    setViews(id, views, extra = {}) {
      const video = state.videos.get(id);
      video.statistics.viewCount = String(views);
      if (extra.likes !== undefined) video.statistics.likeCount = String(extra.likes);
      if (extra.comments !== undefined) video.statistics.commentCount = String(extra.comments);
    },
    addVideo(video) { state.videos.set(video.id, video); },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
