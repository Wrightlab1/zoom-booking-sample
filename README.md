# Zoom booking sample

A complete calendar-and-booking flow on the Zoom platform: pick a host, see their real
availability, book a meeting the host owns, get a join URL.

```
1. Select a host   →   2. Choose a time   →   3. Book
```

React (Vite) frontend, Node.js + Express backend, user-level Zoom OAuth. The browser never
sees a Zoom token — every Zoom call is server-side.

This README is written to be **read as well as run**. Two of the three steps use an endpoint
other than the obvious one, and one step makes an extra API call that looks redundant and
isn't. Each is explained below with the evidence. The full findings live in
[`docs/api-validation.md`](docs/api-validation.md).

---

## The three steps

### Step 1 — Select a host

**Endpoint:** `GET /scheduler/schedules`

In Zoom Scheduler a host is reached through their **booking page** ("event type"), not
directly through a Zoom user. Listing schedules and reading `organizer` is what builds the
picker.

**Why not `GET /scheduler/users/{userId}`?** It returns a Scheduler *profile* — slug,
scheduling URL, timezone — but not the bookable pages. A user can have a profile and zero
booking pages, in which case `/scheduler/schedules` correctly returns `{"items": []}` with
HTTP 200. That empty-but-successful response looks exactly like a permissions failure and
cost real debugging time; `GET /api/health/scheduler-readiness` exists to tell the two apart.

**Why no `account_level=true`?** It does not aggregate. It returns an empty array even when
schedules demonstrably exist. Under user-level OAuth the token *is* the scope, so we make one
request per connected host and merge.

**Code path**

| | |
|---|---|
| Route | [`routes/hosts.js:26`](server/src/routes/hosts.js#L26) — `GET /api/hosts` |
| Fan-out | `listRawSchedules()` in [`zoom/schedules.js`](server/src/zoom/schedules.js) — one call per host, a failed host is logged not fatal |
| Per host | [`zoom/schedules.js:106`](server/src/zoom/schedules.js#L106) — `listRawSchedulesForHost()` |
| Filter | [`zoom/schedules.js:44`](server/src/zoom/schedules.js#L44) — `isBookable()`: `active && status==='confirmed' && add_on_type==='zoomMeeting'` |
| Shape | [`zoom/schedules.js:53`](server/src/zoom/schedules.js#L53) — `toHostDto()`, incl. `customFields` for the form |
| UI | [`web/src/components/HostPicker.jsx`](web/src/components/HostPicker.jsx) |

---

### Step 2 — Return available slots

**Endpoint:** `GET /scheduler/schedules/{slug}/available_times`

One call returns bookable spots with buffers, minimum notice, and daily limits already
applied. This is Zoom's own availability computation, and using it is the main reason to
integrate with Scheduler at all.

**Why not `GET /scheduler/availability`?** Despite the name it returns recurring **weekly
working-hours rules** (`segments_recurrence` keyed by weekday) for configuring a host's hours.
It does not subtract existing bookings. Slots generated from it will collide with real
meetings. This is the single easiest mistake to make in the whole integration.

**Identify the page by `slug` or by `schedule_id` — both work.** What actually governs access
is **ownership**: the booking page must belong to the user whose token you are using.

```
owner's schedule,     by schedule_id → 200
owner's schedule,     by slug        → 200
another user's page,  by schedule_id → 404
another user's page,  by slug        → 404
```

An earlier version of this document claimed the endpoint required the slug and rejected
`schedule_id`. That was wrong, and the mistake is instructive: the original test used a
non-owner's `schedule_id` (404) against a slug that several hosts shared, and the slug lookup
silently resolved to the *token owner's* own page (200). A name collision masked an ownership
failure. If slugs are not unique per host, a lookup can quietly return someone else's schedule
— which is why `ensureBookingPage()` gives each host a distinct slug.

**Round `from` up to the schedule's increment.** Zoom anchors *every* returned slot to the
`from` timestamp rather than snapping to the schedule's own grid, so `from = new Date()`
yields `11:49, 12:19, 13:49…` across the entire response — not just a ragged first entry.

**Code path**

| | |
|---|---|
| Route | `GET /api/hosts/:scheduleSlug/slots` in [`routes/hosts.js`](server/src/routes/hosts.js) — resolves slug→host from a 60s cache |
| Alignment | [`zoom/availability.js:26`](server/src/zoom/availability.js#L26) — `roundUpToIncrement()` |
| Fetch | [`zoom/availability.js:66`](server/src/zoom/availability.js#L66) — `getAvailableTimes()` |
| Flatten | [`zoom/availability.js:105`](server/src/zoom/availability.js#L105) — `flattenSlots()`, keeps only `status === 'available'`; the response's `duration` wins over the schedule's |
| UI | [`web/src/components/SlotGrid.jsx`](web/src/components/SlotGrid.jsx) |

---

### Step 3 — Book the meeting

**Endpoints:** `POST /users/me/meetings`, then `POST /calendars/{calendarId}/events`

**Why not `POST /scheduler/attendee`?** Because it does not work. Every payload returns
`400 "Failed json validation!"` with no field detail — including an empty `{}` body, which a
real schema validator would answer by naming a missing field. Ruled out by testing:

- the documented snake_case shape, with `kind` as both `"zoom"` and `"zoomMeeting"`
- the exact camelCase payload Zoom's own booking page sends, byte-for-byte, **including a
  live `recaptchaToken`**
- under **both** Server-to-Server and user-level OAuth

The browser payload works in a browser because it goes to the Scheduler web app's own
backend, not `api.zoom.us/v2`. Two further signs the endpoint is broken rather than merely
undocumented: a garbage `user` slug is accepted identically to a valid one, and the
documented `user=t/<slug>` form returns `Invalid user` while the bare slug does not.

`POST /users/me/meetings` is also simply better: it returns `join_url` in **one** call, where
the Scheduler flow needed two, and `me` resolves to the connected host so they own the meeting
by construction.

**Why the second call?** Because **creating a meeting does not put it on the Zoom Calendar**,
and Scheduler computes availability *from* that calendar. Zoom accepts
`settings.push_change_to_calendar: true` and silently stores `false` (`calendar_type: 1` *is*
honoured). Verified in both directions:

| Action | Slots offered |
|---|---|
| baseline | 16 |
| write a calendar event at an open slot | 15 — that slot gone |
| delete the event | 16 — restored |

Without the explicit calendar write, the first live booking returned a join URL while the slot
was **still on offer** — a silent double-booking bug. So the app writes the busy block itself.
Cancellation must remove **both**, or the slot stays blocked forever after the meeting is gone.

**Code path**

| | |
|---|---|
| Route | [`routes/bookings.js:12`](server/src/routes/bookings.js#L12) — `POST /api/bookings` |
| Orchestration | [`zoom/bookings.js:68`](server/src/zoom/bookings.js#L68) — `createBooking()` |
| Race guard | [`zoom/bookings.js:34`](server/src/zoom/bookings.js#L34) — `assertSlotStillFree()`, re-checks immediately before writing |
| Meeting | [`zoom/meetings.js:72`](server/src/zoom/meetings.js#L72) — `createMeetingForSlot()` |
| Busy block | [`zoom/calendar.js:40`](server/src/zoom/calendar.js#L40) — `createEventForMeeting()`, tags the description `zoom-booking-sample:meeting:<id>` so it can be found later |
| Cancel both | [`zoom/bookings.js:158`](server/src/zoom/bookings.js#L158) — `cancelBooking()` |
| UI | [`web/src/components/BookingForm.jsx`](web/src/components/BookingForm.jsx), [`Confirmation.jsx`](web/src/components/Confirmation.jsx) |

A calendar-write failure is a **warning, not a failure**: the meeting is real and the invitee
has a join URL. It surfaces as `PARTIAL_SUCCESS` so the UI can say "booked, with a caveat".

---

## Authentication

**User-level OAuth (`authorization_code`).** Server-to-Server cannot run this workflow.

| Capability, for a user **other than** the token owner | S2S |
|---|---|
| List booking pages + working hours | ✅ |
| `available_times` | ❌ 404 always — no scope fixes it |
| Create a meeting owned by them | ✅ |
| `freeBusy` / write calendar event, **given** the calendar id | ✅ |
| **Discover** their calendar id | ❌ no admin-reachable route exists |

Calendar ids are Zoom **Mail** addresses (`someone@zmail.com`), not the Zoom login email.
`calendarList` is admin-reachable only via the classic scope `calendar:read:admin`, retired
with the move to granular scopes; the granular equivalent has no `:admin` variant. The Mail
API cannot help — every endpoint is keyed by the address being sought.

Both architectures need a one-time per-host step (S2S: an admin supplies each calendar id;
OAuth: one consent click). Equal cost — so OAuth wins, because it also yields Zoom's own
availability computation instead of a reimplementation that can drift.

Reproduce the assessment with `npm run probe:s2s`.

**Token handling.** Zoom refresh tokens are **single use**: every refresh returns a new one and
invalidates the old. [`zoom/tokens.js:25`](server/src/zoom/tokens.js#L25) persists the new
token *before* returning an access token — losing that write locks the host out permanently.
Tokens are encrypted at rest with AES-256-GCM in
[`zoom/tokenStore.js`](server/src/zoom/tokenStore.js).

---

## Marketplace app setup

Create a **General App** (Marketplace → Develop → Build App → General App). Not
Server-to-Server, for the reasons above.

**1. Redirect URL.** Set the OAuth Redirect URL and add it to the OAuth allow list. It must
**byte-match** `ZOOM_REDIRECT_URI`. A tunnel (ngrok) is fine; the callback is served from both
`/` and `/api/auth/callback`, so either registration form works —
[`routes/auth.js:38`](server/src/routes/auth.js#L38).

**2. Create the app.** Either click through the Marketplace UI, or use the checked-in
manifest — see [Creating the app from the manifest](#creating-the-app-from-the-manifest) below.

**3. Scopes.** All 13 are user-level — no `:admin`. The app acts *as* the host, so it needs no
account-wide privilege. Kept in sync in
[`config.js`](server/src/config.js) as `REQUIRED_SCOPES`.

| Scope | Used for |
|---|---|
| `user:read:user` | Identify who just connected |
| `scheduler:read:user` | Their Scheduler profile and slug |
| `scheduler:read:list_schedule` | Step 1 — list booking pages |
| `scheduler:read:get_schedule` | Step 2 — `available_times` **and** schedule detail |
| `scheduler:read:list_availability` | Provisioning reads working hours |
| `scheduler:write:insert_schedule` | Provisioning creates a booking page |
| `meeting:write:meeting` | Step 3 — create the meeting |
| `meeting:read:meeting` | Confirmation lookups |
| `meeting:delete:meeting` | Cancellation |
| `calendar:read:list_calendar_lists` | Find the host's primary calendar |
| `calendar:read:list_events` | Verify the slot got blocked |
| `calendar:write:event` | Step 3 — write the busy block |
| `calendar:delete:event` | Remove it on cancel |

No `scheduler:*:scheduled_event` scopes are requested: step 3 uses the Meetings API, so the app
never touches a Scheduler "scheduled event" and should not hold the permission.

If the consent screen grants fewer than requested, `GET /api/health/scheduler-readiness`
reports exactly which are missing per host.

**4. Each host needs a booking page** in Zoom Scheduler with its location set to **Zoom
Meeting** (`add_on_type: "zoomMeeting"`). Set `AUTO_PROVISION_BOOKING_PAGES=true` to have the
app create one — [`zoom/provisioning.js`](server/src/zoom/provisioning.js). Slugs must be
unique per host; two hosts sharing a slug is ambiguous and resolves to one of them silently.

---

## Creating the app from the manifest

`manifest/app-manifest.json` is a complete, **validated** Zoom app manifest for this project.
It is checked in, but it is **generated** — `oauth_information.scopes` comes from
`REQUIRED_SCOPES` in [`server/src/config.js`](server/src/config.js), so the app's scopes can
never drift from what the code actually calls. Regenerate rather than hand-editing:

```bash
npm run app:manifest      # regenerate manifest/app-manifest.json and print a summary
npm run app:validate      # check it against Zoom (does NOT create anything)
npm run app:create        # validate, then create the app
```

The committed copy is environment-neutral (`http://localhost:3001/api/auth/callback`). Note that
`app:validate` and `app:create` load `.env` and rewrite the file with *your* redirect URI — check
`git diff manifest/` before committing after running either, and regenerate with
`node server/scripts/create-app.js` to restore the neutral form.

The redirect URI, app name, and contact fields come from the environment, so the same manifest
serves every developer:

| Variable | Fills |
|---|---|
| `ZOOM_REDIRECT_URI` | `development_redirect_uri`, `production_redirect_uri`, and the `oauth_allow_list` origin |
| `APP_NAME` | `display_name` (default: `Zoom Booking Sample`) |
| `APP_CONTACT_NAME`, `APP_CONTACT_EMAIL`, `APP_COMPANY_NAME` | Create-request fields Zoom requires |

### Doing it with curl

The scripts wrap two calls. To run them yourself:

```bash
# 1. Validate — note this returns HTTP 200 even when the manifest is INVALID
curl https://api.zoom.us/v2/marketplace/apps/manifest/validate \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  --data "{\"manifest\": $(cat manifest/app-manifest.json)}"

# 2. Create
curl https://api.zoom.us/v2/marketplace/apps \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  --data "{
    \"app_type\": \"general\",
    \"app_name\": \"Zoom Booking Sample\",
    \"contact_name\": \"Your Name\",
    \"contact_email\": \"you@example.com\",
    \"company_name\": \"Your Co\",
    \"manifest\": $(cat manifest/app-manifest.json)
  }"
```

### Four things that will bite you

**`app_type` must be `"general"`.** `"s2s_oauth"` is a different creation surface — it posts to
`/v2/accounts/{accountId}/marketplace/apps`, needs a master-authorized scope, and takes
top-level `scopes` with **no** `manifest`. It also cannot do user-level OAuth, which this
workflow requires.

**Validation returns HTTP 200 for invalid manifests.** The body is the verdict:

```json
{"ok": true,  "errors": null, "error": ""}
{"ok": false, "errors": [{"setting": "...", "message": "..."}], "error": "invalid_manifest"}
```

`npm run app:validate` reads the body and exits non-zero on failure. A bare `curl` that only
checks the status code will happily report success on a broken manifest.

**The bootstrap app is a different app.** Validating needs `marketplace:read:app`, creating
needs `marketplace:write:app` (either accepts the `:admin` form). Neither belongs on the app
being created. `npm run app:validate` uses whichever configured app has them — the `ZOOM_S2S_*`
app or a connected OAuth host — and names exactly which scope is missing where.

**Adding a scope behaves differently per app type.** A Server-to-Server app picks up a newly
added scope on its next token grant. A General app does not: the stored token keeps whatever
was granted at consent time, so the user must re-authorise before the new scope exists. If a
scope you just added appears missing, that is usually why.

### Undocumented enum values

Probed against the validator on 2026-08-20, because the schema docs do not list them:

| Field | Accepted |
|---|---|
| `display_information.install_type` | `LANDING_PAGE`, `APP_DIRECTORY` only. `LANDING_PAGE` additionally requires `install_landing_url`. |
| `display_information.business_lines` | `marketing`, `humanResources`, `engineering`, `finance`, `other`. `productivity` and `sales` are **rejected**. |

The manifest uses `APP_DIRECTORY` with `discover_type: "UNLISTED"`, which keeps the app private
to the account that creates it.

### After creating

The create response returns `app_id`, and often `development_credentials` containing the client
ID and secret — put those in `.env` as `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`. If they are
absent, read them from the app's Marketplace page.

Then fetch what Zoom actually stored:

```bash
curl "https://api.zoom.us/v2/marketplace/apps/$APP_ID/manifest" \
  --header "Authorization: Bearer $BOOTSTRAP_TOKEN"
```

Zoom silently drops fields it does not accept, so the persisted manifest — not the one you
sent — is the source of truth for what the app can do.

A newly created app has no consent from anyone. Each host must authorise against the **new**
client ID at `/api/auth/connect` before `/api/hosts` returns anything.

---

## Running it

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY

npm install
npm run dev                                     # API on :3001
open http://localhost:3001/api/auth/connect     # once per host
npm run dev:web                                 # UI on :5173
```

Vite proxies `/api` to the server, so the browser talks to one origin and the client bundle
carries no configuration.

| Command | Does |
|---|---|
| `npm run dev` | API with reload |
| `npm run dev:web` | React UI on :5173 |
| `npm run build` | Production build of the UI |
| `npm run smoke` | Live steps 1–2, read-only |
| `npm run smoke -- --book --cleanup` | Books a real slot, then cancels it |
| `npm run probe:s2s` | Reproduces the Server-to-Server assessment |
| `docker compose up --build` | Run the whole app in a container ([details](#running-in-docker)) |

---

## Running in Docker

The image is self-contained: Express serves **both** the API and the built React app, so one
container and one origin covers everything. No separate frontend service, no CORS to configure.

```bash
cp .env.example .env        # fill in credentials, then:
docker compose up --build
```

Or without compose:

```bash
docker build -t zoom-booking-sample .
docker run -p 3001:3001 --env-file .env -v zoom-tokens:/data zoom-booking-sample
```

The app is then on <http://localhost:3001> — UI at `/`, API under `/api`.

### The volume is not optional

```yaml
volumes:
  - zoom-tokens:/data      # TOKEN_STORE_PATH=/data/tokens.json
```

Zoom refresh tokens are **single use**: each refresh invalidates the previous one. They live in
the token store, so a container that starts with an empty `/data` has no valid tokens and
**every host must re-authorise**. Persist `/data` or expect to re-consent on every deploy.

### Configuration

Secrets are passed at **run** time via `--env-file` / `env_file`, never baked into the image —
`.env` is in `.dockerignore`. Two variables the container sets for you:

| Variable | Value | Why |
|---|---|---|
| `TOKEN_STORE_PATH` | `/data/tokens.json` | Points at the mounted volume rather than the image |
| `NODE_ENV` | `production` | Suppresses developer-facing `detail` fields in error responses |

`ZOOM_REDIRECT_URI` must still byte-match the Marketplace registration. Behind a reverse proxy
or tunnel that means the **public** URL, not `http://localhost:3001`.

### How the image is built

| Stage | Does |
|---|---|
| `build` | `npm ci`, then `npm run build` for the React bundle |
| `prod-deps` | `npm ci --omit=dev` — express and cors only, ~4 MB instead of ~200 MB |
| `runtime` | `node:22-alpine` + dumb-init, non-root `node` user, healthcheck on `/api/health` |

Three details worth knowing if you edit the Dockerfile:

**npm workspaces hoist everything to the root `node_modules`.** `server/node_modules` does not
exist, so `COPY --from=… /app/server/node_modules` fails the build. Copy only the root tree;
Node resolves upward from `server/src/` and finds it.

**The healthcheck deliberately makes no Zoom calls.** `/api/health` reports liveness and the
connected-host count only — an unreachable Zoom must not mark the container unhealthy.

**`dumb-init` is PID 1** so `docker stop` terminates promptly instead of waiting out the
10-second SIGKILL timeout.

**The slug→host cache is per process.** Running several replicas simply means each keeps its
own 60-second copy of the mapping. Availability is never cached, so replicas cannot disagree
about what is bookable — only about which pages exist, and only for a minute after a change.

### Serving the UI locally

The same code path works outside Docker: `npm run build` produces `web/dist`, and the server
serves it automatically if present — the startup banner prints `UI served from …`. With no
build present, `/` returns a small JSON landing document and you use `npm run dev:web` instead.
The OAuth callback at `/` still takes precedence whenever Zoom supplies `?code`.

---

## API surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/auth/connect` | Send a host through Zoom consent |
| `GET` | `/api/auth/hosts` | Who is connected (never returns tokens) |
| `DELETE` | `/api/auth/hosts/:userId` | Disconnect |
| `GET` | `/api/health` | Liveness + connected host count |
| `GET` | `/api/health/scheduler-readiness` | Per-host tokens, scopes, Scheduler profile |
| `GET` | `/api/hosts` | Step 1 |
| `GET` | `/api/hosts/:slug` | Detail, incl. the host's custom questions. Accepts a `schedule_id` too |
| `GET` | `/api/hosts/:slug/slots` | Step 2 |
| `POST` | `/api/bookings` | Step 3 |
| `GET` | `/api/bookings/:meetingId?hostId=` | Confirmation / retry |
| `DELETE` | `/api/bookings/:meetingId?hostId=` | Cancel meeting **and** calendar block |

### Error codes

The frontend switches on `code`, never on HTTP status or message text —
[`errors.js`](server/src/errors.js), [`web/src/api.js`](web/src/api.js).

| Code | Meaning |
|---|---|
| `SLOT_TAKEN` | **Expected, not exceptional.** Re-fetch and let the user pick again. |
| `INVALID_BOOKING` | Body rejected: missing answer, malformed time. |
| `PARTIAL_SUCCESS` | **The meeting exists.** Something after it failed — usually the calendar block. Never render as failure. |
| `NO_MEETING_LINK` | Meeting created without a join URL. |
| `CONFIG_ERROR` | Scope or token problem. `meta.action: "reconnect"` means the host must re-authorise. |
| `NOT_FOUND` · `RATE_LIMITED` · `UPSTREAM_UNAVAILABLE` · `BAD_REQUEST` | As named. |

---

## Security

What the sample does correctly:

| | |
|---|---|
| Tokens never reach the browser | Every Zoom call is server-side; the client talks only to `/api` |
| Refresh tokens encrypted at rest | AES-256-GCM with an authenticated tag, file mode `0600` |
| Single-use refresh handling | The new token is persisted before an access token is returned |
| OAuth hardening | PKCE (S256) plus a single-use, expiring `state` |
| `start_url` withheld | It embeds host credentials, so only `join_url` is ever returned |
| Error detail suppressed in production | Upstream messages are logged, not sent to clients |
| CORS bound to a configured origin | Never `*` |
| Container runs as non-root | `node` user; no credentials baked into the image |

### What the Marketplace app protects

The manifest sets `discover_type: "UNLISTED"`, and the app is unpublished. Zoom therefore
restricts who can complete the OAuth consent flow to users inside the account that created the
app. A stranger who reaches `/api/auth/connect` gets bounced by Zoom, not by this app — they
cannot attach their own Zoom account as a bookable host.

That control governs **who can grant the app access to Zoom**. It says nothing about **who can
call this Express server**.

### The API itself has no authentication

Once a host has connected, the app holds their token and acts with it. Every route is reachable
by anyone who can reach the server, and the caller presents no Zoom credential of any kind — so
Marketplace scoping does not apply to any of the following:

| Route | Exposure | Mitigated by Marketplace? |
|---|---|---|
| `DELETE /api/auth/hosts/:userId` | Disconnect any host. Denial of service. | No |
| `DELETE /api/bookings/:meetingId` | Cancel anyone's meeting, given its id. | No |
| `GET /api/bookings/:meetingId` | Insecure direct object reference — returns join URL and passcode. | No |
| `GET /api/health/scheduler-readiness` | Discloses host emails, granted scopes, token status. | No |
| `POST /api/bookings` | Writes to a real calendar, no rate limit or captcha. | No — though a booking page is public by design |
| `GET /api/auth/connect` | Starting the flow is harmless; Zoom refuses to issue a token to anyone outside the account. | **Yes** |

`GET /api/hosts` and `/slots` are meant to be public.

### How much this matters depends on network exposure

Bound to `localhost`, the risk is negligible — the endpoints are unreachable from outside.

The moment the server sits behind a tunnel or a public host — which the OAuth redirect
effectively requires during development — those endpoints are internet-reachable. Tunnel URLs
are not a security boundary: they appear in certificate transparency logs and are scanned.

Before exposing this beyond localhost:

1. Put `/api/auth/*`, `/api/health/scheduler-readiness`, and both `/api/bookings/:meetingId`
   methods behind authentication. They are operator endpoints, not visitor endpoints.
2. Make booking confirmations unguessable — issue an opaque token per booking rather than
   keying on the Zoom meeting id.
3. Rate-limit `POST /api/bookings` per IP and per email, and add a captcha.
4. Add CSRF protection to the state-changing routes.
5. Add an audit log of who booked and cancelled what.

---

## Known limitations

**No hold or reservation API.** Nothing reserves a slot between rendering it and booking it.
[`assertSlotStillFree()`](server/src/zoom/bookings.js#L34) re-checks immediately before
writing, which shrinks the race window but cannot close it. The UI treats losing a race as
routine: the grid refreshes, the lost time is struck through so the change is visible, typed
details are preserved, and an inline notice explains it —
[`App.jsx:130`](web/src/App.jsx#L130). No alert, no lost form.

**The booking POST is never auto-retried.** A timed-out create may already have succeeded, and
retrying would double-book the host. Marked `idempotent: false` in
[`client.js:84`](server/src/zoom/client.js#L84).

**Per-host consent.** Each host authorises once. Unavoidable — see Authentication.

**Bookings are Zoom meetings, not Scheduler events.** They will not appear under
`/scheduler/events`, and Scheduler's own reminder and reschedule emails do not apply. This is
the cost of routing around the broken `attendee` endpoint.

**Availability lag.** The Scheduler ↔ Calendar sync is not instantaneous; the smoke test waits
4 seconds before asserting a slot disappeared. Under load, a slot may briefly remain on offer
after being booked. `SLOT_TAKEN` is the backstop.

**Token store is a JSON file.** Encrypted at rest, `0600`, adequate for a sample. Production
wants a database with proper key management. Rotating `TOKEN_ENCRYPTION_KEY` invalidates the
store and every host must reconnect — as does losing the Docker volume, since Zoom refresh
tokens are single use and cannot be regenerated without fresh consent.

**Single-region assumptions.** Times are displayed in the viewer's timezone and labelled, but
the slot string is sent back verbatim — [`web/src/time.js`](web/src/time.js). Re-serialising
an offset-bearing timestamp is how off-by-an-hour bugs appear. DST transitions inside a
booking window are untested.

**API-created users can never be hosts.** A user with `login_types` containing `99`
(`custCreate`) has no password, cannot sign in, and so never gets a Scheduler profile. Their
Zoom `type` is still `2` (Licensed), identical to a real user, which makes this hard to spot.

**No authentication on any route**, including destructive and operator endpoints. The
Marketplace app being unlisted restricts who can *connect* a Zoom account, but not who can call
this server. See [Security](#security) for the exact exposure and what to fix before exposing
the app beyond localhost.
