/**
 * Identity of connected hosts.
 *
 * Under user-level OAuth the app acts AS each host, so there is no account-wide
 * user directory to walk. `GET /users/me` tells us who just connected.
 *
 * ── Retained note on Scheduler eligibility ──
 * Users created through the Users API with `action: "custCreate"` have no
 * password and cannot sign in, so Zoom Scheduler never provisions a profile for
 * them and every /scheduler/* call returns 403 "User Not Found". Their Zoom
 * `type` is no help — an API-created user is still type 2 (Licensed). The tell
 * is `login_types` containing 99 (API user) rather than 100 (Zoom Work email)
 * or 101 (SSO). Such a user can never complete the OAuth consent flow either,
 * so in practice they simply cannot become a host here.
 */

import { zoomFetch } from './client.js';

export const LoginType = {
  FACEBOOK: 0,
  GOOGLE: 1,
  APPLE: 24,
  MICROSOFT: 27,
  MOBILE_DEVICE: 97,
  RINGCENTRAL: 98,
  API_USER: 99,
  ZOOM_WORK_EMAIL: 100,
  SSO: 101,
};

export function isApiOnlyUser(user) {
  return (user?.login_types ?? []).includes(LoginType.API_USER);
}

/** GET /users/me — the identity behind the token we just obtained. */
export async function getMe(hostId) {
  return zoomFetch('/users/me', { hostId });
}

/** GET /scheduler/users/{userId} — Scheduler profile (slug, scheduling_url). */
export async function getSchedulerProfile(hostId, userId = 'me') {
  try {
    return await zoomFetch(`/scheduler/users/${encodeURIComponent(userId)}`, { hostId });
  } catch (err) {
    if (/user not found/i.test(err.detail ?? '')) return null;
    throw err;
  }
}

/**
 * Everything we need about a host right after they authorise.
 * `hostId` doubles as the token-store key, so it is resolved first.
 */
export async function describeHost(hostId) {
  const me = await getMe(hostId);
  const profile = await getSchedulerProfile(hostId, me.id);

  return {
    userId: me.id,
    email: me.email,
    displayName: me.display_name ?? [me.first_name, me.last_name].filter(Boolean).join(' '),
    timeZone: me.timezone ?? null,
    loginTypes: me.login_types ?? [],
    apiOnlyUser: isApiOnlyUser(me),
    schedulerProfile: profile
      ? { slug: profile.slug ?? null, schedulingUrl: profile.scheduling_url ?? null }
      : null,
  };
}
