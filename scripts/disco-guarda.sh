#!/bin/bash
#
# Guarda de disco — roda por cron do ROOT, fora do processo do app.
#
# ⛔ Por que fora: em 11/11/2026 o disco (20 G) bateu 100% por 9 GB de build
# cache do Docker. O processo que subiu nesse instante falhou no meio do boot
# com `ENOSPC: no space left on device` — sockets abertos, scheduler vivo,
# loop de mensagens morto. Ficou surdo das 21:14 às 21:35 e ninguém soube,
# porque o monitor de SLA, que avisaria, mora dentro do processo que morreu.
#
# Alarme que vive dentro do que ele vigia não é alarme. Esta guarda é um script
# de sistema: não importa o estado do app.
#
# ⚠️ E ela PODA em vez de só avisar. Aviso depende de entrega — e a entrega
# depende do app, que é exatamente o que cai quando o disco enche. Curar não
# depende de ninguém ler. O aviso vai junto, mas como relato do que já foi
# feito, não como pedido de socorro.
set -u

PODA_EM=${DISCO_PODA_EM:-85}      # a partir daqui, poda o cache de build
FUNDO_EM=${DISCO_FUNDO_EM:-90}    # a partir daqui, raspa o resto também
CACHE_TETO=${DISCO_CACHE_TETO:-2GB}
JOURNAL_TETO=${DISCO_JOURNAL_TETO:-200M}
LOG=${DISCO_LOG:-/var/log/nanoclaw-disco.log}
PROJETO=${DISCO_PROJETO:-/home/thiagocsousa/nanoclaw/nanoclaw}
AVISA_JID=${DISCO_AVISA_JID:-558681512111@s.whatsapp.net}
AVISA_PASTA=${DISCO_AVISA_PASTA:-whatsapp_main}

uso() { df --output=pcent / | tail -1 | tr -dc '0-9'; }
livre() { df -h --output=avail / | tail -1 | tr -d ' '; }
diz() { echo "[$(date -Is)] $*" >>"$LOG"; }

ANTES=$(uso)
[ "$ANTES" -lt "$PODA_EM" ] && exit 0

diz "disco em ${ANTES}% (limite ${PODA_EM}%) — agindo"
ACOES=()

# 1. Cache de build: o reincidente. Teto por TAMANHO, não por idade — o cache
#    que encheu o disco tinha minutos de vida e sobreviveria a qualquer
#    `--filter until=`.
if command -v docker >/dev/null 2>&1; then
  if docker builder prune -f --max-used-space "$CACHE_TETO" >>"$LOG" 2>&1; then
    ACOES+=("build cache limitado a $CACHE_TETO")
  fi
  docker image prune -f >>"$LOG" 2>&1 && ACOES+=("imagens órfãs removidas")
fi

# 2. Se ainda está no fundo, raspa o journal.
if [ "$(uso)" -ge "$FUNDO_EM" ] && command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-size="$JOURNAL_TETO" >>"$LOG" 2>&1 \
    && ACOES+=("journal reduzido a $JOURNAL_TETO")
fi

DEPOIS=$(uso)
diz "disco ${ANTES}% → ${DEPOIS}% ($(livre) livre): ${ACOES[*]:-nada a fazer}"

# 3. Relata. Se o app estiver de pé, o IPC entrega; se não estiver, o relato
#    fica no arquivo e no log — e o `$LOG` é o lugar onde olhar depois de um
#    susto de disco.
FILA="$PROJETO/data/ipc/$AVISA_PASTA/messages"
if [ -d "$FILA" ]; then
  TXT="🧹 *Guarda de disco agiu na VM*
Uso: ${ANTES}% → ${DEPOIS}% (${1:-$(livre)} livre)
$(printf '• %s\n' "${ACOES[@]:-nada a fazer}")
_Limite de ação: ${PODA_EM}%. Log em ${LOG}._"
  ARQ="$FILA/$(date +%s%3N)-disco.json"
  python3 - "$ARQ" "$AVISA_JID" "$AVISA_PASTA" "$TXT" <<'PY' 2>>"$LOG"
import json, os, sys
arq, jid, pasta, texto = sys.argv[1:5]
tmp = arq + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump({"type": "message", "chatJid": jid, "text": texto,
               "groupFolder": pasta,
               "timestamp": __import__("time").strftime(
                   "%Y-%m-%dT%H:%M:%S.000Z", __import__("time").gmtime())},
              f, ensure_ascii=False)
os.rename(tmp, arq)
PY
  # O watcher roda como o dono da fila; arquivo de root ali ele não apaga.
  DONO=$(stat -c '%U:%G' "$FILA")
  chown "$DONO" "$ARQ" 2>>"$LOG" || true
  diz "aviso enfileirado em $ARQ (dono $DONO)"
fi
