# ─────────────────────────────────────────────────────────────
# ShadchanAI — production image (single Node instance)
#
# Builds the whole npm-workspace monorepo (shared → server → client)
# and runs ONE Node process that serves both the API and the built
# client SPA from the same origin (CLIENT_DIST_DIR).
#
# IMPORTANT: this app is single-instance only. Baileys WhatsApp
# sessions, the send-claim lock, and the notifications buffer are all
# in-process. Run exactly ONE replica (see railway.json) and mount a
# persistent volume at WA_SESSIONS_DIR — those files ARE the WhatsApp
# credentials.
# ─────────────────────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install deps first (better layer caching). Copy every workspace
# manifest so `npm ci` can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

# Copy sources and build shared → server → client.
COPY . .
RUN npm run build

# Drop dev dependencies to slim the runtime copy.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Built artifacts + pruned production node_modules (workspace symlinks
# included so `@shadchanai/shared` resolves at runtime).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# Same-origin SPA hosting: the API process serves the built client.
ENV CLIENT_DIST_DIR=/app/client/dist
# Default sessions dir — MUST be backed by a persistent volume in prod.
ENV WA_SESSIONS_DIR=/data/wa-sessions

EXPOSE 3000
CMD ["node", "server/dist/server.js"]
