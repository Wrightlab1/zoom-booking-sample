/**
 * The only place that talks to the backend.
 *
 * Every failure becomes an ApiError carrying the server's stable `code`.
 * Callers switch on `err.code` — never on HTTP status or message text, both of
 * which are free to change.
 */

export class ApiError extends Error {
  constructor({ code, message, detail, meta, status }) {
    super(message || 'Something went wrong.');
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
    this.detail = detail;
    this.meta = meta;
    this.status = status;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (cause) {
    throw new ApiError({
      code: 'NETWORK',
      message: 'Could not reach the server.',
      detail: cause.message,
    });
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    throw new ApiError({ ...(body?.error ?? {}), status: res.status });
  }
  return body;
}

export const listHosts = () => request('/api/hosts');

export const getHost = (slug) => request(`/api/hosts/${encodeURIComponent(slug)}`);

export const listSlots = (slug, { from, to, timeZone }) => {
  const query = new URLSearchParams({ from, to, ...(timeZone ? { timeZone } : {}) });
  return request(`/api/hosts/${encodeURIComponent(slug)}/slots?${query}`);
};

export const createBooking = (payload) =>
  request('/api/bookings', { method: 'POST', body: payload });
