#!/usr/bin/env bash
# Frees disk after a successful deploy: removes dangling images (old builds no container uses) and
# build cache older than 3 days. Never touches running or stopped containers, tagged images, volumes
# or networks, so other projects on the same server (e.g. Specialley) are safe.
# Run by deploy.sh once the new version is healthy. Manual use: sudo bash /opt/tharam/deploy/docker-cleanup.sh
# Skip with PRUNE=0. Keep more cache with PRUNE_CACHE_HOURS (default 72).
set -uo pipefail

if [ "${PRUNE:-1}" = "0" ]; then echo "Docker cleanup skipped (PRUNE=0)."; exit 0; fi
HOURS="${PRUNE_CACHE_HOURS:-72}"
case "$HOURS" in ''|*[!0-9]*) echo "PRUNE_CACHE_HOURS must be a whole number of hours."; exit 1;; esac

before=$(docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null || true)
echo "Cleaning up Docker: dangling images, and build cache older than ${HOURS} hours"
# Failures here never fail the deploy: the app is already running.
docker image prune -f || echo "Could not remove dangling images (continuing)."
docker builder prune -f --filter "until=${HOURS}h" || echo "Could not clear old build cache (continuing)."
after=$(docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null || true)
if [ -n "$before" ]; then printf 'Before:\n%s\nAfter:\n%s\n' "$before" "$after"; fi
exit 0
