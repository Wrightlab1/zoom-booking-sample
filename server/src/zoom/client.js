/**
 * The only place that talks to api.zoom.us.
 *
 * Responsibilities:
 *   - attach the bearer token (and refresh once on an unexpected 401)
 *   - retry 429 / 5xx with backoff, but ONLY for idempotent calls
 *   - translate every upstream failure into an AppError with a stable code
 *
 * The booking POST passes `idempotent: false`. A timed-out booking may well
 * have succeeded on Zoom's side, and a blind retry would double-book the host.
 *
 * Every call is made AS a connected host: `hostId` is required and selects that
 * host's OAuth token. There is no ambient account-wide credential any more.
 */

import { config } from '../config.js';
import { AppError, ErrorCode } from '../errors.js';
import { getAccessTokenForHost, invalidateHostToken } from './tokens.js';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  return exponential + Math.random() * BASE_BACKOFF_MS; // jitter
}

function buildUrl(path, query) {
  const url = new URL(`${config.zoom.apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function logRaw(label, payload) {
  if (!config.demo.logZoomResponses) return;
  console.log(`\n── zoom ${label} ──\n${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Zoom is not consistent about error shape. Most endpoints return a flat
 * `{ code, message }`, but Scheduler returns `{ error: { message, errors: [...] } }`.
 * Reading only the flat shape yields "[object Object]" and hides the real cause.
 */
function upstreamMessage(body, fallbackText) {
  if (!body || typeof body !== 'object') return fallbackText;

  const nested = body.error && typeof body.error === 'object' ? body.error : null;
  const detailed = (nested?.errors ?? body.errors ?? [])
    .map((e) => e?.message || e?.reason)
    .filter(Boolean)
    .join('; ');

  return (
    body.message ||
    nested?.message ||
    detailed ||
    body.reason ||
    body.error_description ||
    (typeof body.error === 'string' ? body.error : null) ||
    fallbackText
  );
}

/**
 * @param {string} path   e.g. '/scheduler/schedules'
 * @param {object} [opts]
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [opts.method]
 * @param {object} [opts.query]
 * @param {object} [opts.body]
 * @param {boolean} [opts.idempotent]  false disables 429/5xx retry (default true)
 * @param {(status: number, body: any) => AppError|undefined} [opts.mapError]
 *        Per-call override, used by the booking POST to classify its 400.
 * @param {string} opts.hostId  Zoom user id of the connected host to act as.
 */
export async function zoomFetch(path, opts = {}) {
  const { method = 'GET', query, body, idempotent = true, mapError, hostId } = opts;

  if (!hostId) {
    throw new AppError(ErrorCode.BAD_REQUEST, 'Internal error: no host selected for this call.', {
      status: 500,
      detail: `zoomFetch("${path}") was called without a hostId. Every Zoom call must act as a connected host.`,
    });
  }

  const url = buildUrl(path, query);

  let refreshedOnce = false;

  for (let attempt = 0; ; attempt += 1) {
    const token = await getAccessTokenForHost(hostId);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      if (idempotent && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Could not reach Zoom.', {
        status: 503,
        detail: `${method} ${path}: ${cause.message}`,
        cause,
      });
    }

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (res.ok) {
      logRaw(`${method} ${path}${url.search} → ${res.status}`, parsed);
      return parsed;
    }

    logRaw(`${method} ${path}${url.search} → ${res.status} (error)`, parsed);

    // 401: the token may have been revoked early. Refresh once and retry.
    // Safe even for non-idempotent calls — a 401 means Zoom never processed it.
    if (res.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      invalidateHostToken(hostId);
      continue;
    }

    const message = upstreamMessage(parsed, text);

    const mapped = mapError?.(res.status, parsed);
    if (mapped) throw mapped;

    if (res.status === 429 && idempotent && attempt < MAX_RETRIES) {
      await sleep(backoffDelay(attempt, res.headers.get('retry-after')));
      continue;
    }
    if (res.status >= 500 && idempotent && attempt < MAX_RETRIES) {
      await sleep(backoffDelay(attempt));
      continue;
    }

    throw toAppError(res.status, message, `${method} ${path}`);
  }
}

function toAppError(status, message, where) {
  switch (status) {
    case 401:
      return new AppError(ErrorCode.CONFIG_ERROR, 'That host needs to reconnect their Zoom account.', {
        status: 409,
        detail: `${where}: ${message}. The token was refreshed and still rejected — the host likely revoked access.`,
        meta: { action: 'reconnect' },
      });
    case 403: {
      // Scheduler returns 403 "User Not Found" when the user exists in Zoom but
      // has never been provisioned in Zoom Scheduler. That is a very different
      // fix from a missing scope, so do not conflate the two.
      const notProvisioned = /user not found/i.test(message);
      return new AppError(
        ErrorCode.CONFIG_ERROR,
        notProvisioned
          ? 'That user is not set up in Zoom Scheduler.'
          : 'The app is missing a required Zoom scope.',
        {
          status: 500,
          detail: notProvisioned
            ? `${where}: ${message}. The Zoom user exists but has no Scheduler profile. ` +
              `Most often the user was created via the API with action "custCreate" ` +
              `(login_types includes 99) and therefore cannot sign in at all — such users ` +
              `can never use Scheduler. Otherwise they simply need to open Zoom Scheduler ` +
              `once and connect a calendar. See zoom/users.js.`
            : `${where}: ${message}. The connected host did not grant a required scope — ` +
              `add it to the Marketplace app and have them re-authorise at /api/auth/connect.`,
        }
      );
    }
    case 404:
      return new AppError(ErrorCode.NOT_FOUND, 'That schedule or booking no longer exists.', {
        status: 404,
        detail: `${where}: ${message}`,
      });
    case 429:
      return new AppError(ErrorCode.RATE_LIMITED, 'Zoom is rate limiting this app. Try again shortly.', {
        status: 429,
        detail: `${where}: ${message}`,
      });
    default:
      if (status >= 500) {
        return new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Zoom is temporarily unavailable.', {
          status: 503,
          detail: `${where}: HTTP ${status} ${message}`,
        });
      }
      return new AppError(ErrorCode.BAD_REQUEST, 'Zoom rejected the request.', {
        status: 400,
        detail: `${where}: HTTP ${status} ${message}`,
      });
  }
}
