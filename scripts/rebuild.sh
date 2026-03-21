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
npm run build

echo "=== Installing client dependencies ==="
cd ../client
npm ci
npm run build

echo "=== Restarting service ==="
cd "$DEPLOY_DIR"
systemctl restart price-tracker

echo "=== Done! ==="
systemctl status price-tracker --no-pager
