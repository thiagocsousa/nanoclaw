#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Escala um atendimento para humano. **Isto é uma AÇÃO, não uma frase.**

## Por que existe

No primeiro teste (2026-10-03) o agente "escalou" 10 de 10 vezes — e a clínica
não ficou sabendo de nenhuma. Ele dizia ao paciente para ligar e seguia adiante.
A instrução de avisar a equipe estava no prompt, mas prompt é texto: **frase não
é ação**. Enquanto escalar não for uma ferramenta que o sistema consegue
verificar, o "fallback humano" da arquitetura não existe de fato — o trabalho
todo fica com o paciente.

Uso:
  escalar.py "<motivo curto>" "<o que o paciente perguntou>" [--urgente]

Grava em escalonamentos.jsonl (para auditoria e para medir se o agente
realmente chama) e manda a notificação para quem atende.
"""
import json
import os
import random
import string
import sys
import time
from pathlib import Path

GROUP = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
LOG = GROUP / "escalonamentos.jsonl"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

# Para onde vai o aviso. No teste, o próprio Thiago; em produção, o grupo da
# recepção. Nunca é um JID de paciente.
DESTINO = os.environ.get("ESCALONAMENTO_JID", "558681512111@s.whatsapp.net")
DESTINO_FOLDER = os.environ.get("ESCALONAMENTO_FOLDER", "whatsapp_main")


def main():
    if len(sys.argv) < 3:
        print("uso: escalar.py '<motivo>' '<pergunta do paciente>' [--urgente]",
              file=sys.stderr)
        return 2
    motivo, pergunta = sys.argv[1], sys.argv[2]
    urgente = "--urgente" in sys.argv

    registro = {
        "quando": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "motivo": motivo,
        "pergunta": pergunta,
        "urgente": urgente,
    }
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(registro, ensure_ascii=False) + "\n")

    cabecalho = "🚨 *Atendimento URGENTE*" if urgente else "🙋 *Atendimento aguardando*"
    texto = "%s\n\n*Motivo:* %s\n*Paciente perguntou:* %s" % (cabecalho, motivo, pergunta)

    IPC_MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    rid = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    fp = IPC_MESSAGES_DIR / ("%d-%s.json" % (int(time.time() * 1000), rid))
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps({
        "type": "message",
        "chatJid": DESTINO,
        "text": texto,
        "groupFolder": DESTINO_FOLDER,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.rename(fp)

    print("escalado%s: %s" % (" (URGENTE)" if urgente else "", motivo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
