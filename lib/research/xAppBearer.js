// Derives an app-only (OAuth2 client-credentials) bearer token for X API v2
// read endpoints from the OAuth1 consumer key/secret. Held in memory only:
// never written to disk, never logged. The derived token is a fallback for
// when X_SEARCH_BEARER_TOKEN is missing or rejected (HTTP 401).
import { Buffer } from 'node:buffer';

export const X_APP_TOKEN_URL = 'https://api.twitter.com/oauth2/token';

const cache = new Map();

function cacheKey(consumerKey) {
  return consumerKey;
}

export function clearAppBearerCache() {
  cache.clear();
}

export async function deriveAppBearer({ consumerKey, consumerSecret, fetchImpl = fetch, tokenUrl = X_APP_TOKEN_URL, forceRefresh = false } = {}) {
  if (!consumerKey || !consumerSecret) {
    return { ok: false, reason: 'X OAuth1 consumer key/secret are not configured' };
  }
  const key = cacheKey(consumerKey);
  if (!forceRefresh && cache.has(key)) {
    return { ok: true, token: cache.get(key), cached: true };
  }

  const basic = Buffer.from(`${encodeURIComponent(consumerKey)}:${encodeURIComponent(consumerSecret)}`).toString('base64');
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: 'grant_type=client_credentials'
    });
  } catch (error) {
    return { ok: false, reason: `X app-token endpoint unreachable: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `X app-token endpoint returned HTTP ${response.status}` };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: `X app-token endpoint returned invalid JSON: ${error.message}` };
  }
  if (body?.token_type !== 'bearer' || typeof body?.access_token !== 'string' || body.access_token === '') {
    return { ok: false, reason: 'X app-token endpoint did not return a bearer token' };
  }
  cache.set(key, body.access_token);
  return { ok: true, token: body.access_token, cached: false };
}
