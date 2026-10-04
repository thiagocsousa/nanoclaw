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
# Depois de um crash, um node zumbi pode segurar a 3001 e impedir o start. Mas o
# nanoclaw gerenciado pelo pm2 TAMBÉM escuta nessa porta: em 04/10/2026 este bloco
# matou o próprio app, o pm2 perdeu a referência ("Process 0 not found") e o deploy
# terminou com o processo em "waiting restart" — reportando sucesso. Então só
# matamos quem NÃO é o processo do pm2; do dele, o restart cuida.
PM2_PID=$(pm2 jlist 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const p = JSON.parse(s).find((x) => x.name === "nanoclaw");
    process.stdout.write(String((p && p.pid) || ""));
  } catch {}
});' || true)

for PID in $(ss -tlnp 2>/dev/null | grep ':3001' | grep -oP 'pid=\K[0-9]+' | sort -u || true); do
  if [ -n "$PM2_PID" ] && [ "$PID" = "$PM2_PID" ]; then
    echo "  porta 3001 ocupada pelo nanoclaw do pm2 (pid $PID) — o restart cuida"
    continue
  fi
  echo "  matando processo órfão na porta 3001 (pid $PID)..."
  kill -9 "$PID" 2>/dev/null || true
  sleep 1
done

pm2 reset nanoclaw 2>/dev/null || true
pm2 startOrRestart ecosystem.config.cjs --update-env

# O deploy não pode dizer "sucesso" sem o app no ar — foi exatamente o que
# aconteceu em 04/10/2026. pm2 leva alguns segundos para estabilizar.
echo "[4.2/4] verificando que subiu..."
VIVO=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if [ "$(pm2 jlist 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const p = JSON.parse(s).find((x) => x.name === "nanoclaw");
    process.stdout.write(p && p.pm2_env && p.pm2_env.status === "online" ? "online" : "");
  } catch {}
});' || true)" = "online" ]; then
    VIVO="sim"; break
  fi
done
if [ -z "$VIVO" ]; then
  echo "FALHOU: nanoclaw não está online depois do restart."
  pm2 list || true
  pm2 logs nanoclaw --lines 30 --nostream 2>/dev/null | tail -30 || true
  exit 1
fi
echo "  nanoclaw online."

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
