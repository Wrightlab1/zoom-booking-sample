# syntax=docker/dockerfile:1
#
# Single container: Express serves the API and the built React app, so one image
# and one origin covers the whole sample.
#
# npm workspaces HOIST every dependency to the root node_modules — `server/node_modules`
# and `web/node_modules` generally do not exist. Only the root tree is copied between
# stages; copying a per-workspace folder fails the build.

# ── Stage 1: build the frontend ─────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so the dependency layer caches until they change.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build


# ── Stage 2: production dependencies only ───────────────────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# The server needs express + cors. The web workspace needs nothing at runtime —
# its output is static files. (~4 MB, versus ~200 MB with dev dependencies.)
RUN npm ci --omit=dev --workspace server --include-workspace-root


# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production

# Correct signal handling, so `docker stop` is immediate rather than a 10s timeout.
RUN apk add --no-cache dumb-init

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=build /app/web/dist ./web/dist

# Refresh tokens are written to disk, and Zoom refresh tokens are SINGLE USE.
# Without a mounted volume here, every container restart forces each host to
# re-authorise from scratch.
RUN mkdir -p /data && chown -R node:node /data /app
ENV TOKEN_STORE_PATH=/data/tokens.json
VOLUME ["/data"]

USER node
EXPOSE 3001
ENV PORT=3001

# Hits the app's own health route, which makes no Zoom calls — an unreachable
# Zoom must not mark the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/src/index.js"]
