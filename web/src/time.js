/**
 * Slot times arrive as offset-bearing ISO strings (e.g. 2026-08-20T11:00:00-04:00),
 * never UTC `Z` — the offset follows the time_zone we asked for.
 *
 * Two rules keep this honest:
 *   1. Format for display in ONE timezone, stated on screen, so a viewer in a
 *      different zone is never quietly misled about when the meeting is.
 *   2. Send the ORIGINAL string back when booking. Never a reformatted one —
 *      re-serialising is how off-by-an-hour bugs get introduced.
 */

export const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function formatTime(iso, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

export function formatDayLabel(dateStr, timeZone) {
  // `dateStr` is a plain YYYY-MM-DD. Anchoring at noon UTC avoids the date
  // shifting backwards for viewers in negative offsets.
  const d = new Date(`${dateStr}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone }).format(d),
    day: new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone }).format(d),
    month: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone }).format(d),
  };
}

export function formatFullDateTime(iso, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  }).format(new Date(iso));
}

/** Midnight local to `date`, offset by `days`. */
export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The seven ISO dates covering a week starting at `start`. */
export function weekDates(start) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

export function isSameInstant(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}
