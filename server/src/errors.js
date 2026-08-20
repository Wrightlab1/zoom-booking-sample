/**
 * Every failure the API can return, as a closed set of codes.
 *
 * The frontend switches on `code` — never on an HTTP status or a message
 * string. `detail` is developer-facing and is only serialised outside
 * production.
 */

export const ErrorCode = {
  /** The chosen slot was taken between rendering and booking. Expected, not exceptional. */
  SLOT_TAKEN: 'SLOT_TAKEN',
  /** Booking body rejected: missing required answer, bad location kind, malformed time. */
  INVALID_BOOKING: 'INVALID_BOOKING',
  /** Booking succeeded but the follow-up meeting-details fetch did not. */
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS',
  /** Booked, but the schedule produced no Zoom meeting (wrong add_on_type). */
  NO_MEETING_LINK: 'NO_MEETING_LINK',
  /** Credentials or scopes are wrong. Developer-facing; never shown verbatim to end users. */
  CONFIG_ERROR: 'CONFIG_ERROR',
  /** Schedule or event does not exist (or was deactivated mid-flow). */
  NOT_FOUND: 'NOT_FOUND',
  /** Zoom returned 429 and retries were exhausted. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Zoom 5xx, timeout, or transport failure. */
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  /** Bad input from our own client before Zoom was ever called. */
  BAD_REQUEST: 'BAD_REQUEST',
};

export class AppError extends Error {
  /**
   * @param {string} code    one of ErrorCode
   * @param {string} message end-user safe summary
   * @param {object} [opts]
   * @param {number} [opts.status]     HTTP status to return to our client
   * @param {string} [opts.detail]     developer-facing detail (upstream message, etc.)
   * @param {object} [opts.meta]       structured extras the UI may use
   * @param {Error}  [opts.cause]
   */
  constructor(code, message, { status = 500, detail, meta, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.meta = meta;
  }

  toJSON({ includeDetail = true } = {}) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(includeDetail && this.detail ? { detail: this.detail } : {}),
        ...(this.meta ? { meta: this.meta } : {}),
      },
    };
  }
}

/** Upstream 400 on a booking: decide between "slot gone" and "body wrong". */
const VALIDATION_HINTS = [
  // Zoom's generic schema rejection. It is emphatically NOT a taken slot, and
  // misreporting it as one sends the UI into a pointless re-fetch loop.
  /failed json validation/i,
  /invalid user/i,
  /required/i,
  /invalid (request )?(body|parameter|field|format)/i,
  /missing/i,
  /must be/i,
  /malformed/i,
];

export function classifyBookingBadRequest(upstreamMessage = '') {
  // Zoom documents a single 400 for this endpoint covering both
  // "invalid request body" and "time slot has already been scheduled",
  // and does not distinguish them by sub-code. We default to SLOT_TAKEN so the
  // UI recovers gracefully, and only claim a validation error when the message
  // clearly says so. The raw upstream text always travels in `detail`.
  const looksLikeValidation = VALIDATION_HINTS.some((re) => re.test(upstreamMessage));
  return looksLikeValidation ? ErrorCode.INVALID_BOOKING : ErrorCode.SLOT_TAKEN;
}
