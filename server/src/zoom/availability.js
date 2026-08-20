/**
 * Step 2 — return available meeting slots.
 *
 * GET /scheduler/schedules/{scheduleId}/available_times
 *
 * This is the endpoint that makes the workflow possible. Do NOT substitute
 * GET /scheduler/availability: despite the name it returns recurring weekly
 * working-hours *rules* and does not subtract existing bookings, buffers,
 * cushion, or daily booking limits. Slots built from it will collide.
 */

import { AppError, ErrorCode } from '../errors.js';
import { zoomFetch } from './client.js';
import { getSchedule, resolveUserParam } from './schedules.js';

/**
 * Zoom anchors EVERY returned slot to the `from` timestamp — it does not snap
 * them to the schedule's own increment. Passing `new Date()` therefore yields a
 * whole grid of ragged times (11:49, 12:19, 13:49…) rather than 11:30, 12:00,
 * 12:30. Rounding `from` up to the next increment boundary fixes the entire
 * response, not just the first entry.
 *
 * Increments above an hour fall back to the top of the hour; every real
 * schedule uses a divisor of 60 (5/10/15/20/30).
 */
function roundUpToIncrement(date, incrementMinutes) {
  const step = Number(incrementMinutes) > 0 ? Number(incrementMinutes) : 15;
  const d = new Date(date);
  d.setSeconds(0, 0);
  if (step >= 60) {
    if (d.getMinutes() > 0) d.setHours(d.getHours() + 1);
    d.setMinutes(0);
    return d;
  }
  const rounded = Math.ceil(d.getMinutes() / step) * step;
  if (rounded >= 60) {
    d.setHours(d.getHours() + 1);
    d.setMinutes(rounded - 60);
  } else {
    d.setMinutes(rounded);
  }
  return d;
}

/** ISO 8601 in UTC, which is what `from` and `to` require. */
function toUtcIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'Invalid date range.', {
      status: 400,
      detail: `Could not parse "${value}" as a date.`,
    });
  }
  return date.toISOString();
}

/**
 * @param {string} hostId         connected host whose token owns this page
 * @param {string} scheduleSlug  the slug, NOT schedule_id — see getSchedule()
 * @param {object} opts
 * @param {string|Date} opts.from
 * @param {string|Date} opts.to
 * @param {string} [opts.timeZone]   IANA, e.g. America/New_York
 * @param {object} [opts.rawSchedule] pass to avoid a second schedule fetch
 */
export async function getAvailableTimes(hostId, scheduleSlug, { from, to, timeZone, rawSchedule } = {}) {
  const fromIso = toUtcIso(from);
  const toIso = toUtcIso(to);

  if (new Date(toIso) <= new Date(fromIso)) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'The end of the range must be after the start.', {
      status: 400,
      detail: `from=${fromIso} to=${toIso}`,
    });
  }

  const schedule = rawSchedule ?? (await getSchedule(hostId, scheduleSlug));
  const userParam = resolveUserParam(schedule);

  const increment = schedule?.start_time_increment ?? schedule?.duration ?? 15;
  const alignedFrom = roundUpToIncrement(new Date(fromIso), increment).toISOString();

  const response = await zoomFetch(
    `/scheduler/schedules/${encodeURIComponent(scheduleSlug)}/available_times`,
    {
      hostId,
      query: {
        from: alignedFrom,
        to: toIso,
        time_zone: timeZone,
        user: userParam ?? undefined,
      },
    }
  );

  return { response, userParam, schedule };
}

/**
 * Flatten days[].spots[] into one list of bookable slots.
 *
 * `duration` comes from the response, not the schedule — it is what the
 * booking call must echo back.
 */
export function flattenSlots(response) {
  const duration = response?.duration ?? null;
  const slots = [];

  for (const day of response?.days ?? []) {
    if (day?.status !== 'available') continue;
    for (const spot of day?.spots ?? []) {
      if (spot?.status !== 'available') continue;
      slots.push({
        date: day.date,
        startTime: spot.start_time,
        durationMinutes: duration,
        seatsRemaining: spot.available_number ?? 1,
      });
    }
  }

  return {
    scheduleId: response?.schedule_id ?? null,
    durationMinutes: duration,
    slots,
    // Days Zoom returned but marked unavailable — useful for an honest
    // "nothing free this week" empty state rather than a blank grid.
    daysQueried: (response?.days ?? []).length,
    daysAvailable: (response?.days ?? []).filter((d) => d?.status === 'available').length,
  };
}
