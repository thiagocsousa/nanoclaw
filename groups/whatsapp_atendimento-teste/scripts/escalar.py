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
PENDENTES = GROUP / "escalonamentos_pendentes.json"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

# Alfabeto do código do caso: sem 0/O, 1/I/L, 5/S, 2/Z. O código é lido em voz
# alta e digitado de volta às pressas ("ok E7K2"), então par ambíguo é baixa que
# não acontece e alarme que toca sem motivo.
ALFABETO_CODIGO = "ABCDEFGHJKMNPQRTUVWXY34679"

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


def gera_codigo(usados):
    """Código de 4 caracteres, único entre as pendências abertas."""
    for _ in range(50):
        c = "".join(random.choices(ALFABETO_CODIGO, k=4))
        if c not in usados:
            return c
    return "".join(random.choices(ALFABETO_CODIGO, k=4))


def abre_pendencia(motivo, pergunta, urgente):
    """Registra o caso para a escada de cobrança do host (3 min / 5 min).

    O host faz a escada porque ela precisa de precisão de minuto, e task
    agendada custaria um container por minuto. Aqui só se abre o caso.
    """
    try:
        atuais = json.loads(PENDENTES.read_text(encoding="utf-8"))
        if not isinstance(atuais, list):
            atuais = []
    except (OSError, json.JSONDecodeError):
        atuais = []

    codigo = gera_codigo({p.get("codigo") for p in atuais})
    atuais.append({
        "codigo": codigo,
        "quando": int(time.time() * 1000),
        "motivo": motivo,
        "pergunta": pergunta,
        "urgente": urgente,
    })
    try:
        tmp = Path(str(PENDENTES) + ".tmp")
        tmp.write_text(json.dumps(atuais, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.rename(PENDENTES)
    except OSError as exc:
        # Sem pendência não há cobrança, mas o aviso imediato ainda vale mais
        # que abortar o escalonamento inteiro.
        print("aviso: nao gravou pendencia (%s)" % exc, file=sys.stderr)
    return codigo


def main():
    if len(sys.argv) < 3:
        print("uso: escalar.py '<motivo>' '<pergunta do paciente>' [--urgente]",
              file=sys.stderr)
        return 2
    motivo, pergunta = sys.argv[1], sys.argv[2]
    urgente = "--urgente" in sys.argv

    codigo = abre_pendencia(motivo, pergunta, urgente)

    registro = {
        "quando": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "codigo": codigo,
        "motivo": motivo,
        "pergunta": pergunta,
        "urgente": urgente,
    }
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(registro, ensure_ascii=False) + "\n")

    cabecalho = "🚨 *Atendimento URGENTE*" if urgente else "🙋 *Atendimento aguardando*"
    texto = ("%s  `%s`\n\n*Motivo:* %s\n*Paciente perguntou:* %s\n\n"
             "Responda *ok %s* ao resolver. Sem baixa: cobrança em 3 min, "
             "alarme em 5 min." % (cabecalho, codigo, motivo, pergunta, codigo))

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
    print("escalado%s [%s]: %s | %s" % (
        " (URGENTE)" if urgente else "", codigo, motivo, alarme))
    return 0


if __name__ == "__main__":
    sys.exit(main())
