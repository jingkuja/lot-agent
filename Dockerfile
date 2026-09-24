# ─────────────────────────────────────────────────────────────
# Lot Agent — Node application image (server + worker share this image).
# The running role is selected at container start by entrypoint.sh via $ROLE.
# Multi-stage: build core+server with full deps, then ship a slim prod runtime.
# ─────────────────────────────────────────────────────────────

# ---------- Stage 1: build ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable

# Install deps first (better layer caching). Copy only manifests + lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/miniprogram/package.json packages/miniprogram/package.json
RUN pnpm --filter @lot-agent/server... install --frozen-lockfile

# Copy sources needed to build the Node app (web is built in Dockerfile.web).
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server

# Build order matters: server imports @lot-agent/core's compiled dist.
RUN pnpm --filter @lot-agent/core run build \
 && pnpm --filter @lot-agent/server run build

# ---------- Stage 2: production runtime ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# Reinstall production-only dependencies from the lockfile (deterministic, slim).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/miniprogram/package.json packages/miniprogram/package.json
RUN pnpm --filter @lot-agent/server... install --prod --frozen-lockfile --ignore-scripts

# Compiled output + runtime assets (config + skills are read at startup).
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY config config
COPY skills skills
# Static assets read at runtime (e.g. the CJK font embedded into generated PDFs).
COPY assets assets

# Runtime data dir (assets/documents/uploads). Mounted as a named volume in
# compose; chown so the unprivileged `node` user can write to the empty volume.
RUN mkdir -p data/assets data/documents data/uploads data/knowledge data/tmp \
 && chown -R node:node /app/data

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
EXPOSE 3000

# Liveness probe (server role). Node 20 has global fetch; no curl/wget needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["entrypoint.sh"]
