#!/usr/bin/env node
/**
 * Live smoke test — exercises the whole workflow against real connected hosts
 * and prints every raw response.
 *
 * Requires at least one host to have completed the OAuth consent flow:
 *   npm run dev            then open /api/auth/connect in a browser
 *
 * Usage:
 *   npm run smoke                       steps 1 and 2 only (read-only)
 *   npm run smoke -- --book             also books the first available slot (REAL)
 *   npm run smoke -- --book --cleanup   books, then cancels what it booked
 */

import { loadConfig, config } from '../src/config.js';
import { listConnectedHosts } from '../src/zoom/tokenStore.js';
import { tokenStatusForHost, grantedScopesForHost } from '../src/zoom/tokens.js';
import { listRawSchedules, isBookable, toHostDto } from '../src/zoom/schedules.js';
import { getAvailableTimes, flattenSlots } from '../src/zoom/availability.js';
import { createBooking, cancelBooking } from '../src/zoom/bookings.js';
import { ensureBookingPagesForHosts } from '../src/zoom/provisioning.js';

const args = new Set(process.argv.slice(2));
const DO_BOOK = args.has('--book');
const DO_CLEANUP = args.has('--cleanup');

const findings = [];
const heading = (t) => console.log(`\n${'━'.repeat(72)}\n${t}\n${'━'.repeat(72)}`);
const raw = (label, v) => console.log(`\n▸ ${label}\n${JSON.stringify(v, null, 2)}`);
const finding = (q, a) => {
  findings.push({ q, a });
  console.log(`\n  ✔ ${q}\n    → ${a}`);
};

async function main() {
  loadConfig({ requireCredentials: true });

  // ── Step 0 ───────────────────────────────────────────────────────────────
  heading('STEP 0 · connected hosts (user-level OAuth)');
  const connected = listConnectedHosts();

  if (!connected.length) {
    console.log(
      '  No hosts connected.\n\n' +
        '  Start the server and send each host through the consent flow:\n' +
        '      npm run dev\n' +
        `      open ${config.zoom.redirectUri.replace(/\/$/, '')}/api/auth/connect\n`
    );
    return summarise();
  }

  for (const h of connected) {
    const granted = grantedScopesForHost(h.userId);
    const missing = config.zoom.scopes.filter((s) => !granted.includes(s));
    console.log(`  ${h.email}  (${h.userId})`);
    console.log(`     scheduler slug : ${h.schedulerSlug ?? '(none — not provisioned in Scheduler)'}`);
    console.log(`     token          : ${JSON.stringify(tokenStatusForHost(h.userId))}`);
    if (missing.length) console.log(`     ⚠ missing scopes: ${missing.join(', ')}`);
  }

  // ── Step 1 ───────────────────────────────────────────────────────────────
  heading('STEP 1 · GET /scheduler/schedules (per connected host)');
  let schedules = await listRawSchedules(connected);
  console.log(`  ${schedules.length} schedule(s) across ${connected.length} host(s).`);

  let bookable = schedules.filter(isBookable);
  if (!bookable.length && config.demo.autoProvisionBookingPages) {
    console.log('\n  None bookable — auto-provisioning a booking page per host…');
    const results = await ensureBookingPagesForHosts(connected);
    for (const r of results) {
      console.log(`    ${r.created ? '✔ created' : r.error ? '✖ ' + String(r.error).slice(0, 90) : '= existing'}  ${r.email}`);
    }
    schedules = await listRawSchedules(connected);
    bookable = schedules.filter(isBookable);
  }

  raw('first raw schedule', schedules[0] ?? null);
  console.log(`\n  ${bookable.length} bookable (active + confirmed + add_on_type=zoomMeeting).`);

  if (!bookable.length) {
    console.log(
      '\n✖ No bookable schedule. Each host needs a Zoom Scheduler booking page whose\n' +
        '  location is a Zoom Meeting. Set AUTO_PROVISION_BOOKING_PAGES=true to create one.'
    );
    return summarise();
  }

  // Under user-level OAuth every connected host should be reachable — the
  // Server-to-Server token could only ever reach its own. Verify that claim.
  heading('STEP 1b · is every connected host reachable?');
  const probeFrom = new Date().toISOString();
  const probeTo = new Date(Date.now() + 86_400_000).toISOString();
  const reachable = [];
  for (const s of bookable) {
    try {
      await getAvailableTimes(s._ownerUserId, s.slug, { from: probeFrom, to: probeTo, rawSchedule: s });
      reachable.push(s);
      console.log(`  ✔ ${String(s.slug).padEnd(30)} (${s._ownerEmail})`);
    } catch (err) {
      console.log(`  ✖ ${String(s.slug).padEnd(30)} (${s._ownerEmail}) ${err.code}`);
    }
  }
  finding(
    'Can user-level OAuth read every connected host\'s availability?',
    reachable.length === bookable.length
      ? `Yes — all ${bookable.length} of ${bookable.length} reachable. This is the capability a ` +
        `Server-to-Server token lacked (it could only ever reach the token owner).`
      : `Partially: ${reachable.length} of ${bookable.length}. Unreachable hosts likely need to re-authorise.`
  );

  if (!reachable.length) return summarise();

  const schedule = reachable[0];
  const host = toHostDto(schedule);
  raw('host DTO the frontend will receive', host);

  const formats = [...new Set((schedule.custom_fields ?? []).map((f) => f.format))];
  finding(
    'Q4 · custom_fields.format values on a real schedule',
    formats.length ? formats.join(', ') : 'this schedule defines no custom questions'
  );

  // ── Step 2 ───────────────────────────────────────────────────────────────
  heading('STEP 2 · GET /scheduler/schedules/{slug}/available_times');
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + config.demo.bookingWindowDays * 86_400_000).toISOString();
  console.log(`  Window: ${from} → ${to}  (time_zone=${config.demo.defaultTimeZone})`);

  const { response: availability } = await getAvailableTimes(schedule._ownerUserId, schedule.slug, {
    from,
    to,
    timeZone: config.demo.defaultTimeZone,
    rawSchedule: schedule,
  });

  const flat = flattenSlots(availability);
  console.log(`\n  ${flat.slots.length} bookable slot(s) across ${flat.daysAvailable}/${flat.daysQueried} day(s).`);
  raw('first 3 flattened slots', flat.slots.slice(0, 3));

  if (flat.slots.length) {
    const sample = flat.slots[0].startTime;
    finding(
      'Q3 · Does slot start_time use UTC Z or a host offset?',
      /Z$/.test(sample)
        ? `UTC — sample "${sample}".`
        : `Host offset — sample "${sample}". The offset follows the time_zone query param.`
    );
  }

  // ── Step 3 ───────────────────────────────────────────────────────────────
  heading('STEP 3 · POST /users/me/meetings  (availability via Scheduler)');

  if (!DO_BOOK) {
    console.log(
      '  Skipped. This creates a REAL booking and emails the invitee, so it is opt-in:\n\n' +
        '      npm run smoke -- --book             book and keep it\n' +
        '      npm run smoke -- --book --cleanup   book, then cancel it\n\n' +
        `  Set SMOKE_BOOKER_EMAIL in .env first (currently ${process.env.SMOKE_BOOKER_EMAIL ? 'set' : 'EMPTY'}).`
    );
    return summarise();
  }
  if (!flat.slots.length) {
    console.log('  Cannot book — no available slots.');
    return summarise();
  }
  if (!process.env.SMOKE_BOOKER_EMAIL) {
    console.log('  Cannot book — set SMOKE_BOOKER_EMAIL in .env.');
    return summarise();
  }

  const slot = flat.slots[0];
  console.log(`  Booking ${slot.startTime} for ${slot.durationMinutes} min as ${schedule._ownerEmail}`);

  const answers = (host.customFields ?? [])
    .filter((f) => f.required)
    .map((f) => ({
      question: f.question,
      answer: f.choices?.length ? f.choices[0] : 'Smoke test',
      position: f.position,
    }));
  if (answers.length) raw('answering required questions', answers);

  const { dto, raw: rawBooking } = await createBooking({
    hostId: schedule._ownerUserId,
    scheduleSlug: schedule.slug,
    scheduleId: schedule.schedule_id,
    startDateTime: slot.startTime,
    durationMinutes: slot.durationMinutes,
    timeZone: config.demo.defaultTimeZone,
    booker: {
      email: process.env.SMOKE_BOOKER_EMAIL,
      firstName: process.env.SMOKE_BOOKER_FIRST_NAME || 'Smoke',
      lastName: process.env.SMOKE_BOOKER_LAST_NAME || 'Test',
    },
    answers,
  });

  raw('raw POST /users/me/meetings response', rawBooking.meeting);
  raw('merged confirmation the frontend receives', dto);

  finding(
    'Q1 · Does the Meetings API produce a usable booking?',
    dto.meeting?.joinUrl
      ? `Yes — meeting ${dto.meeting.meetingId}, join URL returned in ONE call.`
      : 'NO — meeting created but no join URL came back.'
  );

  // The whole hybrid rests on this: the meeting must block the Scheduler slot.
  await new Promise((r) => setTimeout(r, 4000));
  const afterBooking = flattenSlots(
    (
      await getAvailableTimes(schedule._ownerUserId, schedule.slug, {
        from,
        to,
        timeZone: config.demo.defaultTimeZone,
        rawSchedule: schedule,
      })
    ).response
  );
  const stillOffered = afterBooking.slots.some(
    (s) => new Date(s.startTime).getTime() === new Date(slot.startTime).getTime()
  );
  finding(
    'Does the booked slot stop being offered?',
    stillOffered
      ? `NO — ${slot.startTime} is still in available_times (${afterBooking.slots.length} slots). Double-booking risk.`
      : `Yes — slots went ${flat.slots.length} → ${afterBooking.slots.length} and ${slot.startTime} is gone. ` +
        `The Meetings API booking correctly blocks the Scheduler slot via the Zoom Calendar.`
  );

  if (DO_CLEANUP && dto.meetingId) {
    console.log(`\n  Cleaning up: deleting meeting ${dto.meetingId}…`);
    await cancelBooking(schedule._ownerUserId, dto.meetingId);
    console.log('  Deleted.');
  } else if (dto.meetingId) {
    console.log(`\n  ⚠ Meeting ${dto.meetingId} is live. Re-run with --cleanup to remove it.`);
  }

  return summarise();
}

function summarise() {
  heading('FINDINGS');
  if (!findings.length) return console.log('  None — the run did not get far enough.\n');
  for (const f of findings) console.log(`\n  ${f.q}\n    → ${f.a}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n✖ ${err.code ? `[${err.code}] ` : ''}${err.message}`);
  if (err.detail) console.error(`  ${err.detail}`);
  summarise();
  process.exit(1);
});
