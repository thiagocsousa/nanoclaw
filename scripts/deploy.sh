#!/bin/bash
set -e

PROJECT_DIR="${PROJECT_DIR:-$(dirname "$(dirname "$(realpath "$0")")")}"
cd "$PROJECT_DIR"

echo "=== Deploy NanoClaw ==="
echo "Dir: $PROJECT_DIR"
echo "$(date)"
echo ""

echo "[1/4] git pull..."
git pull origin main

echo "[2/4] npm ci..."
npm ci --prefer-offline

echo "[3/4] build..."
npm run build

echo "[3.5/4] seed crons..."
node scripts/seed-crons.mjs

echo "[3.6/4] container build..."
bash container/build.sh

echo "[4/4] pm2 restart..."
# Kill any stale node processes holding port 3001
STALE=$(ss -tlnp 2>/dev/null | grep ':3001' | grep -oP 'pid=\K[0-9]+' || true)
if [ -n "$STALE" ]; then
  echo "Killing stale process on port 3001 (pid $STALE)..."
  kill -9 "$STALE" 2>/dev/null || true
  sleep 1
fi
pm2 reset nanoclaw 2>/dev/null || true
pm2 startOrRestart ecosystem.config.cjs --update-env

echo ""
echo "Deploy concluído."
pm2 show nanoclaw | grep -E "status|uptime|restart"
