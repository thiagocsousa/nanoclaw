#!/bin/bash
set -e

PROJECT_DIR="${PROJECT_DIR:-$(dirname "$(dirname "$(realpath "$0")")")}"
cd "$PROJECT_DIR"

echo "=== Deploy NanoClaw ==="
echo "Dir: $PROJECT_DIR"
echo "$(date)"
echo "User: $(whoami) | Git: $(git --version)"
echo ""

echo "[2/8] npm ci..."
npm ci --prefer-offline

# O build é `tsc`, que vem de devDependencies. Em 04/10/2026 a VM estava sem
# `typescript` e o build morria com "tsc: not found" — o `npm ci` acima tinha
# rodado em algum momento sem as devDeps. Checar aqui dá erro legível em vez de
# um 127 no meio do deploy.
if [ ! -x node_modules/.bin/tsc ]; then
  echo "FALHOU: node_modules/.bin/tsc não existe depois do npm ci."
  echo "  O build é tsc e ele vem de devDependencies. Rodar com NODE_ENV=production"
  echo "  ou --omit=dev deixa a VM sem como compilar."
  exit 1
fi

echo "[3/8] build..."
npm run build

echo "[4/8] seed crons..."
node scripts/seed-crons.mjs

echo "[5/8] pm2 restart..."
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
echo "[6/8] verificando que subiu..."
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

echo "[7/8] limpeza docker (libera espaco ANTES do build da imagem)..."
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

# A imagem do agente é construída DEPOIS de o app subir, de propósito.
#
# Em 05/10/2026 o build do container falhou, o `set -e` abortou o deploy antes
# do restart, e o app ficou rodando o código velho com o `dist` novo no disco —
# cinco minutos de diferença entre o processo e o arquivo. A correção do
# classificador estava compilada e não estava no ar.
#
# São duas coisas independentes: o app serve WhatsApp, a imagem serve o agente.
# Falha numa não deve deixar a outra para trás. Agora o app sobe primeiro, e um
# erro aqui ainda derruba o deploy (fica visível), mas com o app correto.
echo "[8/8] container build..."
bash container/build.sh

# ⛔ PODA DEPOIS DO BUILD — e o "depois" é o conserto.
#
# A poda do passo [7/8] roda ANTES daqui, com `--filter until=168h`. Ou seja:
# ela limpa o lixo do deploy anterior e poupa, por idade, exatamente o cache
# que o build abaixo acabou de criar. Em 11/11/2026 esse cache chegou a 9 GB,
# o disco (20 G) bateu 100%, e o processo seguinte morreu no boot com ENOSPC.
# A poda existia e corria no lugar errado da ordem.
#
# Teto por TAMANHO, não por idade: o cache que encheu o disco tinha minutos de
# vida. `--max-used-space` é o flag do Docker 29 (substituiu `--keep-storage`).
echo "[8/8b] poda do cache recém-criado (teto 2GB)..."
docker builder prune -f --max-used-space 2GB 2>/dev/null || true
docker system df 2>/dev/null | awk 'NR<=4' || true
echo "disco: $(df -h / | awk 'NR==2{print $5" usado, "$4" livre"}')"

# Guarda de disco independente do app + teto do journal. Idempotente: roda em
# todo deploy e não duplica. Precisa de sudo sem senha; sem ele, avisa e segue
# (o deploy não deve falhar por causa disto).
echo "[8/8c] guarda de disco e teto do journal..."
if sudo -n true 2>/dev/null; then
  GUARDA=/usr/local/sbin/nanoclaw-disco-guarda
  sudo install -m 0750 scripts/disco-guarda.sh "$GUARDA"
  # cron do root a cada 15 min, uma linha só
  # ⚠️ `|| true` nos dois: com `set -e`, `crontab -l` sem crontab sai 1 e o
  # `grep -v` com entrada vazia TAMBÉM sai 1 — o subshell morria antes do
  # `echo` e instalava um crontab VAZIO. O status do pipeline é o do
  # `crontab -` (0), então o deploy reportava sucesso. Visto em 12/11/2026.
  ATUAL=$(sudo crontab -l 2>/dev/null | grep -v nanoclaw-disco-guarda || true)
  LINHA="*/15 * * * * DISCO_PROJETO=$PROJECT_DIR $GUARDA >/dev/null 2>&1"
  printf '%s\n%s\n' "$ATUAL" "$LINHA" | grep -v '^$' | sudo crontab -
  sudo crontab -l | grep -q nanoclaw-disco-guarda \
    || { echo "  FALHOU: cron da guarda não ficou instalado."; exit 1; }
  # journal com teto permanente: o vacuum sozinho volta a crescer
  if ! grep -qE '^SystemMaxUse=200M' /etc/systemd/journald.conf; then
    sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
    grep -qE '^SystemMaxUse=' /etc/systemd/journald.conf \
      || echo 'SystemMaxUse=200M' | sudo tee -a /etc/systemd/journald.conf >/dev/null
    sudo systemctl restart systemd-journald 2>/dev/null || true
    sudo journalctl --vacuum-size=200M 2>/dev/null | tail -1 || true
  fi
  echo "  guarda: $GUARDA (cron */15) | journal: teto 200M"
else
  echo "  AVISO: sem sudo sem senha — guarda de disco NÃO instalada."
fi

