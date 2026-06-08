#!/bin/bash
# Build-on-302 deploy. Usage: deploy-local.sh <git-sha> [--no-restart]
# Invoked by the deploy-listener after CI passes on main. Checks out the exact
# validated SHA, builds server + client locally, backs up the DB, restarts the
# service, and verifies the live bundle matches what was built.
set -euo pipefail

SHA="${1:?usage: deploy-local.sh <git-sha> [--no-restart]}"
MODE="${2:-}"

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$DEPLOY_DIR/data"
BACKUP_DIR="/opt/price-tracker-backups"
PUBLIC_URL="${DEPLOY_PUBLIC_URL:-https://prices.schultzsolutions.tech}"

cd "$DEPLOY_DIR"

echo "=== Fetching origin ==="
git fetch --quiet origin

echo "=== Checking out $SHA ==="
# Detached HEAD is intentional on the deploy box — each deploy checks out an exact SHA.
git checkout --quiet --detach "$SHA"

echo "=== Building server ==="
( cd server && npm ci --no-audit --no-fund && npm run build )

echo "=== Building client (with client/.env VITE_* vars) ==="
( cd client && npm ci --no-audit --no-fund && npm run build )

# Safety net for the 'silent stale bundle' class of bug: capture the freshly
# built bundle name so we can confirm the live site actually serves it.
LOCAL_BUNDLE=$(ls "$DEPLOY_DIR/client/dist/assets/" 2>/dev/null | grep -E '^index-[A-Za-z0-9_-]+\.js$' | head -1 || true)
if [ -z "$LOCAL_BUNDLE" ]; then
  echo "ERROR: no client bundle in client/dist/assets/ — vite build silently failed?" >&2
  exit 1
fi
echo "=== Built bundle: $LOCAL_BUNDLE ==="

if [ "$MODE" = "--no-restart" ]; then
  echo "=== --no-restart: skipping DB backup, restart, and live verify ==="
  echo "=== Dry run complete ==="
  exit 0
fi

# Back up the DB before restart (rotate, keep last 10).
if [ -f "$DATA_DIR/price-tracker.db" ]; then
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  cp "$DATA_DIR/price-tracker.db" "$BACKUP_DIR/price-tracker-$TIMESTAMP.db"
  echo "=== Database backed up: price-tracker-$TIMESTAMP.db ==="
  ls -t "$BACKUP_DIR"/price-tracker-*.db 2>/dev/null | tail -n +11 | xargs -r rm
fi

echo "=== Restarting service ==="
systemctl restart price-tracker

echo "=== Verifying live bundle ==="
sleep 2  # let nginx/express settle after restart
LIVE_BUNDLE=$(curl -s "$PUBLIC_URL/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 | sed 's|assets/||' || true)
if [ -z "$LIVE_BUNDLE" ]; then
  echo "ERROR: could not extract bundle from $PUBLIC_URL/ — production HTML unparseable" >&2
  exit 1
fi
if [ "$LIVE_BUNDLE" != "$LOCAL_BUNDLE" ]; then
  echo "ERROR: bundle mismatch — local=$LOCAL_BUNDLE live=$LIVE_BUNDLE" >&2
  echo "Live site is NOT serving the new build. Check rebuild logs and CDN cache." >&2
  exit 1
fi
echo "=== Bundle verified live: $LIVE_BUNDLE ==="
echo "=== Deploy complete: $SHA ==="
