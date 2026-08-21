import { Router } from 'express';

import { config } from '../config.js';
import { listHosts, toHostDto, resolveSchedule, invalidateScheduleCache } from '../zoom/schedules.js';
import { getAvailableTimes, flattenSlots } from '../zoom/availability.js';
import { listConnectedHosts } from '../zoom/tokenStore.js';
import { ensureBookingPagesForHosts } from '../zoom/provisioning.js';
import { AppError, ErrorCode } from '../errors.js';

export const hostsRouter = Router();

/**
 * Resolve a booking page to the host whose token owns it.
 *
 * Accepts either the slug or the schedule_id — both resolve, and access is
 * decided by ownership. Backed by a short-lived cache so this does not fan out
 * across every connected host on each request.
 */
async function findHost(identifier) {
  const match = await resolveSchedule(listConnectedHosts(), identifier);
  if (!match) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That booking page is not available.', {
      status: 404,
      detail: `No connected host owns a schedule with slug or id "${identifier}".`,
    });
  }
  return match;
}

/** Step 1 — the host picker's data source, across every connected host. */
hostsRouter.get('/hosts', async (req, res, next) => {
  try {
    const connected = listConnectedHosts();
    let hosts = await listHosts(connected);

    // A freshly connected host often has a Scheduler profile but no booking
    // page, which makes this endpoint return an empty list that looks like a
    // bug. Opt in with AUTO_PROVISION_BOOKING_PAGES=true to create one.
    if (hosts.length === 0 && config.demo.autoProvisionBookingPages && connected.length) {
      const provisioned = await ensureBookingPagesForHosts(connected);
      console.log('[provision]', JSON.stringify(provisioned.map((p) => ({
        email: p.email, created: p.created, error: p.error, skipped: p.skipped,
      }))));
      hosts = await listHosts(connected);
    }

    res.json({
      hosts,
      ...(connected.length ? {} : { hint: 'No hosts have connected yet. Visit /api/auth/connect.' }),
    });
  } catch (err) {
    next(err);
  }
});

/** Step 1 detail — includes custom_fields, which the booking form renders. */
hostsRouter.get('/hosts/:scheduleSlug', async (req, res, next) => {
  try {
    const known = await findHost(req.params.scheduleSlug);
    res.json({ host: { ...toHostDto(known.schedule), ownerUserId: known.hostId } });
  } catch (err) {
    next(err);
  }
});

/** Step 2 — available slots. */
hostsRouter.get('/hosts/:scheduleSlug/slots', async (req, res, next) => {
  try {
    const known = await findHost(req.params.scheduleSlug);

    const now = new Date();
    const from = req.query.from ?? now.toISOString();
    const to =
      req.query.to ??
      new Date(now.getTime() + config.demo.bookingWindowDays * 86_400_000).toISOString();
    const timeZone =
      req.query.timeZone ?? known.schedule.time_zone ?? config.demo.defaultTimeZone;

    // rawSchedule is already in hand — passing it avoids a redundant fetch.
    const { response } = await getAvailableTimes(known.hostId, known.schedule.slug, {
      from,
      to,
      timeZone,
      rawSchedule: known.schedule,
    });

    res.json({ ...flattenSlots(response), range: { from, to, timeZone } });
  } catch (err) {
    next(err);
  }
});
