// Turns `lead.received` events into the "meetings and inquiries" lines of the Pilot brief.
// Why this exists: the calendar poller records EVERY event on the booking calendar that has a guest, so the raw count
// mixed real prospect calls with team meetings and webinar invites. The brief now shows who, what and when, marks
// team-internal guests, and only counts external people as "new" prospects.
const DEFAULT_TEAM_DOMAINS = ['futco.ai', 'e3d.ai'];

const clip = (s, n) => { const t = String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function guestKind(email, { teamDomains = DEFAULT_TEAM_DOMAINS, teamEmails = [] } = {}) {
  const e = String(email ?? '').toLowerCase();
  const domain = e.split('@')[1] ?? '';
  if (!domain) return { internal: false, domain: '' };
  const internal = teamEmails.map((x) => String(x).toLowerCase()).includes(e) || teamDomains.map((d) => String(d).toLowerCase()).includes(domain);
  return { internal, domain };
}

// -> [{ kind: 'meeting' | 'inquiry', title, who, domain, internal, start, upcoming }], upcoming meetings first (soonest first),
// then past ones (most recent first). Never throws on a malformed event.
export function summarizeBookings(events, { now = new Date(), teamDomains, teamEmails } = {}) {
  const items = [];
  for (const e of events ?? []) {
    if (!e || typeof e !== 'object') continue;
    const p = e?.payload ?? {}, s = p.submission ?? {};
    const { internal, domain } = guestKind(s.email, { teamDomains, teamEmails });
    const isMeeting = p.source === 'google-calendar';
    const start = isMeeting && s.meetingStart && !Number.isNaN(Date.parse(s.meetingStart)) ? new Date(s.meetingStart) : null;
    items.push({
      kind: isMeeting ? 'meeting' : 'inquiry',
      title: clip(isMeeting ? s.meetingTitle || 'Meeting' : s.workflowProblem || 'Inquiry', 110),
      who: clip(s.name || (s.email ? s.email.split('@')[0] : ''), 60),
      company: clip(s.company, 60),
      domain,
      internal,
      start: start ? start.toISOString() : null,
      upcoming: start ? start.getTime() >= now.getTime() : false,
      recordedAt: e.occurredAt ?? null
    });
  }
  const t = (x) => (x.start ? Date.parse(x.start) : Date.parse(x.recordedAt) || 0);
  return items.sort((a, b) => (a.upcoming !== b.upcoming ? (a.upcoming ? -1 : 1) : a.upcoming ? t(a) - t(b) : t(b) - t(a)));
}

const fmtStart = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function bookingLine(b) {
  const when = b.start ? `${b.upcoming ? 'upcoming' : 'past'}, ${fmtStart(b.start)} PT` : 'time not given';
  const who = [b.who, b.company || (b.domain && !b.internal ? b.domain : '')].filter(Boolean).join(', ') || 'guest unknown';
  const tag = b.internal ? 'team' : b.kind === 'inquiry' ? 'form inquiry' : 'external guest';
  return `${b.title} (${when}) - ${who} [${tag}]`;
}

export function externalCount(items) { return items.filter((b) => !b.internal).length; }
