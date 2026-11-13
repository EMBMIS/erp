# Single-container image for Cloud Run.
#
# Cloud Run runs exactly one container per service and routes all traffic to
# one port, so the frontend + backend + nginx split in docker-compose.yml has
# nowhere to live here. This image builds the SPA and serves it from the
# Express process (SERVE_STATIC=true), which also means the API is same-origin
# and CORS stops mattering.
#
# docker-compose.yml is unaffected and still uses backend/Dockerfile. This file
# exists because Cloud Run's build configuration asks for /Dockerfile at the
# repo root.
#
# Build context is the repo root:
#   docker build -t qira-erp .
#   docker run -p 8080:8080 -e DATABASE_URL=... -e JWT_SECRET=... qira-erp

# ---------------------------------------------------------------------------
# Stage 1 — build the SPA
# ---------------------------------------------------------------------------
FROM node:20-alpine AS frontend

WORKDIR /build

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./

# Relative, not an absolute host. The API is served by the same origin in this
# image, so baking in a hostname would break the moment the Cloud Run URL or
# custom domain changes - and it is baked at BUILD time by Vite, so it could
# not be corrected with an env var at deploy time.
ENV VITE_API_URL=/api
RUN npx vite build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
# Debian (glibc), NOT alpine — same reason as backend/Dockerfile:
# onnxruntime-node's prebuilt binaries are glibc-linked and die on musl with
# ERR_DLOPEN_FAILED, taking the AI chat route down with them.
FROM node:20-slim

# dumb-init gives PID 1 real signal handling. Without it Node runs as PID 1 and
# ignores SIGTERM by default, so Cloud Run's shutdown signal is dropped, the
# graceful-shutdown handler in server.js (stop accepting connections, drain
# in-flight requests, close the DB pool) never runs, and in-flight transactions
# are cut off mid-flight rather than rolled back.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
COPY --from=frontend /build/dist ./public

# Drop root. `node` (uid 1000) ships with the base image.
#
# NOTE: uploads/ and exports/ are container-local and Cloud Run's filesystem is
# ephemeral - anything written there is lost on restart and is not shared
# between instances. Any feature that persists a file needs GCS (or a mounted
# volume) before it works correctly on more than one instance. Left as-is here
# because fixing it is an application change, not a packaging one.
RUN mkdir -p uploads exports && chown -R node:node uploads exports
USER node

ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV STATIC_ROOT=/app/public

# Cloud Run injects PORT (8080 by default) and server.js already honours it;
# this is the local-run default only.
ENV PORT=8080
EXPOSE 8080

# No HEALTHCHECK: Cloud Run ignores the Docker healthcheck and runs its own
# startup/liveness probes against the container port. Point those at /health.
ENTRYPOINT ["dumb-init", "--"]
# Apply pending migrations before serving traffic, mirroring the compose
# stack's gated `migrate` service. db-migrate.js is the tracked runner:
# idempotent, per-migration transactions, and guarded by an advisory lock so
# concurrent Cloud Run cold starts serialize instead of racing. It exits 0
# within a second on an up-to-date database, so the per-instance boot cost is
# negligible. If migrations cannot run (e.g. DATABASE_URL lacks DDL rights),
# the container fails loudly rather than serving against a stale schema —
# point MIGRATION_DATABASE_URL at an owner connection in that case (see
# scripts/db-migrate.js header).
CMD ["sh", "-c", "node scripts/db-migrate.js && node server.js"]
