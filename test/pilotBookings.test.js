import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeBookings, bookingLine, externalCount, guestKind } from '../lib/pilot/bookings.js';
import { appendEvent } from '../lib/events/store.js';
import { collectBrief, renderText, renderHtml } from '../ops/reports/pilotBrief.js';

const NOW = new Date('2026-11-08T15:00:00Z');
const cal = (title, start, name, email, desc = '') => ({ occurredAt: '2026-11-06T05:15:00Z', payload: { source: 'google-calendar', submission: { meetingTitle: title, meetingStart: start, name, email, workflowProblem: desc } } });
const form = (name, company, problem) => ({ occurredAt: '2026-11-07T01:00:00Z', payload: { source: 'e3d-applied', submission: { name, company, email: 'x@acme.com', workflowProblem: problem } } });

test('team guests are marked and not counted; external guests and form inquiries are', () => {
  const items = summarizeBookings([
    cal('Applied AI Office Hours | Claude Startups', '2026-11-23T10:00:00-08:00', '', 'owner@futco.ai', 'Access the event here: https://events.example.com'),
    cal('E3D Pilot Meeting', '2026-11-10T09:00:00-08:00', 'Chris Chapple', 'chris@chappleshouse.com'),
    form('Jamie', 'Acme', 'manual data entry')
  ], { now: NOW });
  assert.equal(externalCount(items), 2);
  assert.equal(items.find((i) => i.title.startsWith('Applied AI')).internal, true);
  assert.equal(items[0].title, 'E3D Pilot Meeting', 'soonest upcoming meeting first');
  assert.match(bookingLine(items[0]), /E3D Pilot Meeting \(upcoming, Tue, Nov 10, 9:00 AM PT\) - Chris Chapple, chappleshouse.com \[external guest\]/);
  assert.match(bookingLine(items.find((i) => i.kind === 'inquiry')), /\[form inquiry\]/);
  assert.match(bookingLine(items.find((i) => i.internal)), /\[team\]/);
});

test('past meetings are labelled past, ordered after upcoming; bad data never throws', () => {
  const items = summarizeBookings([cal('Old call', '2026-11-06T09:00:00-08:00', 'A', 'a@acme.com'), cal('Next call', '2026-11-12T09:00:00-08:00', 'B', 'b@acme.com'), { payload: {} }, null, cal('No time', 'garbage', '', '')], { now: NOW });
  assert.equal(items[0].title, 'Next call');
  assert.equal(items.find((i) => i.title === 'Old call').upcoming, false);
  assert.match(bookingLine(items.find((i) => i.title === 'No time')), /time not given.*guest unknown/);
  assert.deepEqual(summarizeBookings(undefined), []);
});

test('guestKind honours configured domains and exact team emails', () => {
  assert.equal(guestKind('a@FUTCO.ai').internal, true);
  assert.equal(guestKind('friend@gmail.com').internal, false);
  assert.equal(guestKind('friend@gmail.com', { teamEmails: ['Friend@gmail.com'] }).internal, true);
  assert.equal(guestKind('a@partner.com', { teamDomains: ['partner.com'] }).internal, true);
});

test('the brief lists meetings with who and when, and the headline counts only people outside the team', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  try {
    const rec = (s) => appendEvent(dataDir, { type: 'lead.received', source: 'google-calendar.appointment-booking', subject: { type: 'lead', id: s.email }, payload: { source: 'google-calendar', submission: s }, correlationId: 'c-' + s.email, occurredAt: '2026-11-08T05:15:00Z' });
    rec({ email: 'owner@futco.ai', meetingTitle: 'Webinar', meetingStart: '2026-11-23T10:00:00-08:00', name: '' });
    rec({ email: 'chris@chappleshouse.com', meetingTitle: 'E3D Pilot Meeting', meetingStart: '2026-11-10T09:00:00-08:00', name: 'Chris Chapple' });
    const c = collectBrief({ dataDir, now: NOW, config: { calendar: { organizerEmail: 'spacepacket@gmail.com' } } });
    const text = renderText(c, 'x'), html = renderHtml(c, 'x');
    assert.match(text, /MEETINGS AND INQUIRIES/);
    assert.match(text, /E3D Pilot Meeting \(upcoming.*Chris Chapple, chappleshouse.com \[external guest\]/);
    assert.match(text, /Webinar .*\[team\]/);
    assert.match(text, /Today: 1 meeting or inquiry from outside the team/);
    assert.match(html, /Meetings and inquiries/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('a booking is shown once: not again the next day, except a reminder the day the meeting happens', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk2-'));
  try {
    appendEvent(dataDir, { type: 'lead.received', source: 'google-calendar.appointment-booking', subject: { type: 'lead', id: 'x@acme.com' }, payload: { source: 'google-calendar', submission: { email: 'x@acme.com', meetingTitle: 'Intro call', meetingStart: '2026-11-12T09:00:00-08:00', name: 'X' } }, correlationId: 'c1', occurredAt: '2026-11-08T05:00:00Z' });
    const at = (iso) => renderText(collectBrief({ dataDir, now: new Date(iso), config: {} }), 'x');
    assert.match(at('2026-11-08T15:00:00Z'), /Intro call/, 'new: shown');
    assert.doesNotMatch(at('2026-11-09T15:00:00Z'), /Intro call/, 'next day: not repeated');
    assert.match(at('2026-11-11T20:00:00Z'), /Intro call/, 'the day before: reminder');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the headline never asks anyone to approve drafts', () => {
  const c = { leadTotal: 0, brief: null, listening: {}, candidates: [], signals: {}, bookings: [], drafts: [{}, {}, {}], pilot: { available: false } };
  assert.match(renderText(c, 'x'), /Today: 3 drafts ready to use/);
  assert.doesNotMatch(renderText(c, 'x'), /to approve/);
});

test('saveBriefCopy keeps html, text and a section record; a same-day rerun does not overwrite', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { saveBriefCopy } = await import('../ops/reports/pilotBrief.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-copy-'));
  const args = { dataDir: dir, now: new Date('2026-11-10T15:30:00Z'), subject: 's', to: 'a@b.c', text: 'T', html: '<p>H</p>', c: { wildcard: { practical: [1, 2], moonshot: { title: 'm' } } } };
  const first = saveBriefCopy(args);
  const second = saveBriefCopy({ ...args, html: '<p>H2</p>', now: new Date('2026-11-10T16:45:00Z') });
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), '<p>H</p>');
  const meta = JSON.parse(fs.readFileSync(first.replace('.html', '.json'), 'utf8'));
  assert.deepEqual(meta.sections, { moonshot: true, ideas: 2, wildcardRan: true });
  assert.equal(fs.readFileSync(first.replace('.html', '.txt'), 'utf8'), 'T');
});
