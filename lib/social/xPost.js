// Real X API v2 posting transport. Only ever called from the registered
// `x-post` executor (lib/actions/socialPost.js) AFTER assertProposalAuthorized.
// Credentials (names only here; values come from the environment / token file):
//   OAuth2 user token: X_TOKEN_FILE (json: access_token, refresh_token, expires_at, client_id) or X_ACCESS_TOKEN,
//     refreshed with X_CLIENT_ID / X_CLIENT_SECRET (refresh tokens rotate, so the file is rewritten atomically).
//   OAuth1 fallback:   X_OAUTH1_CONSUMER_KEY/SECRET + X_OAUTH1_ACCESS_TOKEN/SECRET.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { oauth1Header } from './oauth1.js';

export const X_TWEETS_URL = 'https://api.twitter.com/2/tweets';
export const X_OAUTH2_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
export const X_MEDIA_UPLOAD_URL = 'https://api.twitter.com/2/media/upload';
export const X_MEDIA_UPLOAD_V1_URL = 'https://upload.twitter.com/1.1/media/upload.json';

const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function readTokenFile(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeTokenFile(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function refreshOAuth2({ env, fetchImpl, tokenFile, tokenData, now }) {
  if (!tokenData?.refresh_token) return { ok: false, reason: 'no refresh_token available' };
  const clientId = env.X_CLIENT_ID ?? tokenData.client_id;
  if (!clientId) return { ok: false, reason: 'X_CLIENT_ID is not set' };
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${env.X_CLIENT_SECRET}`).toString('base64')}`;
  }
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenData.refresh_token, client_id: clientId });
  const response = await fetchImpl(X_OAUTH2_TOKEN_URL, { method: 'POST', headers, body: body.toString() });
  if (!response.ok) return { ok: false, reason: `refresh returned HTTP ${response.status}` };
  const json = await response.json();
  if (!json?.access_token) return { ok: false, reason: 'refresh response had no access_token' };
  const next = {
    ...tokenData,
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? tokenData.refresh_token,
    expires_in: json.expires_in ?? tokenData.expires_in,
    expires_at: json.expires_in ? now() + json.expires_in * 1000 : tokenData.expires_at,
    scope: json.scope ?? tokenData.scope,
    token_type: json.token_type ?? tokenData.token_type
  };
  if (tokenFile) writeTokenFile(tokenFile, next);
  return { ok: true, accessToken: next.access_token };
}

async function uploadMediaOAuth2({ token, mediaPath, fetchImpl }) {
  const ext = path.extname(mediaPath).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(`Unsupported media type "${ext}" (images only; the owner posts video natively)`);
  const form = new FormData();
  form.append('media', new Blob([fs.readFileSync(mediaPath)], { type }), path.basename(mediaPath));
  form.append('media_category', 'tweet_image');
  const response = await fetchImpl(X_MEDIA_UPLOAD_URL, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  if (!response.ok) throw new Error(`X media upload returned HTTP ${response.status}`);
  const json = await response.json();
  const id = json?.data?.id ?? json?.media_id_string;
  if (!id) throw new Error('X media upload returned no media id');
  return String(id);
}

async function uploadMediaOAuth1({ creds, mediaPath, fetchImpl }) {
  const ext = path.extname(mediaPath).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(`Unsupported media type "${ext}" (images only; the owner posts video natively)`);
  const form = new FormData();
  form.append('media', new Blob([fs.readFileSync(mediaPath)], { type }), path.basename(mediaPath));
  const authorization = oauth1Header({ method: 'POST', url: X_MEDIA_UPLOAD_V1_URL, ...creds });
  const response = await fetchImpl(X_MEDIA_UPLOAD_V1_URL, { method: 'POST', headers: { authorization }, body: form });
  if (!response.ok) throw new Error(`X media upload (OAuth1) returned HTTP ${response.status}`);
  const json = await response.json();
  if (!json?.media_id_string) throw new Error('X media upload (OAuth1) returned no media id');
  return json.media_id_string;
}

function tweetBody({ text, replyToTweetId, mediaId }) {
  const body = { text };
  if (replyToTweetId) body.reply = { in_reply_to_tweet_id: String(replyToTweetId) };
  if (mediaId) body.media = { media_ids: [mediaId] };
  return body;
}

function resultFrom(json) {
  const id = json?.data?.id;
  if (!id) throw new Error('X API did not return a tweet id');
  return { postId: String(id), url: `https://x.com/i/web/status/${id}` };
}

// Returns { postId, url, auth: 'oauth2-user' | 'oauth1' }.
export async function postToX({ text, replyToTweetId = null, mediaPath = null }, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const tokenFile = env.X_TOKEN_FILE || null;
  let tokenData = readTokenFile(tokenFile);
  let accessToken = tokenData?.access_token || env.X_ACCESS_TOKEN || null;
  const failures = [];

  const oauth2Post = async (token) => {
    const mediaId = mediaPath ? await uploadMediaOAuth2({ token, mediaPath, fetchImpl }) : null;
    return fetchImpl(X_TWEETS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(tweetBody({ text, replyToTweetId, mediaId }))
    });
  };

  if (accessToken) {
    try {
      const expired = tokenData?.expires_at && Number(tokenData.expires_at) <= now() + 30_000;
      if (expired) {
        const refreshed = await refreshOAuth2({ env, fetchImpl, tokenFile, tokenData, now });
        if (refreshed.ok) accessToken = refreshed.accessToken;
        else failures.push(`oauth2 pre-refresh: ${refreshed.reason}`);
      }
      let response = await oauth2Post(accessToken);
      if (response.status === 401 && tokenData) {
        tokenData = readTokenFile(tokenFile) ?? tokenData;
        const refreshed = await refreshOAuth2({ env, fetchImpl, tokenFile, tokenData, now });
        if (refreshed.ok) response = await oauth2Post(refreshed.accessToken);
        else failures.push(`oauth2 refresh: ${refreshed.reason}`);
      }
      if (response.ok) return { ...resultFrom(await response.json()), auth: 'oauth2-user' };
      failures.push(`oauth2 post returned HTTP ${response.status}`);
    } catch (error) {
      failures.push(`oauth2: ${error.message}`);
    }
  } else {
    failures.push('no OAuth2 user token (X_TOKEN_FILE / X_ACCESS_TOKEN)');
  }

  const creds = {
    consumerKey: env.X_OAUTH1_CONSUMER_KEY,
    consumerSecret: env.X_OAUTH1_CONSUMER_SECRET,
    token: env.X_OAUTH1_ACCESS_TOKEN,
    tokenSecret: env.X_OAUTH1_ACCESS_TOKEN_SECRET
  };
  if (creds.consumerKey && creds.consumerSecret && creds.token && creds.tokenSecret) {
    const mediaId = mediaPath ? await uploadMediaOAuth1({ creds, mediaPath, fetchImpl }) : null;
    const response = await fetchImpl(X_TWEETS_URL, {
      method: 'POST',
      headers: { authorization: oauth1Header({ method: 'POST', url: X_TWEETS_URL, ...creds }), 'content-type': 'application/json' },
      body: JSON.stringify(tweetBody({ text, replyToTweetId, mediaId }))
    });
    if (response.ok) return { ...resultFrom(await response.json()), auth: 'oauth1' };
    failures.push(`oauth1 post returned HTTP ${response.status}`);
  } else {
    failures.push('no complete OAuth1 credentials');
  }
  throw new Error(`X post failed (${failures.join('; ')})`);
}
