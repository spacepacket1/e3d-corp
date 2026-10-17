import fs from 'node:fs';
import { YoutubeApiError } from './youtubeApi.js';

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EXPIRY_SKEW_MS = 60_000;

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new YoutubeApiError(`Cannot read ${label} (${file}): ${error.message}`, { kind: 'auth' });
  }
}

// An API key read from a file must be private: refuse group/world-readable files rather than quietly using them.
export function readApiKeyFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    throw new YoutubeApiError(`Cannot read the YouTube API key file (${file}): ${error.message}`, { kind: 'auth' });
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new YoutubeApiError(`YouTube API key file ${file} is readable by other users; run: chmod 600 ${file}`, { kind: 'auth' });
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key) throw new YoutubeApiError(`YouTube API key file ${file} is empty`, { kind: 'auth' });
  return key;
}

// Optional OAuth fallback (only needed to WRITE to the channel, or for APIs a plain key cannot call).
// Reads a token file ({ access_token, expiry_date, refresh_token }) and a Google client-secret file, and refreshes
// the access token in memory. It never writes those files, and it never logs a token.
//
// NOTE: while the Google OAuth app is in "Testing" mode, refresh tokens expire after 7 days (invalid_grant).
// That is why monitoring uses an API key and OAuth is only for the rare approved write.
export function createOAuthTokenProvider({ tokenFile, clientSecretFile, tokenUrl = DEFAULT_TOKEN_URL, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cached = null;

  return async function getAccessToken() {
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) return cached.token;

    const tokens = readJson(tokenFile, 'the OAuth token file');
    if (tokens.access_token && Number(tokens.expiry_date) - EXPIRY_SKEW_MS > now()) {
      cached = { token: tokens.access_token, expiresAt: Number(tokens.expiry_date) };
      return cached.token;
    }
    if (!tokens.refresh_token) {
      throw new YoutubeApiError('The OAuth token file has no refresh_token; re-authorize the app', { kind: 'auth' });
    }
    const secrets = readJson(clientSecretFile, 'the OAuth client-secret file');
    const client = secrets.installed ?? secrets.web;
    if (!client?.client_id || !client?.client_secret) {
      throw new YoutubeApiError('The OAuth client-secret file has no client_id/client_secret', { kind: 'auth' });
    }

    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: tokens.refresh_token,
          grant_type: 'refresh_token'
        }).toString(),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new YoutubeApiError(`OAuth token refresh network error: ${error.message}`, { kind: 'network' });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const detail = body.error === 'invalid_grant'
        ? 'the refresh token was rejected (invalid_grant). If the OAuth app is in Testing mode, refresh tokens expire every 7 days: re-authorize the channel owner'
        : (body.error_description ?? body.error ?? `HTTP ${response.status}`);
      throw new YoutubeApiError(`OAuth token refresh failed: ${detail}`, { kind: 'auth', status: response.status, reason: body.error ?? null });
    }
    cached = { token: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    return cached.token;
  };
}
