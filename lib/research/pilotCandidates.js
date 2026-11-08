// People worth inviting to try E3D Pilot: AI builders with an audience, found from public data only.
// This is NOT a sales-lead list. The ask is "try it, and post about it if you like it", so the brief shows who they are,
// how big their audience is, and a recent public post that shows they talk about this topic. Nothing is sent to anyone.
//
// Rules baked in on purpose:
//  - Public profile data only (handle, display name, bio, public follower count, a recent public post or video).
//  - No age, gender or other personal inference: candidates are ranked by audience size and topical fit, nothing else.
//  - Read-only. Each source is isolated (one failing never hides the others). New people become
//    `pilot.candidate.found` events, so the brief shows who is NEW and never repeats someone already surfaced.
//  - Sources with no usable public search API (LinkedIn, TikTok, Instagram; Reddit blocks automated reads) are not scraped.
import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { readApiKeyFile } from './youtubeAuth.js';
import { searchRecentTweets } from './xSearchClient.js';

export const CANDIDATE_EVENT_TYPE = 'pilot.candidate.found';
const DAY_MS = 86_400_000;

export const DEFAULT_CANDIDATE_QUERIES = Object.freeze({
  x: ['(MCP OR "Claude Code" OR Cursor) (agent OR agents) -is:retweet -is:reply lang:en',
      '("building with" OR "I built") (AI OR LLM) agent -is:retweet -is:reply lang:en',
      '(podcast OR NotebookLM) (AI OR video) -is:retweet -is:reply lang:en',
      '(Obsidian OR "second brain") (AI OR Claude OR MCP) -is:retweet -is:reply lang:en'],
  youtube: ['Claude Code tutorial', 'MCP server AI agents', 'building AI agents Cursor', 'AI podcast to video', 'Obsidian AI second brain'],
  bluesky: ['AI agents', 'Claude Code', 'MCP server', 'podcasting AI', 'Obsidian second brain'],
  github: ['mcp server', 'ai agent framework', 'podcast video ai', 'obsidian mcp memory'],
  hackernews: ['Show HN AI agent', 'Show HN MCP', 'Show HN LLM', 'Show HN podcast AI', 'Show HN second brain']
});

// Minimum public audience before someone is listed. Per source, because the numbers mean different things.
export const DEFAULT_MIN_REACH = Object.freeze({ x: 5000, youtube: 5000, bluesky: 1000, github: 500, hackernews: 1000 });
// Upper bound too: a 13M-subscriber brand will not answer a "please try this" note, and the goal is builders with an
// audience who might. Both ends are configurable (research.pilotCandidates.minReach / maxReach).
export const DEFAULT_MAX_REACH = Object.freeze({ x: 500_000, youtube: 1_000_000, bluesky: 100_000, github: 50_000, hackernews: 100_000 });
export const REACH_LABEL = Object.freeze({ x: 'followers', youtube: 'subscribers', bluesky: 'followers', github: 'followers', hackernews: 'karma' });

// The person must visibly talk about AI (bio, or the post or video that surfaced them), whatever tool they end up matched to:
// a podcaster or note-taker with no AI angle is not who we are looking for.
const TOPIC_RE = /\b(ai|a\.i\.|llms?|claude|gpt|chatgpt|agents?|agentic|mcp|cursor|copilot|gemini|openai|anthropic|prompts?|rag|machine learning)\b/i;
const SPAMMY_BIO = /\b(giveaway|airdrop|signals?|dm (me|for)|promo ?code|get rich|100x|nft)\b/i;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const clip = (s, n) => { const t = String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const jsonOrThrow = async (res, label) => { if (!res.ok) throw new Error(`${label} HTTP ${res.status}`); return res.json(); };
const opts = () => ({ signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'futco-pilot-candidates/1.0', accept: 'application/json' } });
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---------- sources: each returns [{ source, id, handle, name, url, reach, bio, evidence: { title, url, engagement } }] ----------

export async function findOnX({ queries, env, fetchImpl = globalThis.fetch }) {
  const out = [];
  for (const query of queries) {
    const r = await searchRecentTweets({
      bearerToken: env.X_SEARCH_BEARER_TOKEN, consumerKey: env.X_OAUTH1_CONSUMER_KEY, consumerSecret: env.X_OAUTH1_CONSUMER_SECRET,
      query, maxResults: 50, fetchImpl,
      extraParams: { expansions: 'author_id', 'user.fields': 'username,name,description,public_metrics,verified' }
    });
    if (r.status !== 'ok') throw new Error(r.reason || 'X search unavailable');
    const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u]));
    for (const t of r.tweets) {
      const u = users.get(t.author_id);
      if (!u) continue;
      const m = t.public_metrics ?? {};
      out.push({ source: 'x', id: u.id, handle: `@${u.username}`, name: clip(u.name, 80), url: `https://x.com/${u.username}`,
        reach: num(u.public_metrics?.followers_count), bio: clip(u.description, 200),
        evidence: { title: clip(t.text, 200), url: `https://x.com/${u.username}/status/${t.id}`, engagement: (m.like_count ?? 0) + (m.retweet_count ?? 0) + (m.reply_count ?? 0) } });
    }
  }
  return out;
}

export async function findOnYoutube({ queries, sinceMs, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('youtube: no API key configured');
  const byChannel = new Map();
  for (const q of queries) {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    for (const [k, v] of Object.entries({ part: 'snippet', type: 'video', order: 'viewCount', maxResults: '25', q, key: apiKey, publishedAfter: new Date(sinceMs).toISOString() })) url.searchParams.set(k, v);
    const body = await jsonOrThrow(await fetchImpl(url, opts()), 'youtube');
    for (const i of body.items ?? []) {
      const id = i.snippet?.channelId;
      if (id && !byChannel.has(id)) byChannel.set(id, { videoId: i.id?.videoId, title: i.snippet?.title });
    }
  }
  const out = [];
  for (const ids of chunk([...byChannel.keys()], 50)) {
    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    for (const [k, v] of Object.entries({ part: 'snippet,statistics', id: ids.join(','), key: apiKey })) url.searchParams.set(k, v);
    const body = await jsonOrThrow(await fetchImpl(url, opts()), 'youtube channels');
    for (const c of body.items ?? []) {
      const v = byChannel.get(c.id);
      out.push({ source: 'youtube', id: c.id, handle: c.snippet?.customUrl ? String(c.snippet.customUrl) : c.snippet?.title, name: clip(c.snippet?.title, 80),
        url: `https://www.youtube.com/channel/${c.id}`, reach: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount),
        bio: clip(c.snippet?.description, 200), evidence: { title: clip(v?.title, 200), url: v?.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : null, engagement: 0 } });
    }
  }
  return out;
}

export async function findOnBluesky({ queries, fetchImpl = globalThis.fetch }) {
  const base = 'https://public.api.bsky.app/xrpc';
  const handles = new Set();
  for (const q of queries) {
    const url = new URL(`${base}/app.bsky.actor.searchActors`);
    url.searchParams.set('q', q); url.searchParams.set('limit', '25');
    const body = await jsonOrThrow(await fetchImpl(url, opts()), 'bluesky');
    for (const a of body.actors ?? []) handles.add(a.did);
  }
  const out = [];
  for (const dids of chunk([...handles], 25)) {
    const url = new URL(`${base}/app.bsky.actor.getProfiles`);
    for (const d of dids) url.searchParams.append('actors', d);
    const body = await jsonOrThrow(await fetchImpl(url, opts()), 'bluesky profiles');
    for (const p of body.profiles ?? []) {
      out.push({ source: 'bluesky', id: p.did, handle: `@${p.handle}`, name: clip(p.displayName || p.handle, 80), url: `https://bsky.app/profile/${p.handle}`,
        reach: num(p.followersCount), bio: clip(p.description, 200), evidence: { title: clip(p.description, 200), url: `https://bsky.app/profile/${p.handle}`, engagement: 0 } });
    }
  }
  return out;
}

export async function findOnGithub({ queries, sinceMs, token = null, fetchImpl = globalThis.fetch }) {
  const since = new Date(sinceMs).toISOString().slice(0, 10);
  const headers = () => { const o = opts(); if (token) o.headers.authorization = `Bearer ${token}`; return o; };
  const owners = new Map();
  for (const q of queries) {
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', `${q} pushed:>${since}`); url.searchParams.set('sort', 'stars'); url.searchParams.set('per_page', '15');
    const body = await jsonOrThrow(await fetchImpl(url, headers()), 'github');
    for (const r of body.items ?? []) {
      if (r.owner?.type !== 'User' || owners.has(r.owner.login)) continue;
      owners.set(r.owner.login, { repo: r.full_name, url: r.html_url, description: r.description, stars: r.stargazers_count ?? 0 });
    }
  }
  const out = [];
  for (const [login, repo] of [...owners].slice(0, 30)) {
    const u = await jsonOrThrow(await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, headers()), 'github user');
    out.push({ source: 'github', id: login, handle: login, name: clip(u.name || login, 80), url: u.html_url, reach: num(u.followers), bio: clip(u.bio, 200),
      evidence: { title: clip(`${repo.repo}: ${repo.description ?? ''}`, 200), url: repo.url, engagement: repo.stars } });
  }
  return out;
}

export async function findOnHackerNews({ queries, sinceMs, fetchImpl = globalThis.fetch }) {
  const authors = new Map();
  for (const q of queries) {
    const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
    url.searchParams.set('query', q); url.searchParams.set('tags', 'story'); url.searchParams.set('hitsPerPage', '30');
    url.searchParams.set('numericFilters', `created_at_i>${Math.floor(sinceMs / 1000)},points>5`);
    const body = await jsonOrThrow(await fetchImpl(url, opts()), 'hackernews');
    for (const h of body.hits ?? []) if (h.author && !authors.has(h.author)) authors.set(h.author, h);
  }
  const out = [];
  for (const [name, h] of [...authors].slice(0, 30)) {
    const u = await jsonOrThrow(await fetchImpl(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(name)}.json`, opts()), 'hackernews user');
    if (!u) continue;
    out.push({ source: 'hackernews', id: name, handle: name, name, url: `https://news.ycombinator.com/user?id=${encodeURIComponent(name)}`, reach: num(u.karma),
      bio: clip(String(u.about ?? '').replace(/<[^>]+>/g, ' '), 200), evidence: { title: clip(h.title, 200), url: `https://news.ycombinator.com/item?id=${h.objectID}`, engagement: h.points ?? 0 } });
  }
  return out;
}

// ---------- ranking ----------

// Deterministic: audience size on a log scale plus a little for how well the evidence post did. Nothing demographic.
export function scoreCandidate(c) {
  return Math.round((Math.log10(1 + (c.reach ?? 0)) + 0.5 * Math.log10(1 + (c.evidence?.engagement ?? 0))) * 100) / 100;
}

export function eligible(c, { minReach, maxReach = DEFAULT_MAX_REACH, exclude }) {
  if (!c || !c.id || c.reach == null) return false;
  if (c.reach < (minReach[c.source] ?? 0) || c.reach > (maxReach[c.source] ?? Infinity)) return false;
  if (!TOPIC_RE.test(`${c.bio ?? ''} ${c.evidence?.title ?? ''}`)) return false;
  if (SPAMMY_BIO.test(`${c.bio ?? ''} ${c.name ?? ''}`)) return false;
  return !exclude.has(`${c.source}:${String(c.handle).toLowerCase().replace(/^@/, '')}`);
}

// Merge repeats of one person across queries: keep the best evidence.
export function dedupe(list) {
  const best = new Map();
  for (const c of list) {
    const k = `${c.source}:${c.id}`;
    const cur = best.get(k);
    if (!cur || (c.evidence?.engagement ?? 0) > (cur.evidence?.engagement ?? 0)) best.set(k, c);
  }
  return [...best.values()];
}

function resolveSettings(instanceConfig, env) {
  const c = instanceConfig?.research?.pilotCandidates ?? {};
  const yt = instanceConfig?.research?.youtube ?? {};
  let apiKey = env[yt.apiKeyEnvVar ?? 'YOUTUBE_API_KEY'] || null;
  if (!apiKey && yt.apiKeyFile) { try { apiKey = readApiKeyFile(yt.apiKeyFile); } catch { apiKey = null; } }
  return {
    lookbackDays: c.lookbackDays ?? 14,
    queries: { ...DEFAULT_CANDIDATE_QUERIES, ...(c.queries ?? {}) },
    minReach: { ...DEFAULT_MIN_REACH, ...(c.minReach ?? {}) },
    maxReach: { ...DEFAULT_MAX_REACH, ...(c.maxReach ?? {}) },
    // excludeHandles entries look like "x:@e3d_ai" or "github:spacepacket1" (your own and your team's accounts).
    exclude: new Set((c.excludeHandles ?? []).map((h) => String(h).toLowerCase().replace(':@', ':'))),
    perSourceCap: c.perSourceCap ?? 25,
    disabled: new Set(c.disabledSources ?? []),
    githubToken: env.GITHUB_TOKEN || null,
    apiKey
  };
}

// Searches every enabled source, records people not surfaced before, returns { added, errors }.
export async function collectCandidates({ instanceConfig, dataDir, now = new Date(), env = process.env, fetchImpl = globalThis.fetch }) {
  const s = resolveSettings(instanceConfig, env);
  const sinceMs = now.getTime() - s.lookbackDays * DAY_MS;
  const seen = new Set(queryEvents(dataDir, { type: CANDIDATE_EVENT_TYPE }).map((e) => `${e.payload?.source}:${e.payload?.id}`));
  const jobs = [
    ['x', () => findOnX({ queries: s.queries.x, env, fetchImpl })],
    ['youtube', () => findOnYoutube({ queries: s.queries.youtube, sinceMs, apiKey: s.apiKey, fetchImpl })],
    ['bluesky', () => findOnBluesky({ queries: s.queries.bluesky, fetchImpl })],
    ['github', () => findOnGithub({ queries: s.queries.github, sinceMs, token: s.githubToken, fetchImpl })],
    ['hackernews', () => findOnHackerNews({ queries: s.queries.hackernews, sinceMs, fetchImpl })]
  ].filter(([name]) => !s.disabled.has(name));

  const added = [], errors = [];
  for (const [name, run] of jobs) {
    try {
      const ranked = dedupe(await run()).filter((c) => eligible(c, s)).map((c) => ({ ...c, score: scoreCandidate(c) }))
        .sort((a, b) => b.score - a.score).slice(0, s.perSourceCap);
      for (const c of ranked) {
        const key = `${c.source}:${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        appendEvent(dataDir, { type: CANDIDATE_EVENT_TYPE, source: `research.${name}`, subject: { type: 'candidate', id: key },
          payload: c, correlationId: crypto.randomUUID(), occurredAt: now.toISOString() });
        added.push(c);
      }
    } catch (error) {
      errors.push({ source: name, message: error.message });
    }
  }
  return { added, errors };
}

// Candidates first surfaced in the last `hours`, best first, capped overall and per source so one platform cannot crowd the rest.
export function recentCandidates(dataDir, { now = new Date(), hours = 24, total = 8, perSource = 3 } = {}) {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const all = queryEvents(dataDir, { type: CANDIDATE_EVENT_TYPE, since }).map((e) => e.payload).sort((a, b) => b.score - a.score);
  const count = {}, out = [];
  for (const c of all) {
    if ((count[c.source] = (count[c.source] ?? 0) + 1) > perSource) continue;
    out.push(c);
    if (out.length >= total) break;
  }
  return out;
}
