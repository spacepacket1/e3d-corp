#!/usr/bin/env node
// Polls the configured Google Calendar appointment schedule for upcoming
// bookings not yet recorded, turns each new one into a lead.received event
// (lib/event-sources/googleCalendarBooking.js), then runs it through
// opportunity.prospect - the same engine the scheduled discovery pass and
// the e3d-applied webhook both use. Run by cron every ~15 minutes.

import { loadInstance } from '../../lib/config.js';
import { loadServiceAccountCredentials, getServiceAccountAccessToken } from '../../lib/calendar/googleServiceAccount.js';
import { listUpcomingCalendarEvents } from '../../lib/calendar/googleCalendarApi.js';
import { alreadyRecordedGoogleEventIds, recordBookingReceived } from '../../lib/event-sources/googleCalendarBooking.js';
import { createResearchAdapter } from '../../lib/research/adapter.js';
import { runOpportunityEngine } from '../../lib/opportunities/engine.js';

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  const { config, dataDir } = loadInstance(instanceName);

  const calendar = config.calendar;
  if (!calendar) {
    throw new Error('Instance config has no "calendar" section configured');
  }

  const keyFilePath = process.env[calendar.serviceAccountKeyFileEnvVar];
  if (!keyFilePath) {
    throw new Error(`Env var "${calendar.serviceAccountKeyFileEnvVar}" (calendar.serviceAccountKeyFileEnvVar) is not set`);
  }

  const { clientEmail, privateKey } = loadServiceAccountCredentials(keyFilePath);
  const accessToken = await getServiceAccountAccessToken({ clientEmail, privateKey });

  const events = await listUpcomingCalendarEvents({ accessToken, calendarId: calendar.calendarId });
  const seen = alreadyRecordedGoogleEventIds(dataDir);
  const newEvents = events.filter((event) => event.id && !seen.has(event.id) && event.status !== 'cancelled');

  if (newEvents.length === 0) {
    process.stdout.write('No new calendar bookings.\n');
    return;
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });

  for (const calendarEvent of newEvents) {
    let leadEvent;
    try {
      leadEvent = recordBookingReceived(dataDir, calendarEvent, {
        organizerEmail: calendar.organizerEmail,
        calendarId: calendar.calendarId
      });
    } catch (error) {
      process.stdout.write(`Skipped calendar event ${calendarEvent.id}: ${error.message}\n`);
      continue;
    }

    process.stdout.write(`New booking -> lead.received ${leadEvent.id} (correlation ${leadEvent.correlationId})\n`);

    try {
      const { opportunity } = await runOpportunityEngine({
        instanceConfig: config,
        dataDir,
        triggerEvent: leadEvent,
        researchAdapter
      });
      process.stdout.write(`  -> opportunity ${opportunity.id} "${opportunity.title}" (score=${opportunity.score.value})\n`);
    } catch (error) {
      process.stderr.write(`  opportunity.prospect failed for booking ${leadEvent.id}: ${error.message}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`Calendar booking poll failed: ${error.message}\n`);
  process.exitCode = 1;
});
