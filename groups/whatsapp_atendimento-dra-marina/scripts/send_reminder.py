#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Envia UM lembrete de consulta (template fixo) ao paciente via IPC NanoClaw.
Chamado por uma task 'once' agendada pelo lembrete_coletar.py.

Uso: python3 send_reminder.py "Nome Paciente" "5586999999999" "segunda-feira" "18/08" "14:00"

O texto é 100% fixo — nenhum conteúdo é gerado por LLM. Sai do número do
atendimento (groupFolder). A resolução de JID (9º dígito/LID) acontece no
sendMessage do core. Imprime {"wakeAgent": false} para NÃO acordar o agente.
"""
import json
import random
import string
import sys
import time
from pathlib import Path

IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

TEMPLATE = (
    "Olá, *{primeiro_nome}*! 😊\n\n"
    "Passando para lembrar da sua consulta com a *Dra. Marina Costa* na "
    "*{dia_semana}, {data}*, às *{hora}*.\n\n"
    "Podemos confirmar sua presença? É só responder:\n"
    "✅ *SIM* — está confirmado\n"
    "🔄 *NÃO* — preciso remarcar\n\n"
    "Qualquer dúvida, estamos à disposição. Até lá!\n"
    "_Consultório Dra. Marina Costa_"
)


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def main():
    if len(sys.argv) < 6:
        print("Uso: send_reminder.py 'Nome' 'telefone' 'dia_semana' 'data' 'hora'",
              file=sys.stderr)
        print(json.dumps({"wakeAgent": False}))
        sys.exit(1)

    nome, telefone, dia_semana, data, hora = sys.argv[1:6]
    primeiro_nome = (nome.strip().split() or ["paciente"])[0].capitalize()
    jid = f"{telefone}@s.whatsapp.net"

    msg = TEMPLATE.format(
        primeiro_nome=primeiro_nome, dia_semana=dia_semana, data=data, hora=hora
    )

    IPC_MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_MESSAGES_DIR / f"{int(time.time() * 1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps({
        "type": "message",
        "chatJid": jid,
        "text": msg,
        "groupFolder": "whatsapp_atendimento-dra-marina",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }, ensure_ascii=False, indent=2))
    tmp.rename(fp)

    # wakeAgent:false — o envio é mecânico, o agente não deve ser acordado.
    print(json.dumps({"wakeAgent": False}))


if __name__ == "__main__":
    main()
