#!/usr/bin/env node
// Enriches prospects-intake.json with live homepage evidence (visible text,
// booking/quote/chat/financing/membership cues, tracking tags) so the research
// brief has observed facts for lead-capture, ads, CRM and database signals
// that Outscraper listings can't supply. Writes prospects-intake.enriched.json
// with ids suffixed "-e1" so runProspectIntake re-scores them as new entries.
// Read-only against the web; sends nothing.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = '.e3d-corp/instance/hvac-sandbox';
const IN = process.env.INTAKE_IN ?? path.join(DATA_DIR, 'prospects-intake.json');
const OUT = path.join(DATA_DIR, 'prospects-intake.enriched.json');

const CUES = {
  onlineBooking: /book (online|now|an appointment)|schedule (online|service|now|an appointment)|online scheduling|servicetitan|housecall|jobber|calendly/i,
  quoteForm: /free (estimate|quote)|request (a )?(quote|estimate|service)|<form/i,
  chatWidget: /livechat|intercom|drift|tawk\.to|podium|birdeye|widget\.|chat with us|text us/i,
  financing: /financing|wisetack|synchrony|greensky|hearth/i,
  membership: /maintenance (plan|agreement)|membership|service plan/i,
  emergency: /24\/?7|24 hour|emergency/i,
  adTags: /googleadservices|gtag\('config', 'AW-|fbq\(|facebook\.net\/.*fbevents|googleads|doubleclick/i
};

function textOf(html) {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchHome(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; IteraResearch/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const entries = JSON.parse(await readFile(IN, 'utf8'));
async function enrich(entry) {
  const { business, rawResearch } = entry;
  let observed;
  try {
    const html = await fetchHome(business.website);
    const cues = Object.entries(CUES).map(([k, re]) => `${k}: ${re.test(html) ? 'present' : 'not seen'}`).join('; ');
    observed = { text: textOf(html).slice(0, 2500), cues };
  } catch (error) {
    observed = { text: '', cues: `homepage fetch failed (${error.message})` };
  }
  process.stdout.write(`${business.name}: ${observed.cues}\n`);
  return {
    business: { ...business, id: business.id.replace(/-e\d+$/, '') + (process.env.INTAKE_ID_SUFFIX ?? '-e1') },
    rawResearch: {
      ...rawResearch,
      websiteText: `${rawResearch.websiteText}\n[Live homepage text, observed ${new Date().toISOString().slice(0, 10)}] ${observed.text}`,
      adActivityNotes: `${rawResearch.adActivityNotes}. Homepage cue scan (regex over HTML, single page only): ${observed.cues}`
    }
  };
}

// Small concurrency pool so a few hundred sites don't take an hour serially.
const out = [];
const CONCURRENCY = 8;
for (let i = 0; i < entries.length; i += CONCURRENCY) {
  out.push(...(await Promise.all(entries.slice(i, i + CONCURRENCY).map(enrich))));
}
await writeFile(OUT, JSON.stringify(out, null, 2));
process.stdout.write(`Wrote ${out.length} enriched entries to ${OUT}\n`);
