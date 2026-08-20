import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';

import { config, loadConfig } from './config.js';
import { authRouter, handleCallback } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { hostsRouter } from './routes/hosts.js';
import { bookingsRouter } from './routes/bookings.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIST = process.env.WEB_DIST || path.join(REPO_ROOT, 'web', 'dist');

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.server.corsOrigin }));
  app.use(express.json());

  // Registered redirect URIs often point at the bare origin (e.g. an ngrok URL),
  // so the OAuth callback is served from the root as well as the /api path.
  app.get('/', handleCallback);

  app.use('/api', authRouter);
  app.use('/api', healthRouter);
  app.use('/api', hostsRouter);
  app.use('/api', bookingsRouter);

  // In Docker the API also serves the built frontend, so one container and one
  // origin covers everything. In local dev the folder is absent and Vite serves
  // the UI on :5173 instead — the branch below simply does not fire.
  const hasBuild = fs.existsSync(path.join(WEB_DIST, 'index.html'));

  if (hasBuild) {
    app.use(express.static(WEB_DIST, { index: false }));
    // SPA fallback for anything that is not an API route. Registered last so it
    // cannot shadow /api or the OAuth callback.
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    // No build present: give the root a useful answer instead of a 404.
    app.get('/', (req, res) => {
      res.json({
        service: 'zoom-booking-sample',
        connect: '/api/auth/connect',
        health: '/api/health',
        note: 'No frontend build found. Run `npm run dev:web`, or `npm run build` to serve it here.',
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (isMain) {
  try {
    loadConfig({ requireCredentials: true });
  } catch (err) {
    console.error(`\n✖ ${err.message}\n`);
    process.exit(1);
  }

  createApp().listen(config.server.port, () => {
    console.log(`▸ API listening on http://localhost:${config.server.port}`);
    console.log(`▸ Health:  curl http://localhost:${config.server.port}/api/health`);
    console.log(`▸ Connect a host: open http://localhost:${config.server.port}/api/auth/connect`);
    if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
      console.log(`▸ UI served from ${WEB_DIST}`);
    }
  });
}
