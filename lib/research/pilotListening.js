// Read-only market listening for the Pilot marketing/sales brief: Hacker News, GitHub and YouTube.
// Each source is isolated (one failing never hides the others), nothing is written outside the event log, and only
// items not seen before become `pilot.listening.item` events, so the brief can show what is NEW.
import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { readApiKeyFile } from './youtubeAuth.js';

export const LISTENING_EVENT_TYPE = 'pilot.listening.item';
const DAY_MS = 86_400_000;

export const DEFAULT_QUERIES = Object.freeze({
  hackernews: ['llm council', 'multi-model LLM debate', 'compare answers from several AI models', 'MCP server second opinion LLM'],
  github: ['llm council', 'multi model LLM debate', 'multi-LLM consensus disagreement'],
  youtube: ['LLM council multiple AI models', 'compare ChatGPT Claude Gemini answers', 'AI models debate each other']
});

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const json = async (res, label) => { if (!res.ok) throw new Error(`${label} HTTP ${res.status}`); return res.json(); };
const opts = () => ({ signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'futco-pilot-listening/1.0', accept: 'application/json' } });

export async function searchHackerNews({ queries, sinceMs, fetchImpl = globalThis.fetch }) {
  const out = [];
  for (const q of queries) {
    const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
    url.searchParams.set('query', q);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('numericFilters', `created_at_i>${Math.floor(sinceMs / 1000)}`);
    url.searchParams.set('hitsPerPage', '20');
    const body = await json(await fetchImpl(url, opts()), 'hackernews');
    for (const h of body.hits ?? []) {
      out.push({ source: 'hackernews', id: String(h.objectID), title: clip(h.title, 160), url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        link: h.url ?? null, score: h.points ?? 0, comments: h.num_comments ?? 0, createdAt: h.created_at, query: q });
    }
  }
  return out;
}

export async function searchGithub({ queries, sinceMs, fetchImpl = globalThis.fetch, token = null }) {
  const out = [];
  const since = new Date(sinceMs).toISOString().slice(0, 10);
  for (const q of queries) {
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', `${q} created:>${since}`);
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('per_page', '10');
    const o = opts(); if (token) o.headers.authorization = `Bearer ${token}`;
    const body = await json(await fetchImpl(url, o), 'github');
    for (const r of body.items ?? []) {
      out.push({ source: 'github', id: r.full_name, title: r.full_name, description: clip(r.description, 200), url: r.html_url,
        score: r.stargazers_count ?? 0, createdAt: r.created_at, query: q });
    }
  }
  return out;
}

export async function searchYoutube({ queries, sinceMs, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('youtube: no API key configured');
  const out = [];
  for (const q of queries) {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    for (const [k, v] of Object.entries({ part: 'snippet', type: 'video', order: 'date', maxResults: '10', q, key: apiKey, publishedAfter: new Date(sinceMs).toISOString() })) url.searchParams.set(k, v);
    const body = await json(await fetchImpl(url, opts()), 'youtube');
    for (const i of body.items ?? []) {
      out.push({ source: 'youtube', id: i.id?.videoId, title: clip(i.snippet?.title, 160), channel: clip(i.snippet?.channelTitle, 80),
        url: `https://www.youtube.com/watch?v=${i.id?.videoId}`, score: 0, createdAt: i.snippet?.publishedAt, query: q });
    }
  }
  return out.filter((x) => x.id);
}

function resolveSettings(instanceConfig, env) {
  const c = instanceConfig?.research?.pilotListening ?? {};
  const keyFile = instanceConfig?.research?.youtube?.apiKeyFile;
  let apiKey = env[instanceConfig?.research?.youtube?.apiKeyEnvVar ?? 'YOUTUBE_API_KEY'] || null;
  if (!apiKey && keyFile) { try { apiKey = readApiKeyFile(keyFile); } catch { apiKey = null; } }
  return {
    lookbackDays: c.lookbackDays ?? 7,
    queries: { ...DEFAULT_QUERIES, ...(c.queries ?? {}) },
    githubToken: env.GITHUB_TOKEN || null,
    apiKey,
    disabled: new Set(c.disabledSources ?? [])
  };
}

// Searches every enabled source, records items not seen before, returns { added, errors }.
export async function collectListening({ instanceConfig, dataDir, now = new Date(), env = process.env, fetchImpl = globalThis.fetch }) {
  const s = resolveSettings(instanceConfig, env);
  const sinceMs = now.getTime() - s.lookbackDays * DAY_MS;
  const seen = new Set(queryEvents(dataDir, { type: LISTENING_EVENT_TYPE }).map((e) => `${e.payload?.source}:${e.payload?.id}`));
  const jobs = [
    ['hackernews', () => searchHackerNews({ queries: s.queries.hackernews, sinceMs, fetchImpl })],
    ['github', () => searchGithub({ queries: s.queries.github, sinceMs, fetchImpl, token: s.githubToken })],
    ['youtube', () => searchYoutube({ queries: s.queries.youtube, sinceMs, apiKey: s.apiKey, fetchImpl })]
  ].filter(([name]) => !s.disabled.has(name));

  const added = [], errors = [];
  for (const [name, run] of jobs) {
    try {
      for (const item of await run()) {
        const key = `${item.source}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        appendEvent(dataDir, { type: LISTENING_EVENT_TYPE, source: `research.${name}`, subject: { type: 'listening-item', id: key },
          payload: item, correlationId: crypto.randomUUID(), occurredAt: now.toISOString() });
        added.push(item);
      }
    } catch (error) {
      errors.push({ source: name, message: error.message });
    }
  }
  return { added, errors };
}

// Items first seen in the last `hours`, best first, capped per source. Pure read of the event log.
export function recentListening(dataDir, { now = new Date(), hours = 24, perSource = 4 } = {}) {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const bySource = {};
  for (const e of queryEvents(dataDir, { type: LISTENING_EVENT_TYPE, since })) (bySource[e.payload.source] ??= []).push(e.payload);
  for (const k of Object.keys(bySource)) bySource[k] = bySource[k].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, perSource);
  return bySource;
}
