#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Container entrypoint for the Lot Agent Node image.
# Picks the process to run from $ROLE:
#   ROLE=server  (default) → HTTP API   (packages/server/dist/index.js)
#   ROLE=worker            → job worker  (packages/server/dist/workers/index.js)
# Before starting, waits for PostgreSQL (and Redis, if configured) to accept
# TCP connections so we don't crash-loop while infra is still booting.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROLE="${ROLE:-server}"

# Wait for a TCP host:port to become reachable. Args: <name> <host> <port>
wait_for_tcp() {
  local name="$1" host="$2" port="$3"
  local timeout="${WAIT_TIMEOUT:-60}"
  local waited=0
  echo "[entrypoint] waiting for ${name} at ${host}:${port} ..."
  until (echo > "/dev/tcp/${host}/${port}") 2>/dev/null; do
    waited=$((waited + 1))
    if [ "${waited}" -ge "${timeout}" ]; then
      echo "[entrypoint] ERROR: ${name} not reachable after ${timeout}s" >&2
      exit 1
    fi
    sleep 1
  done
  echo "[entrypoint] ${name} is up."
}

# PostgreSQL is required for both roles.
if [ -n "${PG_HOST:-}" ]; then
  wait_for_tcp "postgres" "${PG_HOST}" "${PG_PORT:-5432}"
fi

# Redis is required for the worker and for queue/cache; wait when host is given.
if [ -n "${REDIS_HOST:-}" ]; then
  wait_for_tcp "redis" "${REDIS_HOST}" "${REDIS_PORT:-6379}"
fi

case "${ROLE}" in
  server)
    echo "[entrypoint] starting HTTP server"
    exec node packages/server/dist/index.js
    ;;
  worker)
    echo "[entrypoint] starting job worker"
    exec node packages/server/dist/workers/index.js
    ;;
  *)
    echo "[entrypoint] ERROR: unknown ROLE='${ROLE}' (expected 'server' or 'worker')" >&2
    exit 1
    ;;
esac
