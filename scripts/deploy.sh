#!/bin/bash
set -e

PROJECT_DIR="${PROJECT_DIR:-$(dirname "$(dirname "$(realpath "$0")")")}"
cd "$PROJECT_DIR"

echo "=== Deploy NanoClaw ==="
echo "Dir: $PROJECT_DIR"
echo "$(date)"
echo "User: $(whoami) | Git: $(git --version)"
echo ""

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

echo "[4.5/4] limpeza docker (evita encher o disco da VM)..."
# roda DEPOIS do build/restart: remove só o lixo, preservando o cache recente
# (build rápido no próximo deploy). Imagens antigas (nanoclaw-agent já retaggeado
# vira dangling) + cache de build com mais de 7 dias. Nunca falha o deploy.
docker image prune -f 2>/dev/null || true
docker builder prune -f --filter 'until=168h' 2>/dev/null || true
docker system df 2>/dev/null | awk 'NR<=4' || true
echo "disco: $(df -h / | awk 'NR==2{print $5" usado, "$4" livre"}')"

echo ""
echo "Deploy concluído."
pm2 show nanoclaw | grep -E "status|uptime|restart"
