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

const DEFAULT_MIN_ENGAGEMENT = 3;

// Neither spam keywords nor the reply_settings/link heuristics catch what a
// human reviewer actually flagged in practice: thin, bot-feeling posts that
// nobody has engaged with. X's search API returns public_metrics for free
// (tweet.fields=public_metrics in xSearchClient.js), so this is a second
// cheap, pre-LLM filter requiring some real sign of life - likes, retweets,
// replies, or quotes - before a post is worth spending a Jev call and an LLM
// draft on at all.
export function hasEnoughEngagement(tweet, minEngagement = DEFAULT_MIN_ENGAGEMENT) {
  const metrics = tweet?.public_metrics;
  if (!metrics) {
    return { enough: false, reason: 'no public_metrics on this tweet' };
  }
  const total =
    (metrics.like_count ?? 0) + (metrics.retweet_count ?? 0) + (metrics.reply_count ?? 0) + (metrics.quote_count ?? 0);
  if (total < minEngagement) {
    return { enough: false, reason: `engagement ${total} is below the minimum of ${minEngagement}` };
  }
  return { enough: true, total };
}

export { SPAM_PATTERN, MAX_LINKS, DEFAULT_MIN_ENGAGEMENT };
