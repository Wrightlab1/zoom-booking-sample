/**
 * Idempotent booking-page provisioning.
 *
 * A Zoom Scheduler user has two separate things:
 *   1. a Scheduler *profile* — created when they first sign in (slug, scheduling_url)
 *   2. one or more *booking pages* ("event types") — created explicitly
 *
 * GET /scheduler/schedules lists (2), not (1). A freshly provisioned user therefore
 * returns HTTP 200 with `{"items": []}`, which looks identical to a permissions
 * problem. This module closes that gap by creating a booking page when none exists.
 *
 * ── Spec warning ──
 * POST /scheduler/schedules declares `required: [availability_override,
 * availability_rules, capacity, end, start, type]`, but `end`, `start` and `type`
 * are NOT defined anywhere in that request body's `properties`. The properties
 * define `start_date`, `end_date` and `schedule_type` instead — the required list
 * is stale against renamed fields. We send the modern names first and retry with
 * the legacy aliases on a 400, then report which shape Zoom actually accepted.
 */

import { config } from '../config.js';
import { AppError, ErrorCode } from '../errors.js';
import { zoomFetch } from './client.js';
import { isBookable, listRawSchedulesForHost } from './schedules.js';

const DEFAULT_PAGE = {
  summary: 'Sample App Demo',
  slug: 'sample-app-demo',
  durationMinutes: 30,
  startTimeIncrement: 30,
  capacity: 1,
  windowDays: 90,
};

/** The availability rule the new page will follow (usually "Working hours"). */
async function findAvailabilityRule(hostId) {
  const res = await zoomFetch('/scheduler/availability', {
    hostId,
    query: { page_size: 30 },
  });
  const items = res?.items ?? [];
  return items.find((r) => r.default) ?? items[0] ?? null;
}

/**
 * The request body Zoom actually accepts — established empirically, because the
 * spec's `required` list names three fields (`start`, `end`, `type`) that do not
 * exist in its own `properties`, and every documented-looking shape returns a
 * bare `400 Failed json validation!` with no field detail.
 *
 * What the API really wants:
 *   - `availability_override: true` with inline `segments_recurrence`.
 *     Referencing a saved rule via `availability_rules: [{availability_id}]`
 *     fails validation, even with a valid id belonging to that same user.
 *   - `interval_type: "fixed"` plus BOTH `start_date`/`end_date` AND `start`/`end`.
 *     Omitting the dates yields `400 Miss time fields.` — it means the dates, not
 *     the times.
 *   - the legacy `type` alias alongside everything else.
 */
function buildBody({ rule, page, timeZone }) {
  const today = new Date();
  const endDate = new Date(today.getTime() + page.windowDays * 86_400_000);
  const isoDate = (d) => d.toISOString().slice(0, 10);

  return {
    type: 'one',
    schedule_type: 'one',
    summary: page.summary,
    slug: page.slug,
    description: 'Created automatically by the Zoom booking sample app.',
    duration: page.durationMinutes,
    add_on_type: 'zoomMeeting', // the whole point — makes bookings provision a Zoom meeting
    capacity: page.capacity,
    active: true,
    secret: false,
    start_time_increment: page.startTimeIncrement,
    time_zone: timeZone ?? rule.time_zone ?? config.demo.defaultTimeZone,

    // Inline availability. A rule reference is rejected; the recurrence is copied
    // off the user's own default rule so the page mirrors their working hours.
    availability_override: true,
    availability_rules: [],
    segments_recurrence: rule.segments_recurrence,
    segments: [],

    interval_type: 'fixed',
    start_date: isoDate(today),
    end_date: isoDate(endDate),
    start: '09:00',
    end: '17:00',
  };
}

/**
 * Create a booking page for one user if they do not already have a usable one.
 *
 * @returns {{ created: boolean, schedule: object|null, shape?: 'modern'|'legacy', skipped?: string }}
 */
export async function ensureBookingPage(hostId, { page = DEFAULT_PAGE, timeZone } = {}) {
  const existing = await listRawSchedulesForHost(hostId);
  const usable = existing.find(isBookable);
  if (usable) return { created: false, schedule: usable };

  const rule = await findAvailabilityRule(hostId);
  if (!rule) {
    return {
      created: false,
      schedule: null,
      skipped:
        'no availability rule found — the user has a Scheduler profile but no working hours set',
    };
  }

  try {
    const created = await zoomFetch('/scheduler/schedules', {
      method: 'POST',
      query: { user_id: userId },
      body: buildBody({ rule, page, timeZone }),
      idempotent: false,
    });
    return { created: true, schedule: created };
  } catch (err) {
    throw new AppError(ErrorCode.CONFIG_ERROR, 'Could not create a booking page.', {
      status: 500,
      detail: `${err.detail ?? err.message} — see buildBody() for the shape Zoom accepts.`,
      cause: err,
    });
  }
}

/**
 * Ensure every Scheduler-eligible host has a booking page.
 * Sequential on purpose: these are writes, and a burst risks rate limiting.
 */
export async function ensureBookingPagesForHosts(hosts, opts = {}) {
  const results = [];
  for (const host of hosts) {
    try {
      const result = await ensureBookingPage(host.userId, opts);
      results.push({ email: host.email, userId: host.userId, ...result });
    } catch (err) {
      results.push({
        email: host.email,
        userId: host.userId,
        created: false,
        schedule: null,
        error: err.detail ?? err.message,
      });
    }
  }
  return results;
}
