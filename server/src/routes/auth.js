/**
 * The host consent flow.
 *
 * A host visits /api/auth/connect once, approves the scopes, and from then on
 * the app can read their availability and book on their behalf unattended.
 * Invitees never authenticate — they just use the booking UI.
 */

import { Router } from 'express';

import { config } from '../config.js';
import { AppError, ErrorCode } from '../errors.js';
import { buildAuthorizeUrl, consumeState, exchangeCode } from '../zoom/oauth.js';
import { saveHostRecord, listConnectedHosts, deleteHostRecord } from '../zoom/tokenStore.js';
import { describeHost } from '../zoom/users.js';

export const authRouter = Router();

/** Step 1 — send the host to Zoom's consent screen. */
authRouter.get('/auth/connect', (req, res) => {
  const { url } = buildAuthorizeUrl({ returnTo: req.query.returnTo });
  res.redirect(url);
});

/** Same thing as JSON, for a frontend that wants to render its own button. */
authRouter.get('/auth/connect-url', (req, res) => {
  const { url, state } = buildAuthorizeUrl({ returnTo: req.query.returnTo });
  res.json({ authorizeUrl: url, state, scopes: config.zoom.scopes });
});

/**
 * Step 2 — Zoom redirects here with ?code & ?state.
 *
 * `redirect_uri` must byte-match what is registered in the Marketplace app, so
 * this handler is mounted at BOTH the app root and /api/auth/callback. Whichever
 * URL you registered as ZOOM_REDIRECT_URI will work without further changes.
 */
export async function handleCallback(req, res, next) {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const received = Object.keys(req.query);

    // The root mount doubles as the app's own entry point. Only treat a request
    // as a callback when Zoom actually sent something back; otherwise fall
    // through so the SPA (or the JSON landing route) can answer.
    // Checked BEFORE logging: this handler sees every page load, and logging
    // them all would bury the callbacks that matter.
    if (!code && !state && !error) return next();

    // Log real callbacks. When something is missing, the query string Zoom
    // actually sent is the only thing that identifies why.
    console.log(
      `[auth/callback] ${req.method} ${req.originalUrl.split('?')[0]} ` +
        `params=[${received.join(', ')}]`
    );

    if (error) {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'Zoom authorisation was declined.', {
        status: 400,
        detail: `${error}: ${errorDescription ?? '(no description)'}`,
      });
    }
    // Zoom-initiated install: clicking "Install"/"Add" on the Marketplace app
    // (or the Local Test page) starts the flow at Zoom's end, so there is no
    // state to echo back and no PKCE challenge was ever sent. Accept a bare
    // `code` for that case. CSRF protection via `state` only applies to flows
    // WE started, which still require it below.
    const marketplaceInitiated = Boolean(code) && !state;

    if (!code) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Incomplete authorisation response.', {
        status: 400,
        detail:
          `Expected an authorisation \`code\`, but received ` +
          `[${received.join(', ') || 'no query parameters'}] at ${req.originalUrl.split('?')[0]}. ` +
          (state
            ? 'Zoom echoed the state but returned no code, so the authorisation was not completed.'
            : 'Start the flow at /api/auth/connect, or install the app from its Marketplace page.'),
        meta: { received, path: req.originalUrl.split('?')[0] },
      });
    }

    // Single-use state: protects against CSRF and against replaying a callback.
    const pending = marketplaceInitiated ? {} : consumeState(String(state));
    if (!pending) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'This authorisation link has expired.', {
        status: 400,
        detail: 'Unknown or already-used `state`. Start again at /api/auth/connect.',
      });
    }

    if (marketplaceInitiated) {
      console.log('[auth/callback] no `state` — treating as a Zoom-initiated install (no PKCE).');
    }

    // Without a stored verifier there is no PKCE leg; the client secret alone
    // authenticates the exchange, which is what Zoom expects for an install.
    const tokens = await exchangeCode({ code: String(code), codeVerifier: pending.codeVerifier });

    // Chicken and egg: we need a token to learn who this is, but the store is
    // keyed by user id. Park it under a temporary key, identify, then re-key.
    const tempId = `pending:${state ?? code}`;
    saveHostRecord({ userId: tempId, ...tokens });

    let host;
    try {
      host = await describeHost(tempId);
    } finally {
      deleteHostRecord(tempId);
    }

    saveHostRecord({
      userId: host.userId,
      email: host.email,
      displayName: host.displayName,
      timeZone: host.timeZone,
      schedulerSlug: host.schedulerProfile?.slug ?? null,
      schedulingUrl: host.schedulerProfile?.schedulingUrl ?? null,
      connectedAt: new Date().toISOString(),
      ...tokens,
    });

    const missingScopes = config.zoom.scopes.filter((s) => !tokens.scopes.includes(s));

    if (pending.returnTo) {
      const url = new URL(pending.returnTo, config.server.appBaseUrl);
      url.searchParams.set('connected', host.email);
      return res.redirect(url.toString());
    }

    res.json({
      connected: {
        userId: host.userId,
        email: host.email,
        displayName: host.displayName,
        schedulerProfile: host.schedulerProfile,
      },
      grantedScopes: tokens.scopes,
      missingScopes,
      ...(host.schedulerProfile
        ? {}
        : {
            warning:
              'This user has no Zoom Scheduler profile. They must open Zoom Scheduler once ' +
              'and connect a calendar before they can be booked.',
          }),
    });
  } catch (err) {
    next(err);
  }
}

authRouter.get('/auth/callback', handleCallback);

/** Who is connected right now. Never returns tokens. */
authRouter.get('/auth/hosts', (req, res) => {
  res.json({ hosts: listConnectedHosts() });
});

/** Disconnect a host locally. They can also revoke from their Zoom profile. */
authRouter.delete('/auth/hosts/:userId', (req, res) => {
  const existed = deleteHostRecord(req.params.userId);
  res.status(existed ? 204 : 404).end();
});
