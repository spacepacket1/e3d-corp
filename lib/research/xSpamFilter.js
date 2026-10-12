// Pre-filter for X search candidates, ported from e3d-maps' proven bot
// (/Users/mini/e3d/agents/scripts/x-heartbeat.js) rather than reinvented:
// same spam-keyword pattern, same >2-link heuristic, same reply_settings
// check. Pure and synchronous - no network, no LLM call - so it runs before
// the (paid/rate-limited) Jev relevance check and reply drafting, cutting
// obvious junk out cheaply first.

const SPAM_PATTERN = /follow\s+back|airdrop|giveaway|\bmint\b|free\s+token|whitelist|presale|100x|promo/i;
const MAX_LINKS = 2;

export function isLikelySpam(tweet) {
  const text = tweet?.text ?? '';
  if (tweet?.reply_settings && tweet.reply_settings !== 'everyone') {
    return { spam: true, reason: 'reply_settings is not "everyone"' };
  }
  if (SPAM_PATTERN.test(text)) {
    return { spam: true, reason: 'matched spam keyword pattern' };
  }
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  if (linkCount > MAX_LINKS) {
    return { spam: true, reason: `${linkCount} links exceeds max of ${MAX_LINKS}` };
  }
  return { spam: false };
}

export { SPAM_PATTERN, MAX_LINKS };
