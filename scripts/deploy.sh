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

echo "[4/4] pm2 restart..."
pm2 startOrRestart ecosystem.config.cjs --update-env

echo ""
echo "Deploy concluído."
pm2 show nanoclaw | grep -E "status|uptime|restart"
