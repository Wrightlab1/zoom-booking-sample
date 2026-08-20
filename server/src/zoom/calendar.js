/**
 * The Zoom Calendar write that actually blocks a Scheduler slot.
 *
 * ── Why this exists ──
 * Creating a Zoom meeting does NOT put it on the host's Zoom Calendar. Zoom
 * accepts `settings.push_change_to_calendar: true` and silently echoes it back
 * as `false` (verified 2026-08-20 — `calendar_type: 1` was honoured, the push
 * flag was not), so no calendar event appears and Scheduler keeps offering the
 * slot. That is a double-booking bug waiting to happen.
 *
 * Scheduler availability IS computed from the Zoom Calendar — writing an event
 * at an open slot removes it from available_times, and deleting the event
 * restores it. So we write the event ourselves, explicitly.
 */

import { zoomFetch } from './client.js';

/** Marker embedded in the description so a booking's event can be found later. */
const MARKER = 'zoom-booking-sample:meeting:';

export function markerFor(meetingId) {
  return `${MARKER}${meetingId}`;
}

/** The host's primary calendar id, which is what Scheduler reads. */
export async function getPrimaryCalendarId(hostId) {
  const list = await zoomFetch('/calendars/users/me/calendarList', {
    hostId,
    query: { maxResults: 50 },
  });
  const items = list?.items ?? list?.calendars ?? [];
  return (items.find((c) => c.primary) ?? items[0])?.id ?? null;
}

/**
 * Write the busy block for a booking.
 * Failure here is not fatal to the booking, but it IS what prevents
 * double-booking, so callers must surface it rather than swallow it.
 */
export async function createEventForMeeting(hostId, { calendarId, meeting, booker, timeZone }) {
  const start = new Date(meeting.start_time);
  const end = new Date(start.getTime() + Number(meeting.duration ?? 30) * 60_000);

  const description = [
    `Join: ${meeting.join_url}`,
    meeting.password ? `Passcode: ${meeting.password}` : null,
    booker ? `Booked by ${[booker.firstName, booker.lastName].filter(Boolean).join(' ')} <${booker.email}>` : null,
    '',
    markerFor(meeting.id),
  ]
    .filter(Boolean)
    .join('\n');

  return zoomFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    hostId,
    method: 'POST',
    idempotent: false,
    body: {
      summary: meeting.topic,
      description,
      location: meeting.join_url,
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
      ...(booker?.email ? { attendees: [{ email: booker.email }] } : {}),
    },
  });
}

/** Locate a booking's calendar event when the caller did not keep its id. */
export async function findEventForMeeting(hostId, { calendarId, meeting }) {
  const start = new Date(meeting.start_time);
  const events = await zoomFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    hostId,
    query: {
      timeMin: new Date(start.getTime() - 3600_000).toISOString(),
      timeMax: new Date(start.getTime() + 3600_000).toISOString(),
      maxResults: 100,
      singleEvents: true,
    },
  });
  const items = events?.items ?? events?.events ?? [];
  const marker = markerFor(meeting.id);
  return items.find((e) => String(e.description ?? '').includes(marker)) ?? null;
}

export async function deleteEvent(hostId, calendarId, eventId) {
  return zoomFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { hostId, method: 'DELETE', idempotent: false }
  );
}
