# Working notes for this repo

## Hard rules

1. **Zoom's published spec is unreliable here.** Verify endpoints against the live API Hub
   JSON before using them, and read `docs/api-validation.md` first — it records roughly a
   dozen places where the spec is wrong. Where they disagree, the doc wins.
2. **Never expose a Zoom token to the browser.** The frontend talks only to this Express API.
3. **Every Zoom call acts as a connected host.** `zoomFetch` requires a `hostId` and throws
   without one. There is no ambient account credential.
4. **Never auto-retry the booking POST.** A timed-out create may already have succeeded;
   retrying double-books the host. `idempotent: false` marks these calls.
5. **Persist refresh tokens before returning.** Zoom refresh tokens are single use — each
   refresh invalidates the previous one, so losing the write locks the host out for good.
6. **The API has no authentication.** The Marketplace app is unlisted, so only users in the
   creating account can *connect* a Zoom account — but that does not gate HTTP access. Every
   route is reachable by any caller, including `DELETE /api/auth/hosts/:userId` and
   `DELETE /api/bookings/:meetingId`, and the caller presents no Zoom credential. Fine on
   localhost, not behind a tunnel. See the Security section of README.md; do not add operator
   or destructive routes without raising this.

## Architecture

Availability from Zoom Scheduler; booking through the Meetings API; the busy block written
explicitly to the Zoom Calendar. `POST /scheduler/attendee` is broken and is not used.
Creating a meeting does **not** add it to the calendar, and Scheduler reads the calendar to
compute availability — so skipping the calendar write silently causes double-booking.

Auth is user-level OAuth. Server-to-Server cannot do this; don't re-litigate it without
reading the S2S section of `docs/api-validation.md` and running `npm run probe:s2s`.

## Layout

```
server/src/zoom/     oauth · tokenStore · tokens · client · schedules
                     availability · meetings · calendar · bookings · provisioning · users
server/src/routes/   auth · health · hosts · bookings
server/scripts/      smoke.js (live end-to-end) · probe-s2s.js (why S2S was rejected)
```

`client.js` is the only module that talks to `api.zoom.us`. Error codes live in `errors.js`
as a closed set; the frontend switches on `code`, never on status or message text.

## Gotchas that have already cost time

- Scheduler path params take the booking page **`slug`**, not `schedule_id`.
- Slot `start_time` is offset-bearing, never `Z`.
- `node --check` validates syntax but **not** exports — a stale re-export passes the check
  and fails at runtime. Verify by importing: `node --input-type=module -e "await import('./f.js')"`.
- The token store is anchored to the repo root, not `cwd`; scripts run from different
  directories and would otherwise read different files.
- Users with `login_types` containing `99` are API-created and can never use Scheduler.

## Testing

`npm run smoke` is read-only. `npm run smoke -- --book --cleanup` books a real slot and
cancels it — it emails the invitee, so it is opt-in by design. Keep it that way.
