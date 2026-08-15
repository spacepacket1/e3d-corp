import crypto from 'node:crypto';
import fs from 'node:fs';

// Minimal service-account OAuth2 (RFC 7523 JWT bearer grant), hand-rolled
// against Google's REST token endpoint rather than pulling in the full
// `googleapis` client - matches every other adapter in this codebase
// (webSearch.js, localClient.js) using raw fetch instead of a provider SDK.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export function loadServiceAccountCredentials(keyFilePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read Google service account key at ${keyFilePath}: ${error.message}`);
  }
  if (!raw.client_email || !raw.private_key) {
    throw new Error(`Service account key at ${keyFilePath} is missing client_email/private_key`);
  }
  return { clientEmail: raw.client_email, privateKey: raw.private_key };
}

function signJwt({ clientEmail, privateKey, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
    JSON.stringify(claim)
  ).toString('base64url')}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
  return `${unsigned}.${signature.toString('base64url')}`;
}

export async function getServiceAccountAccessToken({ clientEmail, privateKey, scope = CALENDAR_READONLY_SCOPE }) {
  const assertion = signJwt({ clientEmail, privateKey, scope });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth token exchange failed: HTTP ${response.status} ${text}`);
  }

  const body = await response.json();
  if (!body.access_token) {
    throw new Error('Google OAuth token exchange did not return an access_token');
  }
  return body.access_token;
}
