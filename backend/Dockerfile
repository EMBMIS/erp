# Production image for the Simeli ERP API.
#
# Debian (glibc), NOT alpine. onnxruntime-node — pulled in by
# @xenova/transformers, which powers local embeddings and therefore RAG — ships
# prebuilt native binaries linked against glibc. On alpine's musl they fail to
# load with ERR_DLOPEN_FAILED, and because services/ai/agent.js requires
# ragRetrieval inside the chat request path, that killed the process mid-stream:
# nginx saw an aborted upstream and returned 502 for every AI chat message while
# the AI provider itself was perfectly healthy.
FROM node:20-slim

# dumb-init gives PID 1 real signal handling. Without it Node runs as PID 1 and
# ignores SIGTERM by default, so `docker stop` waits the full timeout and then
# kills the process — the graceful-shutdown handler in server.js (stop
# accepting connections, drain in-flight requests, close the DB pool) never
# gets to run, and in-flight transactions are cut off rather than rolled back.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first so `npm ci` is cached independently of source changes.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Drop root. `node` (uid 1000) ships with the base image. Ownership is set on
# the two directories written at runtime; the rest of the tree stays read-only
# to the application, so a compromised process cannot rewrite its own code.
RUN mkdir -p uploads exports cache && chown -R node:node uploads exports cache
USER node

# Matches the PORT default in server.js. The image previously said 5000 while
# the application listened on 3001, so the documented port was simply wrong.
EXPOSE 3001
ENV NODE_ENV=production
ENV PORT=3001

# The health router is mounted at /health, not /api/health — the old check
# polled a path that has always returned the 404 handler, so the container
# reported unhealthy no matter how well it was running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
