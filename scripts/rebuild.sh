#!/bin/bash
set -e

DEPLOY_DIR="/opt/price-tracker"
DATA_DIR="$DEPLOY_DIR/data"
BACKUP_DIR="/opt/price-tracker-backups"

cd "$DEPLOY_DIR"

# --- Backup database before anything else ---
if [ -f "$DATA_DIR/price-tracker.db" ]; then
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  cp "$DATA_DIR/price-tracker.db" "$BACKUP_DIR/price-tracker-$TIMESTAMP.db"
  echo "=== Database backed up: price-tracker-$TIMESTAMP.db ==="

  # Keep only last 10 backups
  ls -t "$BACKUP_DIR"/price-tracker-*.db 2>/dev/null | tail -n +11 | xargs -r rm
fi

echo "=== Installing server dependencies ==="
cd server
npm ci --production=false

echo "=== Running server tests ==="
npm test

echo "=== Building server ==="
npm run build

echo "=== Installing client dependencies ==="
cd ../client
npm ci

echo "=== Running client tests ==="
npm test

# NOTE: client is NOT rebuilt here. deploy.sh runs `vite build` locally
# with the dev machine's client/.env (which carries VITE_*-prefixed
# build-time vars like VITE_VAPID_PUBLIC_KEY) and rsyncs dist/ to the
# server. Re-building here would overwrite those bundles with a build
# that lacks the dev-side env, so we skip it. The rsynced dist/ from
# deploy.sh is what the express static handler serves.

echo "=== Restarting service ==="
cd "$DEPLOY_DIR"
systemctl restart price-tracker

echo "=== Done! ==="
systemctl status price-tracker --no-pager
