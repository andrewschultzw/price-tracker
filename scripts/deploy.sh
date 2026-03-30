#!/bin/bash
set -e

TARGET="root@192.168.1.166"
REMOTE_DIR="/opt/price-tracker"

echo "=== Building locally ==="
cd "$(dirname "$0")/.."
cd server && npm run build && cd ..
cd client && npm run build && cd ..

echo "=== Syncing to CT 302 ==="
rsync -avz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='.env' \
  --exclude='.worktrees' \
  --delete \
  ./ "$TARGET:$REMOTE_DIR/"

echo "=== Running rebuild on CT 302 ==="
ssh "$TARGET" "cd $REMOTE_DIR && bash scripts/rebuild.sh"
