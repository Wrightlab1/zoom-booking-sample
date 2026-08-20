import { Router } from 'express';

import { config } from '../config.js';
import { listHosts } from '../zoom/schedules.js';
import { listConnectedHosts } from '../zoom/tokenStore.js';
import { createBooking, getBookingConfirmation, cancelBooking } from '../zoom/bookings.js';
import { AppError, ErrorCode } from '../errors.js';

export const bookingsRouter = Router();

/** Step 3 — book. Both Zoom calls collapse into one response for the client. */
bookingsRouter.post('/bookings', async (req, res, next) => {
  try {
    const { scheduleSlug, startDateTime, durationMinutes, timeZone, booker, answers } =
      req.body ?? {};

    const hosts = await listHosts(listConnectedHosts());
    const host = hosts.find((h) => h.slug === scheduleSlug || h.scheduleId === scheduleSlug);
    if (!host) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That booking page is not available.', {
        status: 404,
        detail: `No connected host owns "${scheduleSlug}".`,
      });
    }

    const { dto } = await createBooking({
      hostId: host.ownerUserId,
      scheduleSlug: host.slug,
      scheduleId: host.scheduleId,
      startDateTime,
      durationMinutes: durationMinutes ?? host.durationMinutes,
      timeZone: timeZone ?? host.timeZone ?? config.demo.defaultTimeZone,
      booker,
      answers,
    });

    res.status(201).json({ booking: dto });
  } catch (err) {
    next(err);
  }
});

/** Retry path for PARTIAL_SUCCESS, and the confirmation deep-link. */
bookingsRouter.get('/bookings/:meetingId', async (req, res, next) => {
  try {
    const hostId = req.query.hostId;
    if (!hostId) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Missing host.', {
        status: 400,
        detail:
          'Pass ?hostId=<zoom user id>. Meetings resolve only under the owning host\'s token.',
      });
    }
    const { dto } = await getBookingConfirmation(String(hostId), req.params.meetingId);
    res.json({ booking: dto });
  } catch (err) {
    next(err);
  }
});

bookingsRouter.delete('/bookings/:meetingId', async (req, res, next) => {
  try {
    const hostId = req.query.hostId;
    if (!hostId) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Missing host.', {
        status: 400,
        detail: 'Pass ?hostId=<zoom user id>.',
      });
    }
    await cancelBooking(String(hostId), req.params.meetingId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
