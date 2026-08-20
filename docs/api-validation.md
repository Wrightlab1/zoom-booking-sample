# Zoom API validation

Every claim here was verified against a live Zoom account on **2026-08-20**, and against the
API Hub OpenAPI documents:

- <https://developers.zoom.us/api-hub/scheduler/methods/endpoints.json>
- <https://developers.zoom.us/api-hub/calendar/methods/endpoints.json>

Several findings **contradict Zoom's published specification**. Where they conflict, this
document is what the code follows. Re-verify before assuming any of it has changed.

---

## The architecture, and why it looks odd

```
1. Select a host      GET  /scheduler/schedules                    (Scheduler)
2. Available slots    GET  /scheduler/schedules/{slug}/available_times
3a. Book              POST /users/me/meetings                      (Meetings API)
3b. Block the slot    POST /calendars/{calendarId}/events          (Calendar API)
```

Step 3 does **not** use Zoom Scheduler's own booking endpoint, and step 3b is not optional.
Both surprises are explained below.

Auth is **user-level OAuth (authorization_code)**. Server-to-Server OAuth cannot run this
workflow — see [Why not Server-to-Server](#why-not-server-to-server-oauth).

---

## Findings that contradict the spec

### 1. Path parameters want the `slug`, not `schedule_id`

`GET /scheduler/schedules/{id}` and `.../{id}/available_times` both return **404** when given
the `schedule_id` that the list endpoint returns. They resolve the booking page's `slug`.

```
GET /scheduler/schedules/ne8cow8bxtzdlk6k1ea6wzdac0/available_times  → 404
GET /scheduler/schedules/sample-app-demo/available_times             → 200, 10 days, 160 slots
```

The spec documents the parameter as *"scheduleId — The unique identifier of the schedule"*.
Slugs must also be **unique per host**: two hosts sharing a slug is ambiguous and the lookup
silently resolves to one of them.

### 2. `POST /scheduler/attendee` is unusable

Every payload returns `400 "Failed json validation!"` with no field detail — including an
empty `{}` body, which should instead name a missing required field. Tried and rejected:

- the documented snake_case shape, with `kind` as both `"zoom"` and `"zoomMeeting"`
- the exact camelCase payload Zoom's own booking page sends (`appointmentId`,
  `start:{dateTime,timeZone}`, `locationConfiguration`, `customValues`, `guests`, `tracking`),
  byte-for-byte **including a live `recaptchaToken`**
- under **both** Server-to-Server and user-level OAuth

The browser payload succeeds in a browser because it goes to the Scheduler web app's own
backend, not `api.zoom.us/v2`. Two further signs the endpoint is broken rather than merely
undocumented: a **garbage `user` slug is accepted identically to a valid one**, and the
documented `user=t/<slug>` format returns `Invalid user` while the bare slug does not.

**This is why booking goes through the Meetings API instead.**

### 3. Creating a meeting does NOT put it on the Zoom Calendar

Zoom accepts `settings.push_change_to_calendar: true` and silently stores `false`
(`calendar_type: 1` *is* honoured). No calendar event appears.

This matters because **Scheduler computes availability from the host's Zoom Calendar**.
Verified in both directions:

| Action | Slots |
|---|---|
| baseline | 16 |
| write a calendar event at an open slot | 15 — that slot gone |
| delete the event | 16 — restored |

So a meeting created without an explicit calendar event leaves the slot bookable by the next
visitor. Confirmed live: the first booking run returned a join URL while the slot was *still
offered*. The app therefore writes the calendar event itself, and **cancellation must delete
both** or the slot stays blocked forever. Events are tagged
`zoom-booking-sample:meeting:<id>` in the description so they can be found later.

### 4. `POST /scheduler/schedules` — the required list is fiction

The spec declares `required: [availability_override, availability_rules, capacity, end,
start, type]`, but `end`, `start` and `type` **do not exist in its own `properties`** (which
define `start_date`, `end_date`, `schedule_type`). Everything plausible returns
`400 Failed json validation!`. What actually works:

- `availability_override: true` with **inline** `segments_recurrence` — a saved
  `availability_rules: [{availability_id}]` reference is rejected even with a valid id
  belonging to that same user
- `interval_type: "fixed"` plus **both** `start_date`/`end_date` **and** `start`/`end`.
  Omitting the dates gives `400 Miss time fields.` — it means the dates, not the times
- the legacy `type: "one"` alias alongside `schedule_type`

### 5. Smaller traps

| Trap | Reality |
|---|---|
| `GET /scheduler/availability` | Recurring weekly **working-hours rules**, not bookable slots. Does not subtract bookings, buffers, cushion or limits. Use `available_times`. |
| Slot `start_time` | Always offset-bearing, never `Z`. The offset follows the `time_zone` query param (`-04:00` for New York), else the host's zone (`-06:00` for Denver). |
| Error shape | Scheduler returns `{error:{message, errors:[…]}}`; most Zoom APIs return flat `{code, message}`. Reading only the flat shape yields `[object Object]`. |
| `questions_and_answers` | Matched by exact question **text**, case-sensitively — not `custom_field_id`. |
| `custom_fields.format` | Description lists `single_select`/`multi_select`; the actual enum is `text, string, phone_number, choices_one, choices_many, select`. |
| `account_level=true` | Does not aggregate. Returns empty `items` even when schedules exist. |
| `login_types` contains `99` | An API-created (`custCreate`) user. No password, cannot sign in, so Scheduler never provisions a profile — every `/scheduler/*` call returns `403 "User Not Found"`. Their Zoom `type` is still `2` (Licensed), identical to a real user. |
| `search_by_unique_id=true` on `GET /users/{id}` | Treats the path segment as an employee id, so a Zoom user id 404s. |
| Marketplace-initiated install | Returns `code` with **no `state`**. A callback demanding both rejects it. |
| Zoom refresh tokens | **Single use.** Each refresh returns a new one and invalidates the old. Fail to persist it and the host is locked out permanently. |

---

## Why not Server-to-Server OAuth

S2S was the original design and was tested exhaustively before being abandoned.

| Capability, for a user **other than** the token owner | S2S |
|---|---|
| List booking pages + working hours (`?user_id=`) | ✅ full object incl. `segments_recurrence` |
| `available_times` | ❌ 404 always — no scope fixes it |
| Create a meeting owned by them | ✅ with `meeting:write:meeting:admin` |
| `freeBusy` / write calendar event, **given** the calendar id | ✅ granular `:admin` scopes suffice |
| **Discover** their calendar id | ❌ no admin-reachable route exists |

The chain breaks at discovery:

- Calendar ids are Zoom **Mail** addresses (`someone@zmail.com`), not the Zoom login
  email. Passing the login email to `freeBusy` returns a bare `notFound`.
- `GET /calendars/users/{id}/calendarList` is admin-reachable **only** through the classic
  scope `calendar:read:admin`, retired with the move to granular scopes. The granular
  `calendar:read:list_calendar_lists` has **no `:admin` variant**.
- The Mail API cannot help — every endpoint is keyed by `{email}`, the value being sought.
- `GET /users/{id}` exposes only `email` (login) and `jid` (XMPP). Not the calendar address.

There is also a general asymmetry worth knowing: **list endpoints honour `user_id`;
single-resource `/scheduler/{resource}/{id}` lookups ignore it** and resolve only within the
token owner's account. `GET /scheduler/availability/{availabilityId}` 404s for ids the list
endpoint returned seconds earlier.

**Decision rule.** Both architectures need a one-time per-host step — S2S needs an admin to
supply each calendar id, OAuth needs one consent click. Equal cost, so OAuth wins: it also
yields Zoom's own availability computation rather than a reimplementation that can drift
(`cushion`/minimum-notice was absent from the cross-user schedule object).

`server/scripts/probe-s2s.js` reproduces this whole assessment.

---

## Concurrency

**There is no hold or reservation API.** Nothing reserves a slot between rendering it and
booking it. The app re-checks availability immediately before creating the meeting, which
shrinks the race window but cannot close it. Treat a lost race as a normal outcome, not an
error, and never auto-retry the booking POST — a timed-out create may already have succeeded.
