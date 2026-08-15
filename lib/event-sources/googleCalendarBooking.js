import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';

// A Google Calendar appointment-schedule booking is a real inbound lead —
// same standing as an e3d-applied contact-form submission — just via a
// different intake channel, so it becomes the same `lead.received` event
// type (lib/event-sources/e3dApplied.js's counterpart for the webhook
// channel), letting it flow through opportunity.prospect and the
// communicator's recipient-derivation unchanged.

function extractGuest(calendarEvent, organizerEmail) {
  const attendees = Array.isArray(calendarEvent.attendees) ? calendarEvent.attendees : [];
  const guest = attendees.find(
    (attendee) => !attendee.organizer && attendee.email && attendee.email.toLowerCase() !== organizerEmail.toLowerCase()
  );
  return { name: guest?.displayName ?? '', email: guest?.email ?? '' };
}

// Dedup source of truth is the event store itself (no separate state file,
// same "events.jsonl is the single source of truth" convention as
// opportunities/proposals) - every booking already recorded carries its
// Google Calendar event id in payload.submission.googleEventId.
export function alreadyRecordedGoogleEventIds(dataDir) {
  return new Set(
    queryEvents(dataDir, { type: 'lead.received' })
      .filter((event) => event.payload?.source === 'google-calendar')
      .map((event) => event.payload?.submission?.googleEventId)
      .filter(Boolean)
  );
}

export function recordBookingReceived(dataDir, calendarEvent, { organizerEmail, calendarId }) {
  if (!calendarEvent || typeof calendarEvent !== 'object') {
    throw new Error('recordBookingReceived requires a Google Calendar event object');
  }
  const { name, email } = extractGuest(calendarEvent, organizerEmail);
  if (!email) {
    throw new Error(`Calendar event ${calendarEvent.id} has no non-organizer attendee email`);
  }

  return appendEvent(dataDir, {
    type: 'lead.received',
    source: 'google-calendar.appointment-booking',
    subject: { type: 'lead', id: email.toLowerCase() },
    payload: {
      source: 'google-calendar',
      mechanism: 'appointment-booking',
      submission: {
        name,
        email,
        company: '',
        role: '',
        companySize: '',
        workflowProblem: calendarEvent.description ?? '',
        triedAi: '',
        preferredNextStep: 'Booked a call',
        phone: '',
        referralSource: 'Google Calendar booking',
        consent: true,
        submittedAt: calendarEvent.created ?? new Date().toISOString(),
        googleEventId: calendarEvent.id,
        calendarId,
        meetingTitle: calendarEvent.summary ?? '',
        meetingStart: calendarEvent.start?.dateTime ?? calendarEvent.start?.date ?? null
      }
    },
    causationId: null,
    correlationId: crypto.randomUUID()
  });
}
