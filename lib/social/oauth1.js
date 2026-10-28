import crypto from 'node:crypto';

function pct(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// OAuth 1.0a HMAC-SHA1 Authorization header. `params` are query/form params that
// take part in the signature (JSON and multipart bodies do not).
export function oauth1Header({ method, url, params = {}, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0'
  };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((key) => `${pct(key)}=${pct(all[key])}`)
    .join('&');
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join('&');
  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret ?? '')}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return `OAuth ${Object.keys(oauth).sort().map((key) => `${pct(key)}="${pct(oauth[key])}"`).join(', ')}`;
}
