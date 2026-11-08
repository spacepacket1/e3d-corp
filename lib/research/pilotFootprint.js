// Public footprint of the Pilot repos for the daily brief: stars and forks, and the state of the directory pull requests
// we are waiting on. Sampled once per run as a `pilot.footprint.sampled` event; the brief only reports CHANGES since the
// previous sample (and the first sample), so an unchanged day adds nothing.
import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';

export const FOOTPRINT_EVENT_TYPE = 'pilot.footprint.sampled';
export const DEFAULT_REPOS = Object.freeze(['spacepacket1/e3d-pilot', 'spacepacket1/e3d-brain', 'spacepacket1/e3d-pod2vid']);
// Pull requests to watch are listed in config (research.pilotFootprint.pullRequests: [{ repo, number, label }]); none by default.
export const DEFAULT_PRS = Object.freeze([]);

const init = (token) => ({ signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'futco-pilot-footprint/1.0', accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
const getJson = async (fetchImpl, url, token) => { const r = await fetchImpl(url, init(token)); if (!r.ok) throw new Error(`github HTTP ${r.status}`); return r.json(); };

export async function collectFootprint({ instanceConfig, dataDir, now = new Date(), env = process.env, fetchImpl = globalThis.fetch }) {
  const c = instanceConfig?.research?.pilotFootprint ?? {};
  const token = env.GITHUB_TOKEN || null;
  const sample = { repos: {}, prs: {} };
  const errors = [];
  for (const name of c.repos ?? DEFAULT_REPOS) {
    try { const r = await getJson(fetchImpl, `https://api.github.com/repos/${name}`, token); sample.repos[name] = { stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0 }; }
    catch (e) { errors.push({ source: name, message: e.message }); }
  }
  for (const pr of c.pullRequests ?? DEFAULT_PRS) {
    try {
      const r = await getJson(fetchImpl, `https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`, token);
      sample.prs[`${pr.repo}#${pr.number}`] = { label: pr.label ?? `${pr.repo}#${pr.number}`, state: r.merged ? 'merged' : r.state, url: r.html_url, comments: r.comments ?? 0 };
    } catch (e) { errors.push({ source: `${pr.repo}#${pr.number}`, message: e.message }); }
  }
  if (Object.keys(sample.repos).length || Object.keys(sample.prs).length) {
    appendEvent(dataDir, { type: FOOTPRINT_EVENT_TYPE, source: 'research.footprint', subject: { type: 'footprint', id: 'pilot' }, payload: sample, correlationId: crypto.randomUUID(), occurredAt: now.toISOString() });
  }
  return { sample, errors };
}

// -> lines describing what changed between the last two samples ([] when nothing did).
export function footprintChanges(dataDir) {
  const all = queryEvents(dataDir, { type: FOOTPRINT_EVENT_TYPE });
  const cur = all[all.length - 1]?.payload, prev = all[all.length - 2]?.payload;
  if (!cur) return [];
  const lines = [];
  for (const [name, v] of Object.entries(cur.repos ?? {})) {
    const p = prev?.repos?.[name];
    if (!prev) lines.push(`${name}: ${v.stars} stars, ${v.forks} forks (first reading)`);
    else if (p && (p.stars !== v.stars || p.forks !== v.forks)) lines.push(`${name}: ${v.stars} stars (${v.stars - p.stars >= 0 ? '+' : ''}${v.stars - p.stars}), ${v.forks} forks (${v.forks - p.forks >= 0 ? '+' : ''}${v.forks - p.forks})`);
  }
  for (const [key, v] of Object.entries(cur.prs ?? {})) {
    const p = prev?.prs?.[key];
    if (!prev || (p && (p.state !== v.state || p.comments !== v.comments))) lines.push(`${v.label}: ${v.state}${p && p.state !== v.state ? ` (was ${p.state})` : ''}${p && p.comments !== v.comments ? `, ${v.comments - p.comments} new comment(s)` : ''} ${v.url}`);
  }
  return lines;
}
