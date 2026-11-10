// "AI events today" for the Pilot brief, from public iCal (.ics) feeds only (the "subscribe" URLs that Luma calendars and similar
// sites publish). Feeds are listed in instance.json under pilotBrief.events.icsFeeds; with none configured the section is left out.
// Read-only: one GET per feed, no logins, no scraping. Any feed that fails is skipped and reported through `errors`.
const TZ = 'America/Los_Angeles';
const AI_RE = /\b(ai|a\.i\.|llms?|gpt|chatgpt|claude|anthropic|openai|gemini|agents?|agentic|mcp|machine learning|generative|ml)\b/i;
export const MAX_EVENTS = 10;
// For global feeds (feed entry {url, bayAreaOnly: true}): keep only events whose location or title names a Bay Area place or an [SF]/[SV] tag.
// Events with just a link as their location (online or unknown) are dropped for those feeds.
const BAY_RE = /\b(san francisco|sf|bay area|silicon valley|sv|palo alto|mountain view|sunnyvale|san jose|santa clara|cupertino|menlo park|redwood city|san mateo|south san francisco|oakland|berkeley|hillsborough|los altos|fremont|emeryville)\b|, CA \d{5}/i;
export const inBayArea = (e) => BAY_RE.test(`${e.location ?? ''} ${e.title}`);

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const unescapeIcs = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// Wall-clock time in Pacific -> instant. Tries both offsets so it is right on either side of a clock change.
function pacificWallToDate(y, mo, d, h, mi, s) {
  for (const offset of [8, 7]) {
    const guess = new Date(Date.UTC(y, mo - 1, d, h + offset, mi, s));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(guess);
    const got = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
    if (got.hour === h && got.minute === mi) return guess;
  }
  return new Date(Date.UTC(y, mo - 1, d, h + 8, mi, s));
}

function parseIcsDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: pacificWallToDate(+y, +mo, +d, 0, 0, 0), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))), allDay: false };
  return { date: pacificWallToDate(+y, +mo, +d, +h, +mi, +(s ?? 0)), allDay: false };
}

export function parseIcs(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur?.title && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).split(';')[0].toUpperCase();
    const value = line.slice(i + 1);
    if (name === 'SUMMARY') cur.title = clip(unescapeIcs(value), 160);
    else if (name === 'LOCATION') cur.location = clip(unescapeIcs(value), 120);
    else if (name === 'URL') cur.url = value.trim();
    else if (name === 'DESCRIPTION') cur.description = unescapeIcs(value);
    else if (name === 'DTSTART') { const p = parseIcsDate(value); if (p) Object.assign(cur, { start: p.date, allDay: p.allDay }); }
    else if (name === 'STATUS') cur.status = value.trim().toUpperCase();
  }
  return events.filter((e) => e.status !== 'CANCELLED');
}

// Events that start today (Pacific) and look AI related, soonest first, one per title+start.
export function todaysEvents(events, now = new Date(), { aiOnly = true, limit = MAX_EVENTS } = {}) {
  const today = dayKey(now);
  const seen = new Set();
  return events
    .filter((e) => dayKey(e.start) === today)
    .filter((e) => !aiOnly || AI_RE.test(`${e.title} ${e.description ?? ''}`.slice(0, 1500)))
    .filter((e) => { const k = `${e.title.toLowerCase()}|${e.start.toISOString()}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((e) => ({ title: e.title, start: e.start.toISOString(), allDay: e.allDay, location: e.location ?? '', url: e.url ?? '' }));
}

export const eventTime = (e) => (e.allDay ? 'All day' : `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(e.start))} PT`);

export async function collectEvents({ instanceConfig, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const cfg = instanceConfig?.pilotBrief?.events ?? {};
  // A feed is a URL string, or {url, bayAreaOnly}.
  const feeds = (cfg.icsFeeds ?? []).map((f) => (typeof f === 'string' ? { url: f } : f)).filter((f) => /^https:\/\//.test(f?.url));
  const errors = [];
  const all = [];
  for (const { url, bayAreaOnly } of feeds) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'futco-pilot-events/1.0', accept: 'text/calendar,*/*' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = parseIcs(await r.text());
      all.push(...(bayAreaOnly ? parsed.filter(inBayArea) : parsed));
    } catch (e) { errors.push({ source: new URL(url).hostname, message: e.message }); }
  }
  return { events: todaysEvents(all, now, { aiOnly: cfg.aiOnly !== false, limit: cfg.maxEvents ?? MAX_EVENTS }), errors, feeds: feeds.length };
}
