#!/usr/bin/env node
// Drafts the rest of the 15-day sequence (Day 4/6/8/11/15) for Tier A/B
// prospects that already have a Day-1 draft, queues each as a
// prospectOutreach.drafted event, and emails one review digest. Never sends
// outreach to prospects. Usage: FUTCO_DIGEST_TO_EMAIL=... node runProspectSequence.js
import crypto from 'node:crypto';
import { draftProspectOutreach, VALID_DAYS } from '../../lib/roles/prospectOutreachDraft.js';
import { appendEvent, queryEvents } from '../../lib/events/store.js';
import { sendEmailViaSes } from '../../lib/outreach/sesTransport.js';

const DATA_DIR = '.e3d-corp/instance/hvac-sandbox';
const CONFIG = {
  llm: { providers: { claude: { kind: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY', maxTokens: 2048 } } },
  roles: { 'sales.prospectOutreachDraft': { provider: 'claude' } },
  outreach: { provider: 'ses', region: 'us-east-2', fromEmail: 'outreach@e3d.ai' }
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const drafted = queryEvents(DATA_DIR, { type: 'prospectOutreach.drafted' });
const day1 = new Map(drafted.filter((e) => e.payload.day === 1).map((e) => [e.subject.id, e]));
const have = new Set(drafted.map((e) => `${e.subject.id}:${e.payload.day}`));
const scored = new Map(queryEvents(DATA_DIR, { type: 'prospect.scored' }).map((e) => [e.subject.id, e]));

const sections = [];
for (const [id, d1] of day1) {
  const s = scored.get(id).payload;
  const items = [{ day: 1, channel: d1.payload.channel, subject: d1.payload.draftSubject, body: d1.payload.draftBody }];
  for (const day of VALID_DAYS.filter((d) => d !== 1)) {
    if (have.has(`${id}:${day}`)) continue;
    const { draft, channel } = await draftProspectOutreach({ instanceConfig: CONFIG, business: s.business, brief: { leakHypothesis: s.leakHypothesis, sourceNotes: s.sourceNotes }, day });
    if (!draft) { process.stdout.write(`${s.business.name} day ${day}: no draft\n`); continue; }
    appendEvent(DATA_DIR, {
      type: 'prospectOutreach.drafted', source: 'ops.runProspectSequence', subject: { type: 'prospect', id },
      payload: { business: s.business, day, channel, tier: s.tier, score: s.score, draftSubject: draft.subject, draftBody: draft.body },
      correlationId: crypto.randomUUID()
    });
    items.push({ day, channel, subject: draft.subject, body: draft.body });
    process.stdout.write(`${s.business.name}: day ${day} ${channel} drafted\n`);
  }
  sections.push({ s, items });
}

const to = process.env.FUTCO_DIGEST_TO_EMAIL;
if (to && sections.length) {
  const text = sections.map(({ s, items }) => [`=== ${s.business.name} (${s.business.location}) - Tier ${s.tier}, ${s.score}/${s.maxScore} provisional ===`, `Leak: ${s.leakHypothesis}`, ...items.map((i) => `\n--- Day ${i.day} (${i.channel})${i.subject ? ` - Subject: ${i.subject}` : ''} ---\n${i.body}`)].join('\n')).join('\n\n\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:700px;margin:0 auto;color:#1a1a1a;"><h1 style="font-size:19px;">HVAC outreach sequences &mdash; ${sections.length} prospects, Day 1-15</h1>${sections.map(({ s, items }) => `<div style="margin:0 0 26px;padding:14px 16px;border:1px solid #e0e0e4;border-radius:8px;"><p style="margin:0 0 4px;font-weight:600;">${esc(s.business.name)} <span style="font-weight:400;color:#666;">(${esc(s.business.location)}, ${esc(s.business.reachability)})</span></p><p style="margin:0 0 10px;font-size:13px;color:#666;">Tier ${esc(s.tier)} &mdash; ${esc(s.score)}/${esc(s.maxScore)} provisional. ${esc(s.leakHypothesis)}</p>${items.map((i) => `<p style="margin:10px 0 2px;font-size:13px;"><strong>Day ${i.day} &middot; ${esc(i.channel)}</strong>${i.subject ? ` &mdash; ${esc(i.subject)}` : ''}</p><p style="margin:0;padding:10px 12px;background:#f4f4f6;border-radius:6px;white-space:pre-wrap;font-size:13px;">${esc(i.body)}</p>`).join('')}</div>`).join('')}<p style="font-size:12px;color:#666;">Drafts only; nothing has been sent to any prospect. Replace [Name] placeholders before use.</p></div>`;
  const result = await sendEmailViaSes({ instanceConfig: CONFIG, to, subject: `HVAC outreach sequences - ${sections.length} prospects, Day 1-15`, body: text, htmlBody: html });
  process.stdout.write(`Sent sequence digest to ${to} (messageId=${result.messageId})\n`);
}
