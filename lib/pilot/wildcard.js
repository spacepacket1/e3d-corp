import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getRootDir } from '../config.js';

const execFileAsync = promisify(execFile);

export const WILDCARD_TIMEOUT_MS = 180_000;
const MAX_ITEMS = 60;

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Turns the day's brief into the evidence list the wild-card step reasons over. Each item gets a stable id so an idea can
// cite what it was based on. Deliberately excludes anything personal: no booking details, no customer names or emails.
// Public post text, public handles and public news are fine; they are already in the brief.
export function buildWildcardEvidence(c, { numbers = [], headline = '' } = {}) {
  const items = [];
  const add = (section, text) => {
    const t = clip(text, 400);
    if (t) items.push({ id: `e${items.length + 1}`, section, text: t });
  };

  add('today', headline);
  for (const line of numbers) add('pilot-numbers', line);
  if (c.brief) {
    add('market-news', c.brief.summary);
    for (const comp of (c.brief.competitors ?? []).slice(0, 4)) add('competitors', `${comp.name}: ${comp.what}`);
    for (const imp of [].concat(c.brief.implications ?? []).slice(0, 3)) add('implications', typeof imp === 'string' ? imp : JSON.stringify(imp));
  }
  const L = c.listening ?? {};
  for (const it of L.hackernews ?? []) add('listening', `Hacker News: ${it.title} (${it.score} pts, ${it.comments} comments)`);
  for (const it of L.github ?? []) add('listening', `GitHub: ${it.title}, ${it.score} stars${it.description ? ` - ${it.description}` : ''}`);
  for (const it of L.youtube ?? []) add('listening', `YouTube: ${it.title}`);
  for (const l of (c.leads ?? []).slice(0, 5)) add('posts-worth-a-reply', `${l.post} (matched topic: ${l.topic})`);
  for (const p of (c.candidates ?? []).slice(0, 5)) add('people-to-invite', `Recent post: ${p.evidence?.title ?? ''} (${p.source}, reach ${p.reach})`);
  const sg = c.signals ?? {};
  for (const key of ['funded', 'hiring', 'asking']) for (const it of sg[key] ?? []) add(`signals-${key}`, `${it.who ? `${it.who}: ` : ''}${it.title}`);
  for (const it of sg.trigger ?? []) add('reasons-to-reach-out', `${it.category}: ${it.title}. Angle: ${it.angle}`);
  if ((c.bookings ?? []).length) add('pipeline', `${c.bookings.length} new or upcoming meeting(s) or inquiry(ies) today.`);
  if ((c.drafts ?? []).length) add('pipeline', `${c.drafts.length} draft post(s) are ready.`);

  return { date: c.now instanceof Date ? c.now.toISOString().slice(0, 10) : null, items: items.slice(0, MAX_ITEMS) };
}

async function defaultRunEngine({ binPath, evidencePath, outDir, extraArgs }) {
  await execFileAsync('node', [binPath, 'wildcard', evidencePath, '--out', outDir, ...extraArgs], { timeout: WILDCARD_TIMEOUT_MS });
}

// Runs e3d-creative's wildcard command. Returns { practical: [...], moonshot: idea|null }, or null. Anything that goes wrong (not configured, engine
// missing, timeout, bad output, no idea) yields null so the section is simply left out; the caller never sees an exception.
export async function runWildcardSection({ evidence, instanceConfig, brainConfig = null, brainMain = null, runEngine = defaultRunEngine, warn = () => {} }) {
  if (!evidence?.items?.length) return null;
  const enginePath = instanceConfig?.creative?.enginePath;
  if (typeof enginePath !== 'string' || enginePath.trim() === '') {
    warn('wildcard skipped: instance config has no creative.enginePath');
    return null;
  }
  const root = path.isAbsolute(enginePath) ? enginePath : path.resolve(getRootDir(), enginePath);
  const binPath = path.join(root, 'bin', 'e3d-creative');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-wildcard-'));
  try {
    const evidencePath = path.join(tmp, 'evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const outDir = path.join(tmp, 'out');
    const extraArgs = [...(brainConfig ? ['--brain-config', brainConfig] : []), ...(brainMain ? ['--brain-main', brainMain] : [])];
    await runEngine({ binPath, evidencePath, outDir, extraArgs });
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'wildcard.json'), 'utf8'));
    if (report?.status !== 'ideas') {
      const reason = String(report?.reason ?? 'none');
      warn(/failed/.test(reason) ? `wildcard FAILED (section left out): ${reason}` : `wildcard: no ideas today (${reason})`);
      return null;
    }
    const known = new Map(evidence.items.map((item) => [item.id, item.text]));
    // Every idea must cite evidence that is really in today's brief; one that does not is dropped on its own.
    const accept = (idea, kind) => {
      if (!idea || idea.kind !== kind || !Array.isArray(idea.evidenceRefs) || idea.evidenceRefs.length === 0 || !idea.evidenceRefs.every((id) => known.has(id))) {
        if (idea) warn(`wildcard: dropped a ${kind} idea with missing or unknown evidence`);
        return null;
      }
      return { ...idea, basedOn: idea.evidenceRefs.map((id) => known.get(id)) };
    };
    const practical = (Array.isArray(report.practical) ? report.practical : []).map((i) => accept(i, 'practical')).filter(Boolean);
    const moonshot = accept(report.moonshot, 'moonshot');
    if (practical.length === 0 && !moonshot) return null;
    return { practical, moonshot, brainStatus: report.brain?.status ?? 'unknown' };
  } catch (error) {
    warn(`wildcard failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
