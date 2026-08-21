/**
 * Step 3 — book the meeting.
 *
 * Availability comes from Zoom Scheduler; the booking itself is a Zoom meeting
 * created through the Meetings API. POST /scheduler/attendee rejects every
 * payload with a bare `400 Failed json validation!` (see zoom/meetings.js), and
 * the Meetings API is both functional and simpler: one call returns the join URL.
 *
 * Booking is therefore two writes:
 *   1. POST /users/me/meetings        → the meeting and its join URL
 *   2. POST /calendars/{id}/events    → the busy block that closes the slot
 *
 * Step 2 is not optional. Creating a meeting does NOT put it on the Zoom
 * Calendar (Zoom accepts `push_change_to_calendar: true` and silently stores
 * `false`), and Scheduler computes availability from that calendar — so without
 * the explicit event the slot keeps being offered to the next visitor.
 *
 * There is no hold/reservation API, so we re-check the slot immediately before
 * creating the meeting. That shrinks the race window; it cannot eliminate it.
 */

import { AppError, ErrorCode } from '../errors.js';
import { getSchedule } from './schedules.js';
import { getAvailableTimes, flattenSlots } from './availability.js';
import { createMeetingForSlot, getMeeting, deleteMeeting, toMeetingDto } from './meetings.js';
import {
  getPrimaryCalendarId,
  createEventForMeeting,
  findEventForMeeting,
  deleteEvent,
} from './calendar.js';

/** Is `startDateTime` still on offer? Compared as instants, not strings. */
async function assertSlotStillFree({ hostId, schedule, startDateTime, timeZone }) {
  const target = new Date(startDateTime).getTime();
  const from = new Date(target - 60_000).toISOString();
  const to = new Date(target + 24 * 3600_000).toISOString();

  const { response } = await getAvailableTimes(hostId, schedule.slug, {
    from,
    to,
    timeZone,
    rawSchedule: schedule,
  });

  const free = flattenSlots(response).slots.some((s) => new Date(s.startTime).getTime() === target);

  if (!free) {
    throw new AppError(ErrorCode.SLOT_TAKEN, 'That time was just booked. Please pick another slot.', {
      status: 409,
      detail: `${startDateTime} is no longer offered by available_times for "${schedule.slug}".`,
      meta: { startDateTime, scheduleSlug: schedule.slug },
    });
  }
}

/**
 * @param {object} input
 * @param {string} input.hostId          connected host; becomes the meeting owner
 * @param {string} input.scheduleSlug    booking page slug (schedule_id also resolves)
 * @param {string} input.startDateTime   ISO 8601, verbatim from an available slot
 * @param {number} input.durationMinutes
 * @param {string} [input.timeZone]
 * @param {{email:string, firstName:string, lastName:string}} input.booker
 * @param {Array<{question:string, answer:string}>} [input.answers]
 * @param {object} [input.rawSchedule]   pass to avoid re-fetching the schedule
 * @param {boolean} [input.skipAvailabilityCheck]
 */
export async function createBooking(input) {
  const {
    hostId,
    scheduleSlug,
    startDateTime,
    durationMinutes,
    timeZone,
    booker,
    answers = [],
    rawSchedule,
    skipAvailabilityCheck = false,
  } = input;

  const missing = ['hostId', 'scheduleSlug', 'startDateTime', 'durationMinutes'].filter(
    (k) => !input[k]
  );
  if (missing.length || !booker?.email || !booker?.firstName || !booker?.lastName) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'Incomplete booking request.', {
      status: 400,
      detail: `Missing: ${[
        ...missing,
        ...(!booker?.email ? ['booker.email'] : []),
        ...(!booker?.firstName ? ['booker.firstName'] : []),
        ...(!booker?.lastName ? ['booker.lastName'] : []),
      ].join(', ')}`,
    });
  }

  // Callers that already hold the schedule pass it through, saving a round trip.
  const schedule = rawSchedule ?? (await getSchedule(hostId, scheduleSlug));
  const zone = timeZone ?? schedule?.time_zone;

  if (!skipAvailabilityCheck) {
    await assertSlotStillFree({ hostId, schedule, startDateTime, timeZone: zone });
  }

  const { meeting, dto } = await createMeetingForSlot({
    hostId,
    schedule,
    startDateTime,
    durationMinutes,
    timeZone: zone,
    booker,
    answers,
  });

  // ── The meeting now exists. Block the slot. ──
  let calendarEvent = null;
  try {
    const calendarId = await getPrimaryCalendarId(hostId);
    if (!calendarId) throw new Error('no primary calendar on this account');
    calendarEvent = await createEventForMeeting(hostId, {
      calendarId,
      meeting,
      booker,
      timeZone: zone,
    });
    dto.calendarEventId = calendarEvent?.id ?? null;
    dto.calendarId = calendarId;
  } catch (err) {
    // The meeting is real and the invitee has a join URL, so this is a warning,
    // not a failure — but the slot is still bookable by someone else.
    dto.calendarEventId = null;
    dto.warning = {
      code: ErrorCode.PARTIAL_SUCCESS,
      message: 'The meeting was created, but the time was not blocked on the host\'s calendar.',
      detail: `${err.detail ?? err.message}. The slot may still be offered to other visitors.`,
    };
    console.error(`[booking] calendar block FAILED for meeting ${meeting.id}: ${err.detail ?? err.message}`);
  }

  if (!dto.meeting?.joinUrl) {
    dto.warning = {
      code: ErrorCode.NO_MEETING_LINK,
      message: 'The meeting was created but Zoom returned no join URL.',
      detail: 'Retry the confirmation lookup; if it persists, inspect the raw meeting object.',
    };
  }

  return { dto, raw: { meeting } };
}

/** Confirmation lookup / retry path. */
export async function getBookingConfirmation(hostId, meetingId) {
  const meeting = await getMeeting(hostId, meetingId);
  return { dto: toMeetingDto({ meeting }), raw: { meeting } };
}

/**
 * Cancel both halves. The calendar event must go too, or the slot stays blocked
 * forever even though the meeting is gone.
 */
export async function cancelBooking(hostId, meetingId, { calendarId, calendarEventId } = {}) {
  let meeting = null;
  try {
    meeting = await getMeeting(hostId, meetingId);
  } catch {
    // Already deleted; still try to clear the calendar block below.
  }

  const cal = calendarId ?? (await getPrimaryCalendarId(hostId));
  let eventId = calendarEventId ?? null;

  if (!eventId && cal && meeting) {
    eventId = (await findEventForMeeting(hostId, { calendarId: cal, meeting }))?.id ?? null;
  }

  if (cal && eventId) {
    try {
      await deleteEvent(hostId, cal, eventId);
    } catch (err) {
      console.error(`[booking] could not delete calendar event ${eventId}: ${err.detail ?? err.message}`);
    }
  }

  if (meeting) await deleteMeeting(hostId, meetingId);
  return { meetingDeleted: Boolean(meeting), calendarEventDeleted: Boolean(cal && eventId) };
}
