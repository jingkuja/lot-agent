# ─────────────────────────────────────────────────────────────
# Lot Agent — Node application image (server + worker share this image).
# The running role is selected at container start by entrypoint.sh via $ROLE.
# Multi-stage: build core+server with full deps, then ship a slim prod runtime.
# ─────────────────────────────────────────────────────────────

# ---------- Stage 1: build ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install deps first (better layer caching). Copy only manifests + lockfile.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

# Copy sources needed to build the Node app (web is built in Dockerfile.web).
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server

# Build order matters: server imports @lot-agent/core's compiled dist.
RUN npm run build -w @lot-agent/core \
 && npm run build -w @lot-agent/server

# ---------- Stage 2: production runtime ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Reinstall production-only dependencies from the lockfile (deterministic, slim).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# Compiled output + runtime assets (config + skills are read at startup).
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY config config
COPY skills skills

# Runtime data dir (assets/documents/uploads). Mounted as a named volume in
# compose; chown so the unprivileged `node` user can write to the empty volume.
RUN mkdir -p data/assets data/documents data/uploads data/tmp \
 && chown -R node:node /app/data

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
EXPOSE 3000

# Liveness probe (server role). Node 20 has global fetch; no curl/wget needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["entrypoint.sh"]
