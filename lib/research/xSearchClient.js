// Read-only X API v2 recent-search client for the draft-and-queue pipeline.
// Deliberately contains no posting or OAuth2 user-context code: search only
// needs a static app-auth Bearer token (the same kind every other
// evidence-pull in this file already uses - compare lib/research/oppscanFeed.js,
// lib/research/metaInsights.js), so there is nothing here capable of taking
// a real-world action. Degrades gracefully (status: 'unavailable') on any
// error instead of throwing, same convention as the other research adapters,
// since X's search tier/pricing is unconfirmed and this must not crash a
// cron run if the account isn't entitled to it.

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

export async function searchRecentTweets({ bearerToken, query, maxResults = 10, fetchImpl = fetch } = {}) {
  if (!bearerToken) {
    return unavailableResult(query, 'X search bearer token is not configured');
  }
  if (typeof query !== 'string' || query.trim() === '') {
    return unavailableResult(query, 'search query is empty');
  }

  const url = new URL(X_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', String(maxResults));
  url.searchParams.set('tweet.fields', 'text,author_id,reply_settings,public_metrics');

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${bearerToken}` }
    });
  } catch (error) {
    return unavailableResult(query, `X search unreachable: ${error.message}`);
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
  } catch (error) {
    return unavailableResult(query, `X search returned invalid JSON: ${error.message}`);
  }

  const tweets = Array.isArray(body?.data) ? body.data : [];
  return {
    status: 'ok',
    provider: 'x-search',
    query,
    tweets,
    summary: `${tweets.length} tweet(s)`
  };
}

export { X_SEARCH_URL };
