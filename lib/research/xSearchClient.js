// Read-only X API v2 recent-search client for the draft-and-queue pipeline.
// Deliberately contains no posting or OAuth2 user-context code: search only
// needs a static app-auth Bearer token (the same kind every other
// evidence-pull in this file already uses - compare lib/research/oppscanFeed.js,
// lib/research/metaInsights.js), so there is nothing here capable of taking
// a real-world action. Degrades gracefully (status: 'unavailable') on any
// error instead of throwing, same convention as the other research adapters,
// since X's search tier/pricing is unconfirmed and this must not crash a
// cron run if the account isn't entitled to it.

import { deriveAppBearer } from './xAppBearer.js';

const X_SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent';

function unavailableResult(query, reason) {
  return {
    status: 'unavailable',
    provider: 'x-search',
    query,
    reason,
    summary: reason,
    tweets: []
  };
}

// Why X returns HTTP 401 here: the search endpoint needs an app-only Bearer
// token (or a valid user-context token). A 401 means the token was rejected as
// invalid, expired or the wrong type - typically an OAuth2 *user* access token
// (2h lifetime) or a revoked key pasted as X_SEARCH_BEARER_TOKEN. This client
// used to treat 401 like any other failure and give up. It now falls back to an
// app-only bearer derived in memory from the OAuth1 consumer key/secret
// (lib/research/xAppBearer.js) and reports that in `auth` so the degraded
// credential path is visible in the evidence event and logs.
async function requestSearch({ token, query, maxResults, fetchImpl }) {
  const url = new URL(X_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', String(maxResults));
  url.searchParams.set('tweet.fields', 'text,author_id,reply_settings,public_metrics');
  return fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
}

export async function searchRecentTweets({
  bearerToken,
  query,
  maxResults = 10,
  fetchImpl = fetch,
  consumerKey,
  consumerSecret,
  appTokenUrl
} = {}) {
  const canDerive = Boolean(consumerKey && consumerSecret);
  if (!bearerToken && !canDerive) {
    return unavailableResult(query, 'X search bearer token is not configured');
  }
  if (typeof query !== 'string' || query.trim() === '') {
    return unavailableResult(query, 'search query is empty');
  }

  let auth = { mode: 'configured-bearer', degraded: false };
  let token = bearerToken;
  const derive = async (note, forceRefresh = false) => {
    const derived = await deriveAppBearer({ consumerKey, consumerSecret, fetchImpl, tokenUrl: appTokenUrl, forceRefresh });
    if (!derived.ok) return { error: derived.reason };
    token = derived.token;
    auth = { mode: 'derived-app-bearer', degraded: true, note };
    return {};
  };

  if (!token) {
    const outcome = await derive('X_SEARCH_BEARER_TOKEN missing; used app-only bearer derived from OAuth1 consumer credentials');
    if (outcome.error) return unavailableResult(query, outcome.error);
  }

  const attempt = async () => {
    try {
      return { response: await requestSearch({ token, query, maxResults, fetchImpl }) };
    } catch (error) {
      return { error: `X search unreachable: ${error.message}` };
    }
  };

  let { response, error } = await attempt();
  if (error) return unavailableResult(query, error);

  if (response.status === 401 && canDerive && auth.mode !== 'derived-app-bearer') {
    const outcome = await derive('configured X_SEARCH_BEARER_TOKEN was rejected (HTTP 401); fell back to app-only bearer derived from OAuth1 consumer credentials');
    if (outcome.error) {
      return unavailableResult(query, `X search returned HTTP 401 and the fallback failed: ${outcome.error}`);
    }
    ({ response, error } = await attempt());
    if (error) return unavailableResult(query, error);
  }
  if (response.status === 401 && auth.mode === 'derived-app-bearer' && canDerive) {
    // A cached derived token may have been revoked; mint one fresh token once.
    const outcome = await derive(auth.note, true);
    if (!outcome.error) {
      ({ response, error } = await attempt());
      if (error) return unavailableResult(query, error);
    }
  }

  if (response.status === 401) {
    return unavailableResult(query, 'X search returned HTTP 401 (bearer token rejected: invalid, expired, or an OAuth2 user token instead of an app-only bearer)');
  }
  if (response.status === 403) {
    return unavailableResult(query, 'X search requires a higher API tier (HTTP 403)');
  }
  if (response.status === 429) {
    return unavailableResult(query, 'X search rate-limited (HTTP 429)');
  }
  if (!response.ok) {
    return unavailableResult(query, `X search returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (parseError) {
    return unavailableResult(query, `X search returned invalid JSON: ${parseError.message}`);
  }

  const tweets = Array.isArray(body?.data) ? body.data : [];
  return {
    status: 'ok',
    provider: 'x-search',
    query,
    tweets,
    auth,
    summary: `${tweets.length} tweet(s)${auth.degraded ? ' [degraded auth: ' + auth.mode + ']' : ''}`
  };
}

export { X_SEARCH_URL };
