#!/usr/bin/env node
// Daily Pilot Marketing & Sales brief: what the e3d-pilot marketing and sales team can act on today.
// Pilot numbers, market and competitor news, X posts worth a reply, customers to nudge, and what is waiting on a
// human. Deliberately not the ops digest: no internal ids, no non-Pilot opportunities, no CLI footer.
// Usage: node pilotBrief.js --instance futco [--dry-run <file.html>] [--to a@b.c]   (recipient env: FUTCO_PILOT_BRIEF_TO_EMAIL)

import fs from 'node:fs';
import { loadInstance } from '../../lib/config.js';
import { queryEvents } from '../../lib/events/store.js';
import { listProposals } from '../../lib/proposals/store.js';
import { sendEmailViaSes } from '../../lib/outreach/sesTransport.js';
import { buildPilotSummary } from '../../lib/pilot/summary.js';
import { collectListening, recentListening } from '../../lib/research/pilotListening.js';
import { recentSignals, collectSignals } from '../../lib/research/pilotSignals.js';
import { suggestProduct, DEFAULT_PRODUCTS } from '../../lib/pilot/products.js';
import { summarizeBookings, bookingLine, externalCount } from '../../lib/pilot/bookings.js';
import { collectCandidates, recentCandidates, REACH_LABEL } from '../../lib/research/pilotCandidates.js';

const RECIPIENT_ENV_VAR = 'FUTCO_PILOT_BRIEF_TO_EMAIL';
const DAY_MS = 24 * 60 * 60 * 1000;
// "New today" means the last 20 hours, not 24: the cron fires about 24h apart (give or take seconds), and a full 24h window would
// sometimes include the previous run's items again.
const FRESH_HOURS = 20;
const FRESH_MS = FRESH_HOURS * 60 * 60 * 1000;
const MAX_LEADS = 5;

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fund = (s, key) => s.funnel.find((f) => f.key === key) ?? { value: null, delta: null };
const n = (v) => (v === null || v === undefined ? 'n/a' : v);
const signed = (d) => (d === null || d === undefined ? '' : ` (${d >= 0 ? '+' : ''}${d} vs yesterday)`);
const suggestLine = (g) => (g ? `${g.name} (${g.pitch})${g.matched?.length ? `; they mention: ${g.matched.join(', ')}` : '; default pick'} ${g.url}` : '');
const usd = (v) => (typeof v === 'number' ? `$${v.toFixed(v % 1 ? 2 : 0)}` : 'n/a');

// ---------- data ----------

export function collectBrief({ dataDir, now = new Date(), config = null }) {
  const since = new Date(now.getTime() - FRESH_MS).toISOString();
  const pilot = buildPilotSummary(dataDir, { now });

  const briefEvents = queryEvents(dataDir, { type: 'pilot.competitorBrief.created' }).filter((e) => e.payload?.status === 'ok' && e.payload?.brief);
  const latestBrief = briefEvents[briefEvents.length - 1] ?? null;
  const brief = latestBrief && latestBrief.occurredAt >= since ? { ...latestBrief.payload.brief, at: latestBrief.occurredAt } : null;

  const seen = new Set();
  const leads = [];
  for (const e of queryEvents(dataDir, { type: 'x.draftQueued', since }).reverse()) {
    const p = e.payload ?? {};
    if (!p.tweetUrl || seen.has(p.tweetId)) continue;
    seen.add(p.tweetId);
    leads.push({ url: p.tweetUrl, post: p.postText, topic: p.matchedTopic, why: p.finding?.text, reply: p.draftReply });
  }

  const pb = config?.pilotBrief ?? {};
  // Nothing repeats day to day: a booking shows once (the day it is recorded), plus a reminder the day a meeting is
  // about to happen; a draft shows once (the day it is queued).
  const bookings = summarizeBookings(queryEvents(dataDir, { type: 'lead.received', since: new Date(now.getTime() - 7 * DAY_MS).toISOString() }),
    { now, teamDomains: pb.teamDomains, teamEmails: [config?.calendar?.organizerEmail, ...(pb.teamEmails ?? [])].filter(Boolean) })
    .filter((b) => (b.recordedAt && b.recordedAt >= since) || (b.upcoming && b.start && Date.parse(b.start) - now.getTime() <= DAY_MS));
  const drafts = listProposals(dataDir, { status: 'pending' }).filter((p) => /post|ad|copy|content/i.test(p.type) && p.createdAt && p.createdAt >= since);

  const listening = recentListening(dataDir, { now, hours: FRESH_HOURS });
  const products = config?.research?.pilotCandidates?.products ?? DEFAULT_PRODUCTS;
  const candidates = recentCandidates(dataDir, { now, hours: FRESH_HOURS }).map((p) => ({ ...p, suggest: suggestProduct(p, products) }));
  const signals = recentSignals(dataDir, { now, hours: FRESH_HOURS });
  return { now, pilot, brief, leads, leadTotal: leads.length, bookings, drafts, listening, candidates, signals };
}

// ---------- rendering ----------

function headline(c) {
  const bits = [];
  if (c.leadTotal) bits.push(`${c.leadTotal} post${c.leadTotal === 1 ? '' : 's'} to reply to`);
  if (c.brief) bits.push('market news');
  const chatter = Object.values(c.listening ?? {}).reduce((a, l) => a + l.length, 0);
  if (chatter) bits.push(`${chatter} new mention${chatter === 1 ? '' : 's'} elsewhere`);
  const sg = c.signals ?? {};
  const buyers = (sg.funded?.length ?? 0) + (sg.hiring?.length ?? 0) + (sg.asking?.length ?? 0);
  if (buyers) bits.push(`${buyers} buying signal${buyers === 1 ? '' : 's'}`);
  if (sg.trigger?.length) bits.push(`${sg.trigger.length} reason${sg.trigger.length === 1 ? '' : 's'} to reach out today`);
  if (c.candidates?.length) bits.push(`${c.candidates.length} ${c.candidates.length === 1 ? 'person' : 'people'} to invite`);
  const ext = externalCount(c.bookings);
  if (ext) bits.push(`${ext} meeting${ext === 1 ? '' : 's'} or inquir${ext === 1 ? 'y' : 'ies'} from outside the team`);
  if (c.drafts.length) bits.push(`${c.drafts.length} draft${c.drafts.length === 1 ? '' : 's'} to approve`);
  return bits.length ? bits.join(', ') : 'quiet day';
}

function numbersLines(c) {
  const p = c.pilot;
  if (!p.available) return ['Pilot numbers are not available right now.'];
  const su = fund(p, 'signupsWindow'), fd = fund(p, 'firstDebateWindow'), pu = fund(p, 'purchasedTotal'), s7 = fund(p, 'signups7d');
  const lines = [
    `Signups in the last 24h: ${n(su.value)}${signed(su.delta)}; last 7 days: ${n(s7.value)}. Total: ${n(fund(p, 'signupsTotal').value)}.`,
    `First debates in the last 24h: ${n(fd.value)}${signed(fd.delta)}. Total people who have run one: ${n(fund(p, 'firstDebateTotal').value)}.`,
    `Buyers to date: ${n(pu.value)}${signed(pu.delta)}. Revenue last 24h: ${usd(p.revenue.packsRevenueUsdWindow)}, last 7 days: ${usd(p.revenue.packsRevenueUsd7d)}, MRR ${usd(p.revenue.mrrUsd)}.`,
    `Debates run: ${n(p.usage.debatesWindow)} in 24h, ${n(p.usage.debates7d)} in 7 days.`
  ];
  const tot = (k) => fund(p, k).value, pct = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? `${Math.round((a / b) * 100)}%` : null);
  const f1 = pct(tot('firstDebateTotal'), tot('signupsTotal')), f2 = pct(tot('purchasedTotal'), tot('firstDebateTotal'));
  if (f1) lines.push(`Funnel to date: ${n(tot('signupsTotal'))} signups, ${n(tot('firstDebateTotal'))} ran a first debate (${f1} of signups)${f2 ? `, ${n(tot('purchasedTotal'))} bought (${f2} of those who ran one)` : ''}.`);
  const stuck = p.cohorts?.signedUpNoDebate7d;
  if (stuck > 0) lines.push(`${stuck} recent signup${stuck === 1 ? '' : 's'} never ran a first debate. A short nudge with an example question could convert them.`);
  return lines;
}

function nudgeLines(c) {
  const k = c.pilot.cohorts ?? {};
  const rows = [
    [k.outOfCredits, 'ran out of credits and have not bought a pack: highest-intent buyers'],
    [k.starterExpiringSoon, 'have starter credits about to expire unused'],
    [k.nearAllowance, 'are close to their plan allowance: upgrade candidates'],
    [k.paymentFailed, 'had a failed payment: recoverable churn']
  ];
  return rows.filter(([v]) => v > 0).map(([v, t]) => `${v} customer${v === 1 ? '' : 's'} ${t}.`);
}

export function renderText(c, dateLabel) {
  const out = [`Pilot marketing & sales brief - ${dateLabel}`, `Today: ${headline(c)}`, ''];
  out.push('PILOT NUMBERS', ...numbersLines(c).map((l) => `- ${l}`), '');
  if (c.brief) {
    out.push('MARKET AND COMPETITOR NEWS', clip(c.brief.summary, 900));
    for (const comp of (c.brief.competitors ?? []).slice(0, 4)) out.push(`- ${comp.name}: ${clip(comp.what, 220)}${comp.url ? ` ${comp.url}` : ''}`);
    if ((c.brief.implications ?? []).length) { out.push('What it means for Pilot:'); for (const i of [].concat(c.brief.implications).slice(0, 3)) out.push(`- ${clip(typeof i === 'string' ? i : JSON.stringify(i), 260)}`); }
    out.push('');
  }
  const L = c.listening ?? {};
  if (Object.keys(L).length) {
    out.push('WHO ELSE IS BUILDING THIS, AND WHAT PEOPLE ARE SAYING');
    for (const it of L.hackernews ?? []) out.push(`- Hacker News: ${it.title} (${it.score} pts, ${it.comments} comments) ${it.url}`);
    for (const it of L.github ?? []) out.push(`- GitHub: ${it.title}, ${it.score} stars${it.description ? ` - ${it.description}` : ''} ${it.url}`);
    for (const it of L.youtube ?? []) out.push(`- YouTube: ${it.title} (${it.channel}) ${it.url}`);
    out.push('');
  }
  if (c.leadTotal) {
    out.push(`POSTS WORTH A REPLY (${Math.min(c.leadTotal, MAX_LEADS)} of ${c.leadTotal})`);
    c.leads.slice(0, MAX_LEADS).forEach((l, i) => out.push(`${i + 1}. ${l.url}`, `   Post: ${clip(l.post, 240)}`, `   Why it fits: ${clip(l.topic, 120)}`, `   Draft reply: ${clip(l.reply, 400)}`, ''));
  }
  if (c.candidates?.length) {
    out.push('PEOPLE TO INVITE TO TRY ONE OF OUR TOOLS (not sales leads: ask them to try it and, if they like it, post about it)');
    for (const p of c.candidates) out.push(`- ${p.name} ${p.handle} on ${p.source}, ${p.reach.toLocaleString('en-US')} ${REACH_LABEL[p.source]} ${p.url}`, `  Recent: ${clip(p.evidence?.title, 140)}${p.evidence?.url ? ` ${p.evidence.url}` : ''}`, `  Suggest: ${suggestLine(p.suggest)}`);
    out.push('');
  }
  const sg = c.signals ?? {};
  const SIG = [['funded', 'Just funded (AI teams that raised in the last day)'], ['hiring', 'Hiring for AI roles'], ['asking', 'Asking out loud which model to use or how to check one']];
  if (SIG.some(([k]) => sg[k]?.length)) {
    out.push('BUYING SIGNALS (teams that may need a second opinion; check them out before reaching out)');
    for (const [k, label] of SIG) if (sg[k]?.length) { out.push(`${label}:`); for (const it of sg[k]) out.push(`- ${it.who ? `${it.who}: ` : ''}${clip(it.title, 150)} (${it.note}) ${it.url}`); }
    out.push('');
  }
  if (sg.trigger?.length) {
    out.push('REASONS TO REACH OUT TODAY (news, and what Pilot can honestly say about it)');
    for (const it of sg.trigger) out.push(`- ${it.category}: ${clip(it.title, 150)} (${it.note}) ${it.url}`, `  Angle: ${it.angle}`);
    out.push('');
  }
  const nudges = nudgeLines(c);
  if (nudges.length) out.push('CUSTOMERS TO NUDGE', ...nudges.map((l) => `- ${l}`), '');
  if (c.bookings.length) out.push('MEETINGS AND INQUIRIES (new, or happening within 24 hours)', ...c.bookings.map((b) => `- ${bookingLine(b)}`), '');
  if (c.drafts.length) out.push('DRAFT POSTS READY', `- ${c.drafts.length} draft post(s) are ready to use. No approval needed: go ahead, or reply with edits.`, '');
  out.push('Want something added or changed? Just reply to this email.');
  return out.join('\n');
}

export function renderHtml(c, dateLabel) {
  const F = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const H2 = `${F}font-size:15px;margin:22px 0 8px;color:#1a1a1a;`;
  const P = `${F}font-size:14px;line-height:1.5;margin:0 0 8px;`;
  const ul = (items) => `<ul style="${F}font-size:14px;line-height:1.5;margin:0 0 8px;padding-left:20px;">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  const parts = [`<h1 style="${F}font-size:19px;margin:0 0 4px;">Pilot marketing &amp; sales brief</h1>`, `<p style="${P}color:#666;">${esc(dateLabel)} &middot; Today: ${esc(headline(c))}</p>`];
  parts.push(`<h2 style="${H2}">Pilot numbers</h2>`, ul(numbersLines(c).map(esc)));
  if (c.brief) {
    parts.push(`<h2 style="${H2}">Market and competitor news</h2>`, `<p style="${P}">${esc(clip(c.brief.summary, 900))}</p>`);
    const comps = (c.brief.competitors ?? []).slice(0, 4).map((x) => `<b>${esc(x.name)}</b>: ${esc(clip(x.what, 220))}${x.url ? ` <a href="${esc(x.url)}" style="color:#2952cc;">source</a>` : ''}`);
    if (comps.length) parts.push(ul(comps));
    const imps = [].concat(c.brief.implications ?? []).slice(0, 3).map((i) => esc(clip(typeof i === 'string' ? i : JSON.stringify(i), 260)));
    if (imps.length) parts.push(`<p style="${P}"><b>What it means for Pilot</b></p>`, ul(imps));
  }
  const L = c.listening ?? {};
  const rows = [
    ...(L.hackernews ?? []).map((it) => `<b>Hacker News</b> &middot; <a href="${esc(it.url)}" style="color:#2952cc;">${esc(it.title)}</a> (${it.score} pts, ${it.comments} comments)`),
    ...(L.github ?? []).map((it) => `<b>GitHub</b> &middot; <a href="${esc(it.url)}" style="color:#2952cc;">${esc(it.title)}</a>, ${it.score} stars${it.description ? ` &mdash; ${esc(it.description)}` : ''}`),
    ...(L.youtube ?? []).map((it) => `<b>YouTube</b> &middot; <a href="${esc(it.url)}" style="color:#2952cc;">${esc(it.title)}</a> (${esc(it.channel)})`)
  ];
  if (rows.length) parts.push(`<h2 style="${H2}">Who else is building this, and what people are saying</h2>`, ul(rows));
  if (c.leadTotal) {
    parts.push(`<h2 style="${H2}">Posts worth a reply (${Math.min(c.leadTotal, MAX_LEADS)} of ${c.leadTotal})</h2>`);
    for (const l of c.leads.slice(0, MAX_LEADS)) {
      parts.push(`<div style="border:1px solid #e0e0e4;border-radius:6px;padding:10px 12px;margin:0 0 10px;">` +
        `<p style="${P}"><a href="${esc(l.url)}" style="color:#2952cc;">${esc(clip(l.post, 240))}</a></p>` +
        `<p style="${P}color:#666;font-size:13px;">Why it fits: ${esc(clip(l.topic, 120))}</p>` +
        `<p style="${P}background:#f4f4f6;padding:8px;border-radius:4px;"><b>Draft reply:</b> ${esc(clip(l.reply, 400))}</p></div>`);
    }
  }
  if (c.candidates?.length) {
    parts.push(`<h2 style="${H2}">People to invite to try one of our tools</h2>`, `<p style="${P}color:#666;font-size:13px;">Not sales leads: the ask is to try it and, if they like it, post about it. Ranked by audience size and how recently they posted on the topic. The suggested tool is picked from words in their bio and recent post; E3D Pilot is the default.</p>`);
    parts.push(ul(c.candidates.map((p) => `<a href="${esc(p.url)}" style="color:#2952cc;"><b>${esc(p.name)}</b> ${esc(p.handle)}</a> &middot; ${esc(p.source)} &middot; ${p.reach.toLocaleString('en-US')} ${esc(REACH_LABEL[p.source])}<br><span style="color:#666;font-size:13px;">Recent: ${p.evidence?.url ? `<a href="${esc(p.evidence.url)}" style="color:#666;">${esc(clip(p.evidence?.title, 140))}</a>` : esc(clip(p.evidence?.title, 140))}</span><br><span style="font-size:13px;"><b>Suggest:</b> ${esc(suggestLine(p.suggest))}</span>`)));
  }
  const sg = c.signals ?? {};
  const SIG = [['funded', 'Just funded (AI teams that raised in the last day)'], ['hiring', 'Hiring for AI roles'], ['asking', 'Asking out loud which model to use or how to check one']];
  if (SIG.some(([k]) => sg[k]?.length)) {
    parts.push(`<h2 style="${H2}">Buying signals</h2>`, `<p style="${P}color:#666;font-size:13px;">Teams that may need a second opinion. Check them out before reaching out.</p>`);
    for (const [k, label] of SIG) if (sg[k]?.length) parts.push(`<p style="${P}"><b>${esc(label)}</b></p>`, ul(sg[k].map((it) => `${it.who ? `<b>${esc(it.who)}</b>: ` : ''}<a href="${esc(it.url)}" style="color:#2952cc;">${esc(clip(it.title, 150))}</a> <span style="color:#666;">(${esc(it.note)})</span>`)));
  }
  if (sg.trigger?.length) {
    parts.push(`<h2 style="${H2}">Reasons to reach out today</h2>`, `<p style="${P}color:#666;font-size:13px;">News, and what Pilot can honestly say about it.</p>`);
    parts.push(ul(sg.trigger.map((it) => `<b>${esc(it.category)}</b>: <a href="${esc(it.url)}" style="color:#2952cc;">${esc(clip(it.title, 150))}</a> <span style="color:#666;">(${esc(it.note)})</span><br><span style="background:#f4f4f6;display:inline-block;padding:4px 6px;border-radius:4px;margin-top:3px;"><b>Angle:</b> ${esc(it.angle)}</span>`)));
  }
  const nudges = nudgeLines(c);
  if (nudges.length) parts.push(`<h2 style="${H2}">Customers to nudge</h2>`, ul(nudges.map(esc)));
  if (c.bookings.length) parts.push(`<h2 style="${H2}">Meetings and inquiries (new, or happening within 24 hours)</h2>`, ul(c.bookings.map((b) => esc(bookingLine(b)))));
  if (c.drafts.length) parts.push(`<h2 style="${H2}">Draft posts ready</h2>`, `<p style="${P}">${c.drafts.length} draft post(s) are ready to use. No approval needed: go ahead, or reply with edits.</p>`);
  parts.push(`<p style="${P}color:#666;font-size:13px;border-top:1px solid #e0e0e4;padding-top:12px;margin-top:18px;">Want something added or changed? Just reply to this email.</p>`);
  return `<div style="max-width:680px;margin:0 auto;color:#1a1a1a;">${parts.join('\n')}</div>`;
}

// ---------- main ----------

async function main() {
  const instanceName = arg('--instance') ?? 'futco';
  const { config, dataDir } = loadInstance(instanceName);
  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const listened = await collectListening({ instanceConfig: config, dataDir, now }).catch((e) => ({ added: [], errors: [{ source: 'listening', message: e.message }] }));
  for (const err of listened.errors) process.stderr.write(`Listening source ${err.source} failed: ${err.message}\n`);
  const found = await collectCandidates({ instanceConfig: config, dataDir, now }).catch((e) => ({ added: [], errors: [{ source: 'candidates', message: e.message }] }));
  for (const err of found.errors) process.stderr.write(`Candidate source ${err.source} failed: ${err.message}\n`);
  const sigs = await collectSignals({ instanceConfig: config, dataDir, now }).catch((e) => ({ added: [], errors: [{ source: 'signals', message: e.message }] }));
  for (const err of sigs.errors) process.stderr.write(`Signal source ${err.source} failed: ${err.message}\n`);
  const c = collectBrief({ dataDir, now, config });
  const text = renderText(c, dateLabel);
  const html = renderHtml(c, dateLabel);

  const dry = arg('--dry-run');
  if (dry) { fs.writeFileSync(dry, html); process.stdout.write(`${text}\n\n(dry run: html written to ${dry}, nothing sent)\n`); return; }

  const to = arg('--to') ?? process.env[RECIPIENT_ENV_VAR];
  if (!to) throw new Error(`Recipient env var "${RECIPIENT_ENV_VAR}" is not set`);
  const subject = `Pilot brief — ${headline(c)} — ${now.toISOString().slice(0, 10)}`;
  const result = await sendEmailViaSes({ instanceConfig: config, to, subject, body: text, htmlBody: html });
  process.stdout.write(`Sent Pilot marketing & sales brief to ${to} (messageId=${result.messageId})\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`Pilot brief failed: ${error.message}\n`); process.exitCode = 1; });
}
