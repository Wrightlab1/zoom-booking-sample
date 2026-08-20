/**
 * Per-host access-token resolution. Replaces the old Server-to-Server token.js.
 *
 * Every Zoom call now happens AS a specific connected host, so a token is
 * resolved per `hostId` (the host's Zoom user id) rather than once globally.
 */

import { AppError, ErrorCode } from '../errors.js';
import { refreshTokens } from './oauth.js';
import { getHostRecord, saveHostRecord } from './tokenStore.js';

const REFRESH_MARGIN_MS = 60_000;

/** De-duplicates concurrent refreshes per host so parallel calls fire one refresh. */
const inFlight = new Map();

function notConnected(hostId) {
  return new AppError(ErrorCode.CONFIG_ERROR, 'That host has not connected their Zoom account.', {
    status: 409,
    detail: `No stored OAuth tokens for host "${hostId}". Send them to /api/auth/connect to authorise.`,
    meta: { hostId, action: 'reconnect' },
  });
}

async function doRefresh(hostId, record) {
  let fresh;
  try {
    fresh = await refreshTokens(record.refreshToken);
  } catch (err) {
    // An invalid_grant means the refresh token is spent or revoked. There is no
    // recovery except re-consent, so say exactly that rather than a vague 500.
    const spent = /invalid_grant/i.test(err.detail ?? err.message ?? '');
    throw new AppError(
      ErrorCode.CONFIG_ERROR,
      spent
        ? 'That host needs to reconnect their Zoom account.'
        : 'Could not refresh the host\'s Zoom token.',
      {
        status: 409,
        detail: `${err.detail ?? err.message}${spent ? ' — Zoom refresh tokens are single use; the stored one is no longer valid.' : ''}`,
        meta: { hostId, action: 'reconnect' },
        cause: err,
      }
    );
  }

  // Persist BEFORE returning. Zoom has already invalidated the previous refresh
  // token, so losing this write locks the host out permanently.
  saveHostRecord({
    ...record,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken ?? record.refreshToken,
    expiresAt: fresh.expiresAt,
    scopes: fresh.scopes.length ? fresh.scopes : record.scopes,
  });

  return fresh.accessToken;
}

export async function getAccessTokenForHost(hostId) {
  const record = getHostRecord(hostId);
  if (!record?.refreshToken) throw notConnected(hostId);

  if (record.accessToken && Date.now() < record.expiresAt - REFRESH_MARGIN_MS) {
    return record.accessToken;
  }

  if (!inFlight.has(hostId)) {
    inFlight.set(
      hostId,
      doRefresh(hostId, record).finally(() => inFlight.delete(hostId))
    );
  }
  return inFlight.get(hostId);
}

/** Force the next call for this host to refresh (used after an unexpected 401). */
export function invalidateHostToken(hostId) {
  const record = getHostRecord(hostId);
  if (record) saveHostRecord({ ...record, accessToken: null, expiresAt: 0 });
  inFlight.delete(hostId);
}

/** Scopes Zoom actually granted this host, or [] if unknown. */
export function grantedScopesForHost(hostId) {
  return getHostRecord(hostId)?.scopes ?? [];
}

export function tokenStatusForHost(hostId) {
  const record = getHostRecord(hostId);
  if (!record) return { connected: false };
  return {
    connected: Boolean(record.refreshToken),
    accessTokenCached: Boolean(record.accessToken),
    expiresInSeconds: record.expiresAt
      ? Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000))
      : 0,
    scopeCount: (record.scopes ?? []).length,
  };
}
