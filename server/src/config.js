/**
 * Environment parsing with fail-fast validation.
 *
 * This app uses USER-LEVEL OAuth (authorization_code), not Server-to-Server.
 * That is a hard requirement, not a preference — see docs/api-validation.md:
 * an S2S token can list schedules across an account but cannot read another
 * user's availability and cannot book at all.
 */

import crypto from 'node:crypto';

const REQUIRED = ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_REDIRECT_URI'];

function csv(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The scopes each host grants when they connect.
 *
 * All user-level (no `:admin` suffix) — the app acts AS the host, so it needs
 * no account-wide privilege. Keep this list in sync with the scopes ticked in
 * the Marketplace app or the consent screen will silently grant fewer.
 */
export const REQUIRED_SCOPES = [
  'user:read:user',                     // identify who just connected
  'scheduler:read:user',                // their Scheduler profile + slug
  'scheduler:read:list_schedule',       // step 1 — their booking pages
  'scheduler:read:get_schedule',        // step 2 — available_times
  'scheduler:write:scheduled_event',    // step 3 — create the booking
  'scheduler:read:scheduled_event',     // step 3 — meeting join details
  'scheduler:delete:scheduled_event',   // cancellation
  'scheduler:read:list_availability',   // provisioning reads working hours
  'scheduler:write:insert_schedule',    // provisioning creates a booking page

  // Step 3 runs through the Meetings API, not POST /scheduler/attendee, which
  // rejects every payload. See zoom/meetings.js for the full reasoning.
  'meeting:write:meeting',              // create the booking's Zoom meeting
  'meeting:read:meeting',               // confirmation lookups
  'meeting:delete:meeting',             // cancellation

  // Availability is computed from the host's Zoom Calendar, and creating a
  // meeting does NOT write to it, so the app writes the busy block itself.
  'calendar:read:list_calendar_lists',
  'calendar:read:list_events',
  'calendar:write:event',
  'calendar:delete:event',
];

/** 32 bytes for AES-256-GCM, accepted as base64 or hex. */
function parseEncryptionKey(raw) {
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

export function loadConfig({ requireCredentials = true } = {}) {
  const missing = REQUIRED.filter((key) => !process.env[key]);

  if (requireCredentials && missing.length > 0) {
    const err = new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        `Copy .env.example to .env and fill in your User-level OAuth (General App) credentials.`
    );
    err.code = 'MISSING_CREDENTIALS';
    err.missing = missing;
    throw err;
  }

  const encryptionKey = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (requireCredentials && !encryptionKey) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 or hex). Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }

  return {
    zoom: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      redirectUri: process.env.ZOOM_REDIRECT_URI,
      authorizeUrl: process.env.ZOOM_OAUTH_AUTHORIZE_URL || 'https://zoom.us/oauth/authorize',
      tokenUrl: process.env.ZOOM_OAUTH_TOKEN_URL || 'https://zoom.us/oauth/token',
      apiBase: (process.env.ZOOM_API_BASE || 'https://api.zoom.us/v2').replace(/\/+$/, ''),
      scopes: REQUIRED_SCOPES,
    },
    server: {
      port: Number(process.env.PORT || 3001),
      env: process.env.NODE_ENV || 'development',
      corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
      appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',
    },
    tokens: {
      storePath: process.env.TOKEN_STORE_PATH || '.tokens.json',
      encryptionKey: encryptionKey ?? crypto.randomBytes(32), // placeholder when not validating
    },
    demo: {
      defaultTimeZone: process.env.DEFAULT_TIME_ZONE || 'America/New_York',
      bookingWindowDays: Number(process.env.BOOKING_WINDOW_DAYS || 14),
      logZoomResponses: String(process.env.LOG_ZOOM_RESPONSES || 'false') === 'true',
      allowedScheduleIds: csv(process.env.ALLOWED_SCHEDULE_IDS),
      autoProvisionBookingPages:
        String(process.env.AUTO_PROVISION_BOOKING_PAGES || 'false') === 'true',
    },
    missing,
  };
}

export const config = loadConfig({ requireCredentials: false });
