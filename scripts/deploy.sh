#!/bin/bash
set -euo pipefail

TARGET="root@192.168.1.166"
REMOTE_DIR="/opt/price-tracker"
PUBLIC_URL="https://prices.schultzsolutions.tech"

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

echo "=== Building server ==="
( cd "$ROOT_DIR/server" && npm run build )

echo "=== Building client ==="
( cd "$ROOT_DIR/client" && npm run build )

# Capture the hash of the freshly-built client bundle so we can verify
# the deploy actually replaced the live one. This is the safety net for
# the 'silent stale bundle' class of bug we hit on 2026-05-07 when a
# test file's TS error blocked vite build but deploy kept rolling.
LOCAL_BUNDLE=$(ls "$ROOT_DIR/client/dist/assets/" | grep -E '^index-[A-Za-z0-9_-]+\.js$' | head -1)
if [ -z "$LOCAL_BUNDLE" ]; then
  echo "ERROR: no client bundle found in client/dist/assets/ — vite build silently failed?" >&2
  exit 1
fi
echo "=== Local bundle: $LOCAL_BUNDLE ==="

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

echo "=== Verifying live bundle ==="
sleep 2  # let nginx/express settle after restart
LIVE_BUNDLE=$(curl -s "$PUBLIC_URL/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 | sed 's|assets/||')
if [ -z "$LIVE_BUNDLE" ]; then
  echo "ERROR: could not extract bundle name from $PUBLIC_URL/ — production HTML response unparseable" >&2
  exit 1
fi
if [ "$LIVE_BUNDLE" != "$LOCAL_BUNDLE" ]; then
  echo "ERROR: bundle hash mismatch" >&2
  echo "  Local:  $LOCAL_BUNDLE" >&2
  echo "  Live:   $LIVE_BUNDLE" >&2
  echo "Deploy did not replace the live bundle. Check rsync output, rebuild.sh logs, and CDN cache." >&2
  exit 1
fi
echo "=== Bundle verified live: $LIVE_BUNDLE ==="
echo "=== Deploy complete ==="
