/**
 * Step 1 — select a meeting host.
 *
 * In Zoom Scheduler a host is reached through their *schedule* (booking page),
 * not through a Zoom user ID. Listing schedules and reading `organizer` is how
 * we build the host picker.
 */

import { config } from '../config.js';
import { zoomFetch } from './client.js';

/** A schedule is bookable-as-a-Zoom-meeting only if all of these hold. */
export function isBookable(schedule) {
  return (
    schedule?.active === true &&
    schedule?.status === 'confirmed' &&
    schedule?.add_on_type === 'zoomMeeting'
  );
}

/** Trim Zoom's schedule object down to what a booking UI actually needs. */
export function toHostDto(schedule) {
  return {
    scheduleId: schedule.schedule_id,
    // Either identifier works on path-based Scheduler endpoints; the slug is
    // preferred here because it is stable and readable.
    slug: schedule.slug ?? null,
    title: schedule.summary,
    description: schedule.description || null,
    durationMinutes: schedule.duration,
    scheduleType: schedule.schedule_type, // 'one' | 'multiple'
    host: {
      displayName: schedule.organizer?.display_name ?? schedule.creator?.display_name ?? null,
      email: schedule.organizer?.email ?? schedule.creator?.email ?? schedule._ownerEmail ?? null,
    },
    timeZone: schedule.time_zone ?? null,
    capacity: schedule.capacity ?? 1,
    slotIncrementMinutes: schedule.start_time_increment ?? null,
    minimumNoticeMinutes: schedule.cushion ?? 0,
    schedulingUrl: schedule.scheduling_url ?? null,
    ownerUserId: schedule._ownerUserId ?? null,
    // Questions the booking form must render, ordered as the host arranged them.
    customFields: (schedule.custom_fields ?? [])
      .filter((f) => f.enabled)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((f) => ({
        id: f.custom_field_id,
        // NOTE: the booking payload matches answers by this exact string,
        // case-sensitively — not by id. Carry it through the form verbatim.
        question: f.name,
        format: f.format,
        required: f.required,
        includeOther: f.include_other,
        position: f.position,
        choices: f.answer_choices ?? [],
      })),
  };
}

/**
 * GET /scheduler/schedules for ONE user.
 *
 * ── Verified behaviour, 2026-08-20 ──
 * Under a Server-to-Server token `account_level=true` returned an empty `items`
 * array even when schedules existed. Under user-level OAuth we act AS the host,
 * so no scoping parameter is needed at all — the token itself is the scope.
 */
export async function listRawSchedulesForHost(hostId, { pageSize = 100 } = {}) {
  const items = [];
  let nextPageToken;

  do {
    const page = await zoomFetch('/scheduler/schedules', {
      hostId,
      query: { page_size: pageSize, next_page_token: nextPageToken },
    });
    items.push(...(page?.items ?? []));
    nextPageToken = page?.next_page_token || undefined;
  } while (nextPageToken);

  return items;
}

/**
 * Every booking page across all connected hosts.
 *
 * One request per host, each with that host's own token. A host whose tokens
 * have expired is reported rather than failing the whole list — one stale
 * connection must not blank out the picker.
 *
 * @param {Array<{userId: string, email: string}>} hosts connected hosts
 */
export async function listRawSchedules(hosts) {
  const perHost = await Promise.all(
    hosts.map(async (h) => {
      try {
        const items = await listRawSchedulesForHost(h.userId);
        return items.map((s) => ({ ...s, _ownerUserId: h.userId, _ownerEmail: h.email }));
      } catch (err) {
        console.error(`[schedules] ${h.email}: ${err.code ?? 'ERROR'} — ${err.detail ?? err.message}`);
        return [];
      }
    })
  );
  return perHost.flat();
}

/** Bookable hosts, shaped for the frontend. */
export async function listHosts(hosts) {
  const allowlist = config.demo.allowedScheduleIds;
  const raw = await listRawSchedules(hosts);

  return raw
    .filter(isBookable)
    .filter((s) => allowlist.length === 0 || allowlist.includes(s.schedule_id))
    .map(toHostDto);
}

/**
 * GET /scheduler/schedules/{slug}
 *
 * ── Verified behaviour, 2026-08-21 ──
 * The path parameter accepts EITHER the `slug` or the `schedule_id`. What decides
 * the outcome is ownership: a page belonging to another user 404s under both
 * forms. That is precisely why this app uses user-level OAuth — pass the hostId
 * whose token owns the page.
 *
 * The slug is used throughout because it is stable and human-readable, not
 * because the id is rejected. Slugs must be unique per host: a shared slug
 * silently resolves to one host's page.
 */
export async function getSchedule(hostId, scheduleSlug) {
  return zoomFetch(`/scheduler/schedules/${encodeURIComponent(scheduleSlug)}`, { hostId });
}

/**
 * Slug/id → { hostId, raw schedule } resolution, cached briefly.
 *
 * Mapping a booking page to the host whose token owns it otherwise costs one
 * `/scheduler/schedules` call per connected host on EVERY request — N+2 upstream
 * calls to answer one visitor picking a date.
 *
 * Only the mapping is cached. Availability is never cached: it is the one thing
 * that must be live, since a stale slot is a double-booking.
 */
const RESOLVE_TTL_MS = 60_000;
let resolveCache = { at: 0, bySlug: new Map(), byId: new Map() };

export function invalidateScheduleCache() {
  resolveCache = { at: 0, bySlug: new Map(), byId: new Map() };
}

export async function resolveSchedule(hosts, identifier, { force = false } = {}) {
  const stale = Date.now() - resolveCache.at > RESOLVE_TTL_MS;

  if (force || stale || (!resolveCache.bySlug.has(identifier) && !resolveCache.byId.has(identifier))) {
    const raw = await listRawSchedules(hosts);
    const bySlug = new Map();
    const byId = new Map();
    for (const schedule of raw.filter(isBookable)) {
      const entry = { hostId: schedule._ownerUserId, email: schedule._ownerEmail, schedule };
      if (schedule.slug) bySlug.set(schedule.slug, entry);
      if (schedule.schedule_id) byId.set(schedule.schedule_id, entry);
    }
    resolveCache = { at: Date.now(), bySlug, byId };
  }

  return resolveCache.bySlug.get(identifier) ?? resolveCache.byId.get(identifier) ?? null;
}
