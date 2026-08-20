/**
 * Zoom user-level OAuth — the authorization_code flow.
 *
 *   1. GET  /api/auth/connect   → redirect the host to Zoom's consent screen
 *   2. Zoom redirects back to ZOOM_REDIRECT_URI with ?code=&state=
 *   3. exchangeCode() swaps the code for access + refresh tokens
 *   4. refreshTokens() keeps them alive afterwards, unattended
 *
 * PKCE is included even though this is a confidential client: it costs nothing
 * and closes the authorization-code interception window.
 */

import crypto from 'node:crypto';

import { config } from '../config.js';
import { AppError, ErrorCode } from '../errors.js';

/** Pending authorisation attempts, keyed by `state`. In-memory is fine — they live ~minutes. */
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function basicAuthHeader() {
  const { clientId, clientSecret } = config.zoom;
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function prunePendingStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

/** Build the consent URL and remember the state + PKCE verifier for the callback. */
export function buildAuthorizeUrl({ returnTo } = {}) {
  prunePendingStates();

  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  pendingStates.set(state, { codeVerifier, returnTo, createdAt: Date.now() });

  const url = new URL(config.zoom.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.zoom.clientId);
  url.searchParams.set('redirect_uri', config.zoom.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

export function consumeState(state) {
  prunePendingStates();
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state); // single use — replay protection
  return entry;
}

async function postToken(params, context) {
  let res;
  try {
    res = await fetch(config.zoom.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (cause) {
    throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Could not reach Zoom to authenticate.', {
      status: 503,
      detail: `${context}: ${cause.message}`,
      cause,
    });
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw new AppError(ErrorCode.CONFIG_ERROR, 'Zoom rejected the OAuth request.', {
      status: 400,
      detail:
        `${context} failed with HTTP ${res.status}: ` +
        `${body.reason || body.error_description || body.error || text || '(empty body)'}`,
      meta: { httpStatus: res.status, zoomError: body.error ?? null },
    });
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    scopes: String(body.scope || '').split(/\s+/).filter(Boolean),
  };
}

export function exchangeCode({ code, codeVerifier }) {
  return postToken(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.zoom.redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    },
    'Authorization code exchange'
  );
}

/**
 * Zoom returns a NEW refresh token here and invalidates the one just used.
 * Callers must persist the returned refreshToken or the host is locked out.
 */
export function refreshTokens(refreshToken) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'Token refresh');
}
