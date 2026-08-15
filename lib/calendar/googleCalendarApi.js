// Read-only wrapper over Calendar API v3's events.list - not a general
// client, just the one call the booking poller needs.
export async function listUpcomingCalendarEvents({ accessToken, calendarId, timeMin, maxResults = 50 }) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('timeMin', timeMin ?? new Date().toISOString());

  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Calendar events.list failed: HTTP ${response.status} ${text}`);
  }

  const body = await response.json();
  return Array.isArray(body.items) ? body.items : [];
}
