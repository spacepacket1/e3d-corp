// Daily sales signals for the Pilot brief, from public data only and read-only:
//   buyers   - teams likely to need a second opinion: just funded AI teams, teams hiring for AI roles, people asking out loud
//              which model to use or how to check one
//   triggers - news a salesperson can open a conversation with today (outage, incident, model launch, deprecation, rules)
// Each item is recorded once as a `pilot.signal.found` event, so the brief only ever shows what is NEW since the last run.
// Nothing here infers anything about a person; funding and hiring items are about companies, and every item links to its source.
import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';

export const SIGNAL_EVENT_TYPE = 'pilot.signal.found';
const DAY_MS = 86_400_000;

const AI_RE = /\b(ai|a\.i\.|llms?|gpt|chatgpt|claude|anthropic|openai|gemini|agents?|agentic|mcp|machine learning|generative)\b/i;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&#x2F;': '/' };
const clip = (s, n) => {
  const t = String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39|#x27|#x2F);/g, (m) => ENTITIES[m]).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const opts = () => ({ signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'futco-pilot-signals/1.0', accept: '*/*' } });
const get = async (fetchImpl, url, label, init = opts()) => { const r = await fetchImpl(url, init); if (!r.ok) throw new Error(`${label} HTTP ${r.status}`); return r; };

// What a salesperson can truthfully say for each kind of news. Only claims the product site already makes
// (quote before a run, disagreement kept, a saved transcript); no numbers and no promises.
export const ANGLES = Object.freeze({
  outage: 'A model outage or regression is a live reason to want a second model checking the answer. Pilot asks several models independently and keeps the disagreement.',
  incident: 'An AI action nobody could take back. Pilot is for the decision before it is irreversible: several models answer independently, the dissent is kept, and you quote the cost first.',
  launch: 'A new model is out. Run a real question through Pilot and compare it with the others side by side; the transcript is saved so the result can be shared.',
  deprecation: 'Teams have to re-pick a model. Compare the candidates on their own question before switching, and keep the transcript as the record of why.',
  rules: 'Rules are tightening. Every Pilot debate saves a transcript, so a team can show later how a decision was reached.'
});

// category -> Google News search (last day only)
export const DEFAULT_SIGNAL_QUERIES = Object.freeze({
  funded: ['AI startup raises seed OR "Series A" agents OR LLM', 'AI agents startup raises funding'],
  triggers: {
    outage: ['OpenAI OR Anthropic OR Gemini OR Claude outage OR regression OR degraded'],
    incident: ['"AI agent" deleted OR wiped OR "went rogue" OR "wrong decision" production'],
    launch: ['new AI model released OR launches Claude OR GPT OR Gemini OR Grok OR Llama'],
    deprecation: ['AI model deprecated OR retired OR "end of life" API'],
    rules: ['"AI Act" OR "AI regulation" OR "AI governance" deadline OR enforcement']
  },
  hiringTerms: /\b(llms?|ai agents?|agentic|ml engineer|ai engineer|applied ai|prompt engineer)\b/i,
  asking: ['which LLM should', 'which model should I use', 'how do you evaluate LLM', 'compare LLM outputs', 'second opinion AI']
});

// ---------- RSS ----------

export function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => { const t = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return t ? clip(t[1].replace(/<!\[CDATA\[|\]\]>/g, ''), 400) : ''; };
    const title = pick('title'), url = pick('link');
    const publisher = pick('source');
    const bare = publisher && title.endsWith(` - ${publisher}`) ? title.slice(0, -(publisher.length + 3)) : title;
    if (bare && url) items.push({ title: bare, url, publisher, publishedAt: pick('pubDate') });
  }
  return items;
}

async function newsSearch(fetchImpl, query) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', `${query} when:1d`); url.searchParams.set('hl', 'en-US'); url.searchParams.set('gl', 'US'); url.searchParams.set('ceid', 'US:en');
  return parseRss(await (await get(fetchImpl, url, 'news')).text());
}

const FUNDING_RE = /\b(raises?|raised|funding|seed|series [a-c]|secures?|closes)\b/i;
// "Acme raises $5M to ..." -> "Acme"; falls back to the whole headline.
// "$15 million", "$150M", "$1.2B" -> dollars; null when no amount. Funding of a startup we could sell to is a seed to Series B round,
// not a lab's mega round, so very large amounts are skipped.
export function amountOf(title) {
  const m = String(title).match(/\$\s?(\d+(?:\.\d+)?)\s?(billion|million|bn|b|m)\b/i);
  if (!m) return null;
  return Number(m[1]) * (/^b/i.test(m[2]) ? 1e9 : 1e6);
}
const MAX_FUNDING = 500e6;
const companyOf = (title) => (title.match(/^(.{2,60}?)\s+(raises?|raised|secures?|closes|lands|announces|bags)\b/i)?.[1] ?? '').trim();

export async function findFunded({ queries, fetchImpl }) {
  const out = [];
  for (const q of queries) {
    for (const it of await newsSearch(fetchImpl, q)) {
      const amount = amountOf(it.title);
      if (!FUNDING_RE.test(it.title) || !AI_RE.test(it.title) || amount == null || amount > MAX_FUNDING) continue;
      if (!companyOf(it.title)) continue;
      out.push({ kind: 'funded', id: it.url, title: it.title, url: it.url, who: companyOf(it.title), note: it.publisher });
    }
  }
  return out;
}

const CATEGORY_RE = Object.freeze({
  outage: /\b(outage|down|degraded|regression|incident|disruption)\b/i,
  incident: /\b(delet\w*|wip\w*|rogue|breach\w*|escap\w*|leak\w*|hijack\w*|compromis\w*)\b/i,
  launch: /\b(launch\w*|releas\w*|unveil\w*|introduc\w*|announc\w*)\b/i,
  deprecation: /\b(deprecat\w*|retir\w*|sunset\w*|end of life|shut(s|ting)? down)\b/i,
  rules: /\b(act|regulat\w*|governance|complian\w*|law|rules?|enforce\w*)\b/i
});
const LISTICLE_RE = /\b(how to|vs\.?|versus|best|guide|review|week in|top \d+|\d+ steps|tips)\b/i;

export async function findTriggers({ queries, fetchImpl }) {
  const out = [];
  for (const [category, qs] of Object.entries(queries)) {
    for (const q of qs) {
      for (const it of (await newsSearch(fetchImpl, q)).slice(0, 8)) {
        if (!AI_RE.test(it.title) || LISTICLE_RE.test(it.title) || (CATEGORY_RE[category] && !CATEGORY_RE[category].test(it.title))) continue;
        out.push({ kind: 'trigger', category, id: it.url, title: it.title, url: it.url, note: it.publisher, angle: ANGLES[category] ?? null });
      }
    }
  }
  return out;
}

// ---------- Hacker News ----------

export async function findHiring({ sinceMs, terms, fetchImpl }) {
  const threads = await (await get(fetchImpl, 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=3', 'hackernews')).json();
  const thread = (threads.hits ?? []).find((h) => /who is hiring/i.test(h.title ?? ''));
  if (!thread) return [];
  const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
  url.searchParams.set('tags', `comment,story_${thread.objectID}`); url.searchParams.set('hitsPerPage', '100');
  url.searchParams.set('numericFilters', `created_at_i>${Math.floor(sinceMs / 1000)}`);
  const body = await (await get(fetchImpl, url, 'hackernews')).json();
  const out = [];
  for (const h of body.hits ?? []) {
    const text = clip(h.comment_text, 600);
    if (!terms.test(text)) continue;
    out.push({ kind: 'hiring', id: String(h.objectID), title: clip(text, 170), url: `https://news.ycombinator.com/item?id=${h.objectID}`, who: clip(text.split('|')[0], 60), note: 'HN Who is hiring' });
  }
  return out;
}

export async function findAsking({ queries, sinceMs, fetchImpl }) {
  const out = [];
  for (const q of queries) {
    const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
    url.searchParams.set('query', q); url.searchParams.set('tags', 'story'); url.searchParams.set('hitsPerPage', '15');
    url.searchParams.set('numericFilters', `created_at_i>${Math.floor(sinceMs / 1000)}`);
    const body = await (await get(fetchImpl, url, 'hackernews')).json();
    for (const h of body.hits ?? []) {
      if (!AI_RE.test(h.title ?? '')) continue;
      out.push({ kind: 'asking', id: String(h.objectID), title: clip(h.title, 170), url: `https://news.ycombinator.com/item?id=${h.objectID}`, note: `Hacker News, ${h.num_comments ?? 0} comments` });
    }
  }
  return out;
}

// ---------- collect and read ----------

export async function collectSignals({ instanceConfig, dataDir, now = new Date(), env = process.env, fetchImpl = globalThis.fetch }) {
  const c = instanceConfig?.research?.pilotSignals ?? {};
  const d = DEFAULT_SIGNAL_QUERIES;
  const disabled = new Set(c.disabledSources ?? []);
  const sinceMs = now.getTime() - (c.lookbackDays ?? 2) * DAY_MS;
  const seen = new Set(queryEvents(dataDir, { type: SIGNAL_EVENT_TYPE }).map((e) => e.payload?.id));
  const jobs = [
    ['funded', () => findFunded({ queries: c.fundedQueries ?? d.funded, fetchImpl })],
    ['triggers', () => findTriggers({ queries: { ...d.triggers, ...(c.triggerQueries ?? {}) }, fetchImpl })],
    ['hiring', () => findHiring({ sinceMs, terms: d.hiringTerms, fetchImpl })],
    ['asking', () => findAsking({ queries: c.askingQueries ?? d.asking, sinceMs, fetchImpl })]
  ].filter(([name]) => !disabled.has(name));
  const added = [], errors = [];
  for (const [name, run] of jobs) {
    try {
      for (const it of await run()) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        appendEvent(dataDir, { type: SIGNAL_EVENT_TYPE, source: `research.signals.${name}`, subject: { type: 'signal', id: String(it.id).slice(0, 200) },
          payload: it, correlationId: crypto.randomUUID(), occurredAt: now.toISOString() });
        added.push(it);
      }
    } catch (error) { errors.push({ source: name, message: error.message }); }
  }
  return { added, errors };
}

// New in the last `hours` (default 24), grouped by kind and capped so one kind cannot crowd the rest.
export function recentSignals(dataDir, { now = new Date(), hours = 24, caps = { funded: 5, hiring: 4, asking: 5, trigger: 5 } } = {}) {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const out = { funded: [], hiring: [], asking: [], trigger: [] };
  for (const e of queryEvents(dataDir, { type: SIGNAL_EVENT_TYPE, since })) {
    const p = e.payload;
    if (!p?.kind || !out[p.kind] || out[p.kind].length >= caps[p.kind]) continue;
    // news: at most two per category, so one story type cannot fill the list
    if (p.kind === 'trigger' && out.trigger.filter((x) => x.category === p.category).length >= 2) continue;
    out[p.kind].push(p);
  }
  return out;
}
