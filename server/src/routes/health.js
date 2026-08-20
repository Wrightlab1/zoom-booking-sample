import { Router } from 'express';

import { config } from '../config.js';
import { listConnectedHosts } from '../zoom/tokenStore.js';
import { tokenStatusForHost, grantedScopesForHost } from '../zoom/tokens.js';

export const healthRouter = Router();

healthRouter.get('/health', (req, res) => {
  const hosts = listConnectedHosts();
  res.json({
    status: 'ok',
    env: config.server.env,
    auth: 'user-level OAuth (authorization_code)',
    zoom: { apiBase: config.zoom.apiBase, redirectUri: config.zoom.redirectUri },
    connectedHosts: hosts.length,
    ...(hosts.length ? {} : { hint: 'No hosts connected yet. Visit /api/auth/connect.' }),
  });
});

/**
 * Per-host readiness: token freshness, granted scopes, and whether the host has
 * a Scheduler profile. Run this first when /api/hosts looks wrong.
 */
healthRouter.get('/health/scheduler-readiness', (req, res) => {
  const hosts = listConnectedHosts().map((h) => {
    const granted = grantedScopesForHost(h.userId);
    return {
      userId: h.userId,
      email: h.email,
      displayName: h.displayName,
      schedulerSlug: h.schedulerSlug ?? null,
      hasSchedulerProfile: Boolean(h.schedulerSlug),
      token: tokenStatusForHost(h.userId),
      missingScopes: config.zoom.scopes.filter((s) => !granted.includes(s)),
    };
  });

  res.json({
    summary: {
      connected: hosts.length,
      withSchedulerProfile: hosts.filter((h) => h.hasSchedulerProfile).length,
      needingReconnect: hosts.filter((h) => !h.token.connected).length,
    },
    hosts,
  });
});
