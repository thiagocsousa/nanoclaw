#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Envia o DANFSE (PDF) da NFS-e pro WhatsApp do paciente, como DOCUMENTO anexado,
com a mensagem da clínica. Chamado por uma task 'once' agendada pelo emissor.

Uso: python3 send_nota.py <entrega_id>
Lê /workspace/group/entregas/<id>.json ({telefone, paciente, pdf, chat_jid_paciente,
group_folder}) e escreve uma mensagem IPC type=document.
"""
import json
import os
import sys
import time
import random
import string
from pathlib import Path

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
ENTREGAS_DIR = Path(GROUP) / "entregas"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

MSG = (
    "Olá, sr(a) {nome}!\n\n"
    "Segue em anexo a Nota Fiscal referente ao seu serviço oftalmológico na "
    "Clínica Dra. Marina Costa.\n\n"
    "Permanecemos à disposição caso necessite de qualquer esclarecimento.\n\n"
    "Atenciosamente,\n*Equipe da Clínica Dra. Marina Costa*"
)


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def primeiro_nome(nome):
    p = (nome or "").strip().split()
    return p[0].capitalize() if p else ""


def write_ipc_message(data):
    IPC_MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_MESSAGES_DIR / f"{int(time.time()*1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(fp)


def main():
    if len(sys.argv) < 2:
        print("Uso: send_nota.py <entrega_id>", file=sys.stderr)
        sys.exit(1)
    ent_file = ENTREGAS_DIR / f"{sys.argv[1]}.json"
    if not ent_file.exists():
        print(f"Entrega não encontrada: {ent_file}", file=sys.stderr)
        sys.exit(1)
    ent = json.loads(ent_file.read_text())

    write_ipc_message({
        "type": "document",
        "chatJid": ent["chat_jid_paciente"],
        "filePath": ent["pdf"],
        "fileName": "Nota_Fiscal.pdf",
        "caption": MSG.format(nome=primeiro_nome(ent.get("paciente"))),
        "groupFolder": ent.get("group_folder", "whatsapp_atendimento-dra-marina"),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    })
    ent_file.unlink()
    print(f"Nota enviada ao paciente {ent.get('paciente')} ({ent['chat_jid_paciente']}).")


if __name__ == "__main__":
    main()
