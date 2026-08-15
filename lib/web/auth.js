import crypto from 'node:crypto';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Reads the web UI's basic-auth credentials from the env vars named in
// instance config (web.authUserEnvVar/authPassEnvVar). Throws a specific,
// actionable error naming the missing credential rather than starting an
// unauthenticated server - there is no unauthenticated mode, per the spec.
export function loadWebCredentials(config) {
  if (!isPlainObject(config?.web)) {
    throw new Error(
      'Web UI refused to start: instance config has no "web" section (web.authUserEnvVar/authPassEnvVar/port are required)'
    );
  }

  const { authUserEnvVar, authPassEnvVar } = config.web;
  if (typeof authUserEnvVar !== 'string' || authUserEnvVar.trim() === '') {
    throw new Error('Web UI refused to start: instance config is missing "web.authUserEnvVar"');
  }
  if (typeof authPassEnvVar !== 'string' || authPassEnvVar.trim() === '') {
    throw new Error('Web UI refused to start: instance config is missing "web.authPassEnvVar"');
  }

  const user = process.env[authUserEnvVar];
  if (!user) {
    throw new Error(`Web UI refused to start: missing required env var "${authUserEnvVar}" (web.authUserEnvVar)`);
  }
  const pass = process.env[authPassEnvVar];
  if (!pass) {
    throw new Error(`Web UI refused to start: missing required env var "${authPassEnvVar}" (web.authPassEnvVar)`);
  }

  return { user, pass };
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run a timing-safe compare against a same-length buffer so a
    // length mismatch alone doesn't short-circuit as cheaply as a match.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Machine-to-machine intake (e.g. e3d-applied's lead-capture webhook) has no
// browser session to put a basic-auth prompt or CSRF cookie in front of, so
// it authenticates with a single bearer token instead - same
// "instance config names the env var" convention as web.authUserEnvVar.
export function loadLeadWebhookToken(config) {
  const tokenEnvVar = config?.leadWebhook?.tokenEnvVar;
  if (typeof tokenEnvVar !== 'string' || tokenEnvVar.trim() === '') {
    return null;
  }
  const token = process.env[tokenEnvVar];
  return typeof token === 'string' && token.trim() !== '' ? token : null;
}

export function checkBearerToken(req, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken === '') {
    return false;
  }
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeStringEqual(header.slice('Bearer '.length), expectedToken);
}

export function checkBasicAuth(req, credentials) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) {
    return false;
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }

  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);

  return timingSafeStringEqual(user, credentials.user) && timingSafeStringEqual(pass, credentials.pass);
}
