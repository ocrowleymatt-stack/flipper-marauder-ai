#!/usr/bin/env bash
# Install Atlas vNext Private Staging v1 ALONGSIDE original Atlas.
# This script refuses to mutate original Atlas paths, units, or ports.
set -euo pipefail

PROTECTED_PATHS=(
  /opt/atlas-mountain
  /opt/atlas
  /var/lib/atlas
  /etc/atlas
  /var/www/atlas-mountain
  /etc/nginx/snippets/atlas-mountain-v12.conf
  /etc/nginx/snippets/atlas-mountain-root.conf
)
PROTECTED_UNITS=(atlas-nexus atlas-mountain-nexus caddy nginx)
PROTECTED_PORTS=(80 443 43101 43105)

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$ROOT_DIR/ops/staging/docker-compose.staging.yml"
ENV_FILE="${ATLAS_STAGING_ENV_FILE:-/etc/atlas-vnext-staging/staging.env}"

fail() { echo "atlas-vnext-staging: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "run as root on the Hetzner host"
[[ -f "$COMPOSE" ]] || fail "compose file missing: $COMPOSE"
command -v docker >/dev/null || fail "docker is required for isolated postgres/host"

for path in "${PROTECTED_PATHS[@]}"; do
  if [[ -e "$path" ]]; then
    echo "protected original Atlas path present (read-only for this script): $path"
  fi
done

for unit in "${PROTECTED_UNITS[@]}"; do
  if command -v systemctl >/dev/null && systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${unit}\\.service"; then
    echo "protected unit will not be restarted: ${unit}.service"
  fi
done

for port in "${PROTECTED_PORTS[@]}"; do
  if ss -lnt | awk '{print $4}' | grep -Eq ":${port}\$"; then
    echo "original listener on :${port} will not be changed"
  fi
done

if ss -lnt | awk '{print $4}' | grep -Eq ':8788$'; then
  fail "host port 8788 is already in use; pick a free port via ATLAS_STAGING_BIND/compose override rather than colliding"
fi

install -d -m 0750 -o root -g root /etc/atlas-vnext-staging
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0640 "$ROOT_DIR/ops/staging/env.staging.example" "$ENV_FILE"
  fail "created $ENV_FILE — fill secrets, then rerun. original Atlas env was not copied."
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a
[[ -n "${ATLAS_STAGING_PG_PASSWORD:-}" && "${ATLAS_STAGING_PG_PASSWORD}" != replace-with-a-long-random-password ]] || fail "set ATLAS_STAGING_PG_PASSWORD"
[[ -n "${ATLAS_SESSION_SECRET:-}" && "${ATLAS_SESSION_SECRET}" != replace-with-a-long-random-secret ]] || fail "set ATLAS_SESSION_SECRET"
[[ -n "${ATLAS_SOURCE_SHA:-}" ]] || fail "set ATLAS_SOURCE_SHA to the exact git SHA"

cd "$ROOT_DIR"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE" up -d --build

echo "staging host: http://${ATLAS_STAGING_BIND:-127.0.0.1}:8788"
echo "source SHA: $ATLAS_SOURCE_SHA"
echo "original Atlas paths and :80/:443/:43101 were not modified"
