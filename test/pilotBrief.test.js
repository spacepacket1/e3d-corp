import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectBrief, renderText, renderHtml } from '../ops/reports/pilotBrief.js';

test('pilot brief renders on an empty instance without internals or ops noise', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-brief-'));
  try {
    const c = collectBrief({ dataDir, now: new Date('2026-11-04T15:00:00Z') });
    const text = renderText(c, 'Wed, Nov 4, 2026');
    const html = renderHtml(c, 'Wed, Nov 4, 2026');
    assert.match(text, /quiet day/);
    assert.match(text, /reply to this email/);
    for (const banned of [/localhost/, /e3d-corp opportunities/, /CUMULATIVE/i, /\bid [0-9a-f]{8}\b/]) {
      assert.doesNotMatch(text, banned);
      assert.doesNotMatch(html, banned);
    }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

import { parseIcs, todaysEvents, collectEvents } from '../lib/research/pilotEvents.js';

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'SUMMARY:AI Engineer Code Summit', 'DTSTART:20261110T000000Z', 'LOCATION:San Francisco\\, CA', 'URL:https://luma.com/x1', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Pottery night', 'DTSTART:20261110T020000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Agents meetup (tomorrow)', 'DTSTART:20261111T020000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Cancelled AI mixer', 'DTSTART:20261110T010000Z', 'STATUS:CANCELLED', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('events: keeps today\'s AI events in Pacific time, drops other days, non-AI and cancelled', () => {
  // 16:00 PT on Nov 9 2026 = 2026-11-10T00:00Z
  const now = new Date('2026-11-09T18:00:00Z');
  const got = todaysEvents(parseIcs(ICS), now);
  assert.deepEqual(got.map((e) => e.title), ['AI Engineer Code Summit']);
  assert.equal(got[0].location, 'San Francisco, CA');
});

test('events: no feeds configured means no section, and a failing feed is reported not thrown', async () => {
  assert.deepEqual((await collectEvents({ instanceConfig: {} })).events, []);
  const bad = await collectEvents({ instanceConfig: { pilotBrief: { events: { icsFeeds: ['https://example.test/a.ics'] } } }, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.events.length, 0);
  assert.equal(bad.errors.length, 1);
});

test('events section renders in text and html', () => {
  const c = collectBrief({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-brief-')), now: new Date('2026-11-09T18:00:00Z') });
  c.events = todaysEvents(parseIcs(ICS), new Date('2026-11-09T18:00:00Z'));
  assert.match(renderText(c, 'Mon'), /AI EVENTS TODAY[\s\S]*4:00 PM PT: AI Engineer Code Summit/);
  assert.match(renderHtml(c, 'Mon'), /AI events today[\s\S]*luma\.com\/x1/);
});

test('events: bayAreaOnly feeds drop events outside the Bay Area and link-only locations', async () => {
  const ics = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'SUMMARY:AI night SF', 'DTSTART:20261110T180000Z', 'LOCATION:450 Powell St\\, San Francisco\\, CA 94108\\, USA', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:AI vibe night Atlanta', 'DTSTART:20261110T190000Z', 'LOCATION:942 Peachtree St NE\\, Atlanta\\, GA 30309\\, USA', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:AI podcast', 'DTSTART:20261110T200000Z', 'LOCATION:https://luma.com/event/evt-x', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:[SV] AI Dev Night', 'DTSTART:20261110T210000Z', 'LOCATION:https://luma.com/event/evt-y', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const fetchImpl = async () => ({ ok: true, text: async () => ics });
  const now = new Date('2026-11-10T16:00:00Z');
  const run = (feed) => collectEvents({ instanceConfig: { pilotBrief: { events: { icsFeeds: [feed] } } }, now, fetchImpl });
  assert.deepEqual((await run({ url: 'https://x.test/a.ics', bayAreaOnly: true })).events.map((e) => e.title), ['AI night SF', '[SV] AI Dev Night']);
  assert.equal((await run('https://x.test/a.ics')).events.length, 4);
});
