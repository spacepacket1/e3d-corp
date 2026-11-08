import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectBrief, renderText, renderHtml } from '../ops/reports/pilotBrief.js';
import { buildWildcardEvidence, runWildcardSection } from '../lib/pilot/wildcard.js';

const baseC = {
  now: new Date('2026-11-08T12:00:00Z'),
  brief: { summary: 'A competitor shipped a debate feature.', competitors: [{ name: 'Rival', what: 'multi-model chat' }], implications: ['Differentiate on dissent'] },
  listening: { hackernews: [{ title: 'Which model do I trust?', score: 120, comments: 80, url: 'https://x.test/hn' }] },
  leads: [{ url: 'https://x.test/p', post: 'Anyone compare LLM answers?', topic: 'model choice', reply: 'r' }],
  candidates: [], signals: { funded: [{ who: 'Acme AI', title: 'Raised a seed round', url: 'https://x.test/f', note: 'n' }] },
  bookings: [{ name: 'Jane Private', email: 'jane@private.test' }],
  drafts: [{}],
  leadTotal: 1
};

const idea = {
  kind: 'practical',
  lens: 'outsider',
  title: 'Second-opinion booth',
  idea: 'Offer one free second opinion on a live decision.',
  whyNow: 'People are asking which model to trust.',
  evidenceRefs: ['e1'],
  risk: 'Unverified demand.',
  firstTest: 'Reply to the thread once.'
};

test('evidence carries ids and excludes booking and customer personal data', () => {
  const ev = buildWildcardEvidence(baseC, { numbers: ['3 debates run'], headline: 'one post to reply to' });
  assert.ok(ev.items.length >= 5);
  assert.equal(ev.items[0].id, 'e1');
  const dump = JSON.stringify(ev);
  assert.doesNotMatch(dump, /Jane Private|jane@private\.test/);
  assert.match(dump, /1 new or upcoming meeting/);
});

test('no moonshot section unless an idea is present (text and html)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  try {
    const c = collectBrief({ dataDir, now: new Date('2026-11-08T12:00:00Z') });
    assert.doesNotMatch(renderText(c, 'x'), /MOONSHOT/);
    assert.doesNotMatch(renderHtml(c, 'x'), /Moonshot/);
    c.wildcard = null;
    assert.doesNotMatch(renderText(c, 'x'), /MOONSHOT/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('ideas render last, before the footer, practical ideas and moonshot labeled separately', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  try {
    const c = collectBrief({ dataDir, now: new Date('2026-11-08T12:00:00Z') });
    c.wildcard = { practical: [{ ...idea, basedOn: ['Which model do I trust?'] }], moonshot: { ...moon, basedOn: ['Which model do I trust?'] } };
    const text = renderText(c, 'x');
    const html = renderHtml(c, 'x');
    assert.match(text, /IDEAS WORTH TRYING/);
    assert.match(text, /MOONSHOT/);
    assert.ok(text.indexOf('IDEAS WORTH TRYING') < text.indexOf('MOONSHOT'));
    assert.ok(text.indexOf('MOONSHOT') < text.indexOf('Want something added'));
    assert.match(text, /Worst case: A flat live failure/);
    assert.match(text, /Rough cost: A day of work/);
    assert.match(text, /Nothing here has been done, sent or spent/);
    assert.match(html, /Ideas worth trying/);
    assert.match(html, /Moonshot/);
    assert.ok(html.indexOf('Moonshot') < html.indexOf('Want something added'));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('each part is left out on its own when empty', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  try {
    const c = collectBrief({ dataDir, now: new Date('2026-11-08T12:00:00Z') });
    c.wildcard = { practical: [{ ...idea, basedOn: ['x'] }], moonshot: null };
    assert.doesNotMatch(renderText(c, 'x'), /MOONSHOT/);
    assert.match(renderText(c, 'x'), /IDEAS WORTH TRYING/);
    c.wildcard = { practical: [], moonshot: { ...moon, basedOn: ['x'] } };
    assert.doesNotMatch(renderText(c, 'x'), /IDEAS WORTH TRYING/);
    assert.doesNotMatch(renderHtml(c, 'x'), /Ideas worth trying/);
    assert.match(renderHtml(c, 'x'), /Moonshot/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

const moon = {
  kind: 'moonshot',
  lens: 'stunt',
  title: 'Debate the balloon',
  idea: 'A live public debate on a question nobody agrees on.',
  whyNow: 'People ask which model to trust.',
  evidenceRefs: ['e1'],
  risk: 'A flat live failure.',
  costNote: 'A day of work, no spend.',
  firstTest: 'Rehearse with three friends.'
};

function stubEngine(report) {
  return async ({ outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'wildcard.json'), JSON.stringify(report));
  };
}
const ev = { items: [{ id: 'e1', section: 'listening', text: 'Which model do I trust?' }] };
const cfg = { creative: { enginePath: '/nonexistent/e3d-creative' } };

test('runWildcardSection returns practical ideas and a moonshot with their evidence text', async () => {
  const out = await runWildcardSection({ evidence: ev, instanceConfig: cfg, runEngine: stubEngine({ status: 'ideas', practical: [idea], moonshot: moon, brain: { status: 'ok' } }) });
  assert.equal(out.practical[0].title, 'Second-opinion booth');
  assert.equal(out.moonshot.title, 'Debate the balloon');
  assert.deepEqual(out.moonshot.basedOn, ['Which model do I trust?']);
});

test('an idea with unknown evidence is dropped on its own; the other survives', async () => {
  const warnings = [];
  const out = await runWildcardSection({ evidence: ev, instanceConfig: cfg, warn: (m) => warnings.push(m), runEngine: stubEngine({ status: 'ideas', practical: [idea], moonshot: { ...moon, evidenceRefs: ['zzz'] } }) });
  assert.equal(out.practical.length, 1);
  assert.equal(out.moonshot, null);
  assert.match(warnings.join(' '), /dropped a moonshot/);
});

test('a moonshot in the practical list, or a wrong kind, is not accepted', async () => {
  const out = await runWildcardSection({ evidence: ev, instanceConfig: cfg, runEngine: stubEngine({ status: 'ideas', practical: [moon], moonshot: idea }) });
  assert.equal(out, null);
});

test('runWildcardSection returns null for none, failures, engine errors and missing config', async () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(await runWildcardSection({ evidence: ev, instanceConfig: cfg, warn, runEngine: stubEngine({ status: 'none', reason: 'skeptic-rejected-all' }) }), null);
  assert.equal(await runWildcardSection({ evidence: ev, instanceConfig: cfg, warn, runEngine: stubEngine({ status: 'none', reason: 'generation-failed: systemPrompt is required' }) }), null);
  assert.equal(await runWildcardSection({ evidence: ev, instanceConfig: cfg, warn, runEngine: async () => { throw new Error('boom'); } }), null);
  assert.equal(await runWildcardSection({ evidence: ev, instanceConfig: {}, warn }), null);
  assert.equal(await runWildcardSection({ evidence: { items: [] }, instanceConfig: cfg, warn }), null);
  assert.ok(warnings.some((m) => /FAILED/.test(m)));
  assert.ok(warnings.some((m) => /no ideas today/.test(m)));
});
