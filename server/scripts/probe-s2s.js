#!/usr/bin/env node
/**
 * Can the workflow run on Server-to-Server OAuth after the Meetings-API pivot?
 *
 * The only thing S2S demonstrably could not do was read another user's
 * availability via GET /scheduler/schedules/{slug}/available_times. Everything
 * else in the current architecture is untested under S2S because the old
 * /scheduler/attendee blocker stopped us before we got there.
 *
 * This probe answers, for a user OTHER than the token owner:
 *   A. read their booking pages + working hours   (list endpoints)
 *   B. read their calendar free/busy              (Calendar API)
 *   C. create a meeting owned by them             (Meetings API)
 *   D. write a busy block to their calendar       (Calendar API)
 *
 * A+B are enough to compute availability ourselves. C+D are the booking.
 *
 * ── RESULT (2026-08-20): S2S is NOT viable. Kept as the record of why. ──
 * A and C pass. B and D pass too, but ONLY when the calendar id is supplied
 * out-of-band — and there is no admin-reachable way to discover it. Calendar
 * ids are Zoom Mail addresses, not login emails; the only admin route to
 * calendarList is the classic scope `calendar:read:admin`, retired with the
 * move to granular scopes. A2 (available_times for a non-owner) fails outright
 * and no scope changes that.
 *
 * Both architectures therefore need a one-time per-host step, so user-level
 * OAuth wins: same onboarding cost, plus Zoom's own availability math.
 *
 * Reads S2S credentials from ZOOM_S2S_* so it never disturbs the OAuth config.
 * Creates nothing permanent: C and D are deleted immediately.
 */

const { ZOOM_S2S_ACCOUNT_ID: ACCOUNT, ZOOM_S2S_CLIENT_ID: ID, ZOOM_S2S_CLIENT_SECRET: SECRET } =
  process.env;

const API = 'https://api.zoom.us/v2';
const results = [];

if (!ACCOUNT || !ID || !SECRET) {
  console.error(
    '\n✖ Missing S2S credentials. Add to .env (these are separate from the OAuth app):\n' +
      '    ZOOM_S2S_ACCOUNT_ID=\n    ZOOM_S2S_CLIENT_ID=\n    ZOOM_S2S_CLIENT_SECRET=\n'
  );
  process.exit(1);
}

async function token() {
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ACCOUNT}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token grant failed: ${JSON.stringify(body)}`);
  return body;
}

async function call(tok, path, { method = 'GET', query, body } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed,
           message: parsed?.error?.message ?? parsed?.message ?? text?.slice(0, 90) };
}

function record(id, label, ok, detail) {
  results.push({ id, label, ok, detail });
  console.log(`  ${ok ? '✔' : '✖'} ${id}. ${label}\n      ${detail}`);
}

const main = async () => {
  const grant = await token();
  const tok = grant.access_token;
  const scopes = String(grant.scope || '').split(/\s+/).filter(Boolean);
  console.log(`\nS2S token acquired — ${scopes.length} scopes.\n`);

  // Pre-flight. A missing scope produces a 401/404 that reads like a hard API
  // limit, which is exactly the mistake this probe exists to avoid.
  // NOTE: every /calendars/users/{id}/calendarList operation is admin-reachable
  // ONLY via the CLASSIC scope `calendar:read:admin`. The granular
  // `calendar:read:list_calendar_lists` has no :admin variant at all, so an S2S
  // app can never satisfy it. Accept either form here.
  const ANY_OF = {
    'discover each user\'s calendar id': ['calendar:read:admin', 'calendar:read:list_calendar_lists'],
  };
  const NEEDED = {
    'calendar:read:list_events:admin': 'read free/busy',
    'calendar:write:event:admin': 'write the busy block',
    'calendar:delete:event:admin': 'remove it on cancel',
    'meeting:write:meeting:admin': 'create the meeting',
    'meeting:read:meeting:admin': 'confirmation lookup',
    'meeting:delete:meeting:admin': 'cancellation',
    'scheduler:read:list_schedule:admin': 'read booking pages',
  };
  const absent = [
    ...Object.entries(NEEDED).filter(([k]) => !scopes.includes(k)),
    ...Object.entries(ANY_OF)
      .filter(([, opts]) => !opts.some((o) => scopes.includes(o)))
      .map(([why, opts]) => [opts.join('  OR  '), why]),
  ];
  if (absent.length) {
    console.log('⚠ Scopes missing from the S2S app — add these before trusting the result:');
    for (const [k, why] of absent) console.log(`    ${k.padEnd(52)} ${why}`);
    console.log('');
  } else {
    console.log('✔ All required scopes present.\n');
  }

  // Pick a target user who is NOT the token owner.
  const me = await call(tok, '/users/me');
  const all = await call(tok, '/users', { query: { page_size: 50, status: 'active' } });
  const candidates = (all.body?.users ?? []).filter(
    (u) => u.id !== me.body?.id && !(u.login_types ?? []).includes(99)
  );

  console.log(`Token owner: ${me.body?.email ?? '(unknown)'}`);
  if (!candidates.length) {
    console.error('✖ No non-owner, non-API user to test against.');
    process.exit(1);
  }

  // Prefer someone with a Scheduler booking page.
  let target = null, schedule = null;
  for (const u of candidates) {
    const s = await call(tok, '/scheduler/schedules', { query: { page_size: 30, user_id: u.id } });
    const bookable = (s.body?.items ?? []).find(
      (x) => x.active && x.status === 'confirmed' && x.add_on_type === 'zoomMeeting'
    );
    if (bookable) { target = u; schedule = bookable; break; }
    if (!target) target = u;
  }
  console.log(`Target (non-owner): ${target.email}\n`);
  console.log('─'.repeat(70));

  // ── A ──
  record('A', 'Read their booking pages + working hours',
    Boolean(schedule),
    schedule
      ? `slug="${schedule.slug}" duration=${schedule.duration} increment=${schedule.start_time_increment} ` +
        `buffer=${JSON.stringify(schedule.buffer)} cushion=${schedule.cushion} ` +
        `recurrence=${schedule.availability_rules?.[0]?.segments_recurrence ? 'present' : 'MISSING'}`
      : 'No bookable schedule returned for this user via ?user_id=');

  // Control: the thing S2S could not do before.
  if (schedule) {
    const at = await call(tok, `/scheduler/schedules/${encodeURIComponent(schedule.slug)}/available_times`,
      { query: { from: new Date().toISOString(), to: new Date(Date.now() + 3 * 864e5).toISOString() } });
    record('A2', 'available_times for a NON-owner (the known blocker)',
      at.ok, at.ok ? `unexpectedly WORKS — ${(at.body?.days ?? []).length} days` : `HTTP ${at.status} ${at.message}`);
  }

  // ── Resolve the target's real calendar id ──
  // It is NOT their Zoom login email: calendar ids are Zoom Mail addresses
  // (e.g. someone@zmail.com). Passing the login email yields a bare "notFound".
  const calList = await call(tok, `/calendars/users/${encodeURIComponent(target.id)}/calendarList`,
    { query: { maxResults: 50 } });
  const calItems = calList.body?.items ?? [];
  const targetCal = (calItems.find((c) => c.primary) ?? calItems[0])?.id ?? null;
  console.log(`  · target calendar id: ${targetCal ?? `UNRESOLVED (${calList.status} ${calList.message})`}`);
  if (targetCal && targetCal !== target.email) {
    console.log(`    (note: differs from the login email ${target.email})`);
  }

  // ── B ──
  const fbId = targetCal ?? target.email;
  const fb = await call(tok, '/calendars/freeBusy', { method: 'POST', body: {
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + 7 * 864e5).toISOString(),
    items: [{ id: fbId }],
  }});
  const cal0 = fb.body?.calendars?.[0];
  record('B', 'Read their calendar free/busy',
    fb.ok && !cal0?.errors?.length,
    fb.ok
      ? `id=${fbId} busy=${cal0?.busy?.length ?? 0} errors=${JSON.stringify(cal0?.errors ?? [])}`
      : `HTTP ${fb.status} ${fb.message}`);

  // ── C ──
  const start = new Date(Date.now() + 5 * 864e5); start.setUTCHours(18, 0, 0, 0);
  const mk = await call(tok, `/users/${encodeURIComponent(target.id)}/meetings`, { method: 'POST', body: {
    topic: 'S2S probe — delete me', type: 2,
    start_time: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: 30, timezone: 'America/Denver',
  }});
  record('C', 'Create a meeting owned by them',
    mk.ok, mk.ok ? `meeting ${mk.body?.id}, host_email=${mk.body?.host_email}` : `HTTP ${mk.status} ${mk.message}`);

  // ── D ──
  const ev = targetCal === null
    ? { ok: false, status: 0, message: 'skipped — calendar id could not be resolved' }
    : await call(tok, `/calendars/${encodeURIComponent(targetCal)}/events`, { method: 'POST', body: {
    summary: 'S2S probe — delete me',
    start: { dateTime: start.toISOString(), timeZone: 'America/Denver' },
    end: { dateTime: new Date(start.getTime() + 18e5).toISOString(), timeZone: 'America/Denver' },
  }});
  record('D', 'Write a busy block to their calendar',
    ev.ok, ev.ok ? `event ${ev.body?.id} on ${targetCal}` : `HTTP ${ev.status} ${ev.message}`);

  // ── cleanup ──
  if (mk.ok) await call(tok, `/meetings/${mk.body.id}`, { method: 'DELETE' });
  if (ev.ok) await call(tok, `/calendars/${encodeURIComponent(targetCal)}/events/${ev.body.id}`, { method: 'DELETE' });
  console.log('─'.repeat(70));
  console.log(`\nCleanup: meeting ${mk.ok ? 'deleted' : 'n/a'}, calendar event ${ev.ok ? 'deleted' : 'n/a'}\n`);

  // ── verdict ──
  const core = results.filter((r) => ['A', 'B', 'C', 'D'].includes(r.id));
  const passed = core.filter((r) => r.ok).length;
  console.log('═'.repeat(70));
  if (passed === 4) {
    console.log('VERDICT: S2S IS VIABLE.\n' +
      '  Availability must be computed from A + B (working hours minus busy blocks)\n' +
      '  rather than read from available_times, but no host needs to authorise.');
  } else {
    console.log(`VERDICT: S2S NOT VIABLE — ${4 - passed} of 4 capabilities failed:\n` +
      core.filter((r) => !r.ok).map((r) => `    ✖ ${r.id}. ${r.label}`).join('\n') +
      '\n  Stay on user-level OAuth.');
  }
  console.log('═'.repeat(70) + '\n');
};

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
