/**
 * Step 3, via the Meetings API rather than Zoom Scheduler.
 *
 * ── Why not POST /scheduler/attendee ──
 * That endpoint rejects every payload with a bare `400 Failed json validation!`,
 * including an empty `{}` body — under both Server-to-Server and user-level
 * OAuth, and including the exact payload Zoom's own booking page sends. See
 * docs/api-validation.md.
 *
 * ── Why this works instead ──
 * POST /users/me/meetings creates a meeting owned by the connected host and
 * returns `join_url` in ONE call (Scheduler needed two). The meeting lands on
 * the host's Zoom Calendar, and Scheduler availability is computed FROM that
 * calendar — verified 2026-08-20: writing a calendar event at an open slot
 * removed it from available_times, and deleting the event restored it. So a
 * meeting booked here correctly stops the slot being offered again.
 *
 * The trade-off: this creates a Zoom meeting, not a Scheduler "scheduled
 * event". It will not appear under /scheduler/events, and Scheduler's own
 * reminder/reschedule emails do not apply.
 */

import { AppError, ErrorCode } from '../errors.js';
import { zoomFetch } from './client.js';

/** Zoom meeting type 2 = a scheduled meeting (1 = instant, 3 = recurring no fixed time). */
const TYPE_SCHEDULED = 2;

/** Zoom Calendar. Required alongside push_change_to_calendar for the sync to happen. */
const CALENDAR_TYPE_ZOOM = 1;

export function toMeetingDto({ meeting, schedule, booker, warning }) {
  return {
    meetingId: String(meeting?.id ?? ''),
    uuid: meeting?.uuid ?? null,
    topic: meeting?.topic ?? null,
    startDateTime: meeting?.start_time ?? null,
    durationMinutes: meeting?.duration ?? null,
    timeZone: meeting?.timezone ?? null,
    scheduleSlug: schedule?.slug ?? null,
    host: {
      userId: meeting?.host_id ?? null,
      email: meeting?.host_email ?? null,
    },
    attendees: booker
      ? [{ name: `${booker.firstName} ${booker.lastName}`.trim(), email: booker.email, isBooker: true }]
      : [],
    meeting: meeting
      ? {
          kind: 'zoomMeeting',
          meetingId: String(meeting.id),
          joinUrl: meeting.join_url ?? null,
          passcode: meeting.password ?? null,
          // start_url embeds host credentials — it must reach the HOST only,
          // never an invitee, so it is deliberately not surfaced here.
        }
      : null,
    warning: warning ?? null,
  };
}

/**
 * @param {object} input
 * @param {string} input.hostId          connected host; becomes the meeting owner
 * @param {object} input.schedule        raw Scheduler schedule (for topic/duration)
 * @param {string} input.startDateTime   ISO 8601, taken verbatim from an available slot
 * @param {number} input.durationMinutes
 * @param {string} input.timeZone        IANA
 * @param {{email:string, firstName:string, lastName:string}} input.booker
 * @param {Array<{question:string, answer:string}>} [input.answers]
 */
export async function createMeetingForSlot(input) {
  const { hostId, schedule, startDateTime, durationMinutes, timeZone, booker, answers = [] } = input;

  if (!hostId || !startDateTime || !durationMinutes || !booker?.email) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'Incomplete booking request.', {
      status: 400,
      detail: 'hostId, startDateTime, durationMinutes and booker.email are all required.',
    });
  }

  const bookerName = [booker.firstName, booker.lastName].filter(Boolean).join(' ').trim();

  // Zoom wants start_time as UTC with a Z suffix when `timezone` is also sent.
  // Slot times arrive carrying the host's offset, so normalise explicitly.
  const startUtc = new Date(startDateTime);
  if (Number.isNaN(startUtc.getTime())) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'Invalid start time.', {
      status: 400,
      detail: `Could not parse "${startDateTime}".`,
    });
  }

  const agendaLines = [
    `Booked by ${bookerName || booker.email} <${booker.email}>`,
    ...answers.map((a) => `${a.question}: ${a.answer}`),
  ];

  const body = {
    topic: schedule?.summary ? `${schedule.summary} — ${bookerName || booker.email}` : 'Meeting',
    type: TYPE_SCHEDULED,
    start_time: startUtc.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: durationMinutes,
    timezone: timeZone,
    agenda: agendaLines.join('\n').slice(0, 2000),
    default_password: true,
    settings: {
      // Invite the booker so they receive the calendar invitation.
      meeting_invitees: [{ email: booker.email }],
      email_notification: true,
      join_before_host: false,
      waiting_room: true,
      host_video: true,
      participant_video: true,
      // The pair that puts this meeting on the host's Zoom Calendar — which is
      // what makes Scheduler stop offering the slot.
      calendar_type: CALENDAR_TYPE_ZOOM,
      push_change_to_calendar: true,
    },
  };

  // `me` resolves to the connected host, so they own the meeting by construction.
  const meeting = await zoomFetch('/users/me/meetings', {
    hostId,
    method: 'POST',
    body,
    // A timed-out create may already have succeeded; retrying would double-book.
    idempotent: false,
  });

  return { meeting, dto: toMeetingDto({ meeting, schedule, booker }) };
}

export async function getMeeting(hostId, meetingId) {
  return zoomFetch(`/meetings/${encodeURIComponent(meetingId)}`, { hostId });
}

export async function deleteMeeting(hostId, meetingId) {
  return zoomFetch(`/meetings/${encodeURIComponent(meetingId)}`, {
    hostId,
    method: 'DELETE',
    query: { schedule_for_reminder: false },
    idempotent: false,
  });
}
