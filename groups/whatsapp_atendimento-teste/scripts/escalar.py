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
import urllib.request
from pathlib import Path

GROUP = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
LOG = GROUP / "escalonamentos.jsonl"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

# Para onde vai o aviso. No teste, o próprio Thiago; em produção, o grupo da
# recepção. Nunca é um JID de paciente.
DESTINO = os.environ.get("ESCALONAMENTO_JID", "558681512111@s.whatsapp.net")
DESTINO_FOLDER = os.environ.get("ESCALONAMENTO_FOLDER", "whatsapp_main")

# Alarme sonoro (ntfy.sh). Toca em volume de alarme no celular, furando o
# silencioso — é o substituto gratuito da ligação telefônica.
# Só dispara em URGENTE: alarme que toca por qualquer dúvida vira ruído e, em
# pouco tempo, ninguém olha mais.
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
NTFY_SERVIDOR = os.environ.get("NTFY_SERVIDOR", "https://ntfy.sh")


def toca_alarme():
    """Dispara o alarme. NUNCA manda dado de paciente.

    ⚠️ O ntfy.sh público é servidor de TERCEIRO e o tópico é legível por quem
    souber o nome. Por isso o texto é genérico — sem nome, sem sintoma, sem
    telefone. Quem for atender abre o WhatsApp para ver o caso. Dado de saúde
    não sai daqui. (Para mandar detalhe, auto-hospedar o ntfy na própria VM.)
    """
    if not NTFY_TOPIC:
        return "sem NTFY_TOPIC configurado"
    try:
        req = urllib.request.Request(
            "%s/%s" % (NTFY_SERVIDOR.rstrip("/"), NTFY_TOPIC),
            data="Abra o WhatsApp da clinica".encode("utf-8"),
            headers={
                "Title": "ATENDIMENTO URGENTE",
                "Priority": "urgent",
                "Tags": "rotating_light",
            },
        )
        urllib.request.urlopen(req, timeout=10).read()
        return "alarme disparado"
    except Exception as exc:
        # Alarme é um canal A MAIS. Se falhar, o aviso no WhatsApp já foi — não
        # pode derrubar o escalonamento.
        return "alarme falhou: %s" % type(exc).__name__


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

    alarme = toca_alarme() if urgente else "não urgente, sem alarme"
    print("escalado%s: %s | %s" % (" (URGENTE)" if urgente else "", motivo, alarme))
    return 0


if __name__ == "__main__":
    sys.exit(main())
