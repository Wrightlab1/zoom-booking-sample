#!/usr/bin/env node
/**
 * Build, validate, and create the Zoom General App for this sample.
 *
 * The manifest is GENERATED from `REQUIRED_SCOPES` in server/src/config.js so the
 * app's scopes can never drift from what the code actually calls. Never hand-edit
 * the scope list here.
 *
 * Usage:
 *   npm run app:manifest              write manifest/app-manifest.json and print it
 *   npm run app:validate              validate it against Zoom
 *   npm run app:create                validate, then create the app
 *
 * ── Two traps this script exists to avoid ──
 * 1. `app_type` must be "general". "s2s_oauth" is a different creation surface
 *    (POST /v2/accounts/{accountId}/marketplace/apps, master scope, top-level
 *    `scopes` and NO manifest) and cannot do user-level OAuth, which this
 *    workflow requires — see docs/api-validation.md.
 * 2. POST /marketplace/apps/manifest/validate returns HTTP 200 for INVALID
 *    manifests. The response body is the verdict, not the status code.
 *
 * Auth: needs an app holding the marketplace scopes — `marketplace:read:app` to
 * validate, `marketplace:write:app` to create (either accepts the `:admin` form).
 * This is a BOOTSTRAP app, separate from the one being created. The script uses
 * the ZOOM_S2S_* app if it has them, otherwise a connected OAuth host.
 *
 * Note the asymmetry: an S2S app picks up newly-added scopes on the next token
 * grant, but an OAuth host's stored token keeps whatever was granted at consent
 * time — adding scopes in the Marketplace does nothing until they re-authorise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_SCOPES } from '../src/config.js';
import { listConnectedHosts } from '../src/zoom/tokenStore.js';
import { getAccessTokenForHost, grantedScopesForHost } from '../src/zoom/tokens.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(REPO_ROOT, 'manifest', 'app-manifest.json');

const args = new Set(process.argv.slice(2));
const WANT_VALIDATE = args.has('--validate') || args.has('--create');
const WANT_CREATE = args.has('--create');

const env = (k, fallback) => process.env[k] ?? fallback;

const REDIRECT_URI = env('ZOOM_REDIRECT_URI', 'http://localhost:3001/api/auth/callback');
const APP_NAME = env('APP_NAME', 'Zoom Booking Sample');
const CONTACT_NAME = env('APP_CONTACT_NAME', '');
const CONTACT_EMAIL = env('APP_CONTACT_EMAIL', '');
const COMPANY_NAME = env('APP_COMPANY_NAME', '');

/** Redirect + allow-list must agree; Zoom accepts a mismatch and then misbehaves. */
function allowListFor(uri) {
  try {
    return [new URL(uri).origin];
  } catch {
    return [];
  }
}

export function buildManifest() {
  return {
    display_information: {
      display_name: APP_NAME,
      description: 'Book Zoom meetings against a host\'s real Scheduler availability.',
      long_description:
        'A reference implementation of an end-to-end booking flow: select a host, read their ' +
        'live Zoom Scheduler availability, and book a meeting the host owns. Availability comes ' +
        'from Zoom Scheduler, the meeting is created through the Meetings API, and the busy ' +
        'block is written to the host\'s Zoom Calendar so the slot stops being offered.',
      // UNLISTED keeps the app private to the account that creates it; switch to
      // LISTED only when actually publishing.
      discover_type: 'UNLISTED',
      // Validator accepts only [LANDING_PAGE, APP_DIRECTORY]. LANDING_PAGE
      // additionally requires `install_landing_url`, so APP_DIRECTORY is the
      // simpler choice — discover_type keeps the app private regardless.
      install_type: 'APP_DIRECTORY',
      marketplace_categories: ['productivity'],
      // Probed against the validator 2026-08-20; the accepted set is
      // [marketing, humanResources, engineering, finance, other].
      // "productivity" and "sales" are rejected.
      business_lines: ['other'],
      market_segments: ['enterprise'],
      industry_vertical: 'other',
      config_url: '',
      doc_url: '',
      privacy_url: '',
      support_url: '',
      terms_url: '',
    },

    developer_information: {
      contact_details: [
        { contact_name: CONTACT_NAME, contact_email: CONTACT_EMAIL, role: 'Developer' },
      ],
    },

    oauth_information: {
      // The app acts AS each host, so every scope is user-level (no :admin).
      usage: 'USER_OPERATION',
      development_redirect_uri: REDIRECT_URI,
      production_redirect_uri: REDIRECT_URI,
      oauth_allow_list: allowListFor(REDIRECT_URI),
      scope_description:
        'Read the host\'s Scheduler booking pages and availability, create the booked Zoom ' +
        'meeting on their behalf, and write the matching busy block to their Zoom Calendar.',
      scopes: REQUIRED_SCOPES.map((scope) => ({ scope, optional: false })),
      strict_mode: true,
      subdomain_strict_mode: true,
    },

    features: {
      products: ['ZOOM_MEETING'],
      // No webhooks in this sample; booking is entirely request/response.
      event_subscription: { enable: false, events: [] },
      // No in-client surface — this is a standalone web app.
      embed: {
        meeting_sdk: { enable: false },
        contact_center_sdk: { enable: false },
        phone_sdk: { enable: false },
      },
      in_client_feature: {
        in_client_oauth: { enable: false },
        zoom_app_api: { enable: false },
        guest_mode: { enable: false },
      },
      team_chat_subscription: { enable: false },
      zoom_client_support: {
        mobile: { enable: false },
        pwa_client: { enable: false },
        zoom_room: { enable: false },
      },
    },
  };
}

// ── Zoom API plumbing ────────────────────────────────────────────────────────

const SCOPE_FOR = {
  validate: ['marketplace:read:app', 'marketplace:read:app:admin'],
  create: ['marketplace:write:app', 'marketplace:write:app:admin'],
};

async function s2sToken() {
  const { ZOOM_S2S_ACCOUNT_ID: account, ZOOM_S2S_CLIENT_ID: id, ZOOM_S2S_CLIENT_SECRET: secret } =
    process.env;
  if (!account || !id || !secret) return null;

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${account}`,
    { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` } }
  );
  const body = await res.json();
  if (!res.ok) return null;
  return { token: body.access_token, scopes: String(body.scope || '').split(/\s+/).filter(Boolean), source: 'S2S bootstrap app' };
}

async function hostTokens() {
  const out = [];
  for (const h of listConnectedHosts()) {
    try {
      const token = await getAccessTokenForHost(h.userId);
      out.push({ token, scopes: grantedScopesForHost(h.userId), source: `OAuth host ${h.email}` });
    } catch {
      /* a host needing reconnect is not this script's problem */
    }
  }
  return out;
}

/** Pick whichever configured app actually holds the scope this action needs. */
async function resolveToken(action) {
  const needed = SCOPE_FOR[action];
  const candidates = [await s2sToken(), ...(await hostTokens())].filter(Boolean);

  if (!candidates.length) {
    throw new Error(
      'No credentials available. Either set ZOOM_S2S_* in .env, or connect a host via /api/auth/connect.'
    );
  }

  const match = candidates.find((c) => needed.some((n) => c.scopes.includes(n)));
  if (match) {
    console.log(`  auth: ${match.source}`);
    return match.token;
  }

  const report = candidates
    .map((c) => {
      const mk = c.scopes.filter((x) => x.startsWith('marketplace:'));
      return `    ${c.source}: ${mk.length ? mk.join(', ') : 'no marketplace:* scopes'}`;
    })
    .join('\n');

  throw new Error(
    `To ${action} a manifest the app needs one of: ${needed.join(' or ')}.\n` +
      `None of the configured apps has it:\n${report}\n\n` +
      '  · For a Server-to-Server app, add the scope and re-run — a fresh token grant picks it up.\n' +
      "  · For a General (OAuth) app, adding the scope is not enough: the stored token keeps the\n" +
      '    scopes granted at consent time, so the host must re-authorise at /api/auth/connect.'
  );
}

async function api(token, urlPath, body) {
  const res = await fetch(`https://api.zoom.us/v2${urlPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Validation returns 200 whether or not the manifest is valid, so the body is
 * the verdict. Zoom is not consistent about the success shape, so treat the
 * presence of any error/invalid signal as failure rather than guessing.
 */
function interpretValidation({ status, body }) {
  const text = JSON.stringify(body ?? {});
  const failed =
    status >= 400 ||
    /invalid_manifest|"errors"\s*:\s*\[[^\]]/.test(text) ||
    body?.valid === false ||
    (Array.isArray(body?.errors) && body.errors.length > 0);
  return { failed, text };
}

async function main() {
  const manifest = buildManifest();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`▸ manifest written to ${path.relative(REPO_ROOT, OUT)}`);
  console.log(`  ${manifest.oauth_information.scopes.length} scopes · redirect ${REDIRECT_URI}`);

  if (!WANT_VALIDATE) {
    console.log('\n  Next: npm run app:validate    (or --create to create the app)\n');
    return;
  }

  const token = await resolveToken(WANT_CREATE ? 'create' : 'validate');

  console.log('\n▸ validating…');
  const validation = await api(token, '/marketplace/apps/manifest/validate', { manifest });
  const verdict = interpretValidation(validation);
  console.log(`  HTTP ${validation.status} — ${verdict.failed ? '✖ INVALID' : '✔ valid'}`);
  console.log(`  ${verdict.text.slice(0, 500)}`);

  if (verdict.failed) {
    console.error('\n✖ Manifest rejected. Not creating.\n');
    process.exit(1);
  }
  if (!WANT_CREATE) {
    console.log('\n  Next: npm run app:create\n');
    return;
  }

  for (const [k, v] of Object.entries({ APP_CONTACT_NAME: CONTACT_NAME, APP_CONTACT_EMAIL: CONTACT_EMAIL, APP_COMPANY_NAME: COMPANY_NAME })) {
    if (!v) console.warn(`⚠ ${k} is empty — Zoom may reject the create.`);
  }

  console.log('\n▸ creating app…');
  const created = await api(token, '/marketplace/apps', {
    app_type: 'general',              // NOT s2s_oauth — see header comment
    app_name: APP_NAME,
    contact_name: CONTACT_NAME,
    contact_email: CONTACT_EMAIL,
    company_name: COMPANY_NAME,
    manifest,
  });

  console.log(`  HTTP ${created.status}`);
  console.log(JSON.stringify(created.body, null, 2));

  if (!created.ok) process.exit(1);

  const creds = created.body?.development_credentials ?? created.body?.credentials ?? null;
  console.log('\n✔ Created.');
  console.log(`  app_id: ${created.body?.app_id}`);
  if (creds?.client_id) {
    console.log('\n  Put these in .env:');
    console.log(`    ZOOM_CLIENT_ID=${creds.client_id}`);
    console.log(`    ZOOM_CLIENT_SECRET=${creds.client_secret}`);
  } else {
    console.log('  No credentials in the response — read them from the Marketplace app page.');
  }
  console.log(
    '\n  Then confirm what Zoom actually persisted (it silently drops some fields):\n' +
      `    GET /v2/marketplace/apps/${created.body?.app_id}/manifest\n`
  );
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
