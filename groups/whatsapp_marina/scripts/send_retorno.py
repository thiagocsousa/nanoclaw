#!/usr/bin/env python3
"""
Envia mensagem de retorno anual a um paciente via IPC NanoClaw.
Uso: python3 send_retorno.py "Nome Paciente" "558599999999"
"""

import json
import random
import string
import sys
import time
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        print("Uso: send_retorno.py 'Nome' 'telefone_com_ddi'", file=sys.stderr)
        sys.exit(1)

    nome = sys.argv[1]
    telefone = sys.argv[2]
    jid = f"{telefone}@s.whatsapp.net"

    msg = (
        f"Olá *{nome}*, tudo bem? 👁️\n"
        f"Percebemos que faz mais de um ano desde a sua última consulta com a Dra. Marina Costa. "
        f"A saúde ocular precisa de atenção contínua — o acompanhamento anual é essencial para "
        f"identificar precocemente condições como glaucoma, catarata e outras alterações que muitas "
        f"vezes não apresentam sintomas no início.\n"
        f"Sua visão merece cuidado. Gostaria de agendar uma consulta de retorno com a Dra. Marina Costa?"
    )

    messages_dir = Path("/workspace/ipc/messages")
    messages_dir.mkdir(parents=True, exist_ok=True)

    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    filename = f"{int(time.time() * 1000)}-{suffix}.json"
    filepath = messages_dir / filename
    tmp_path = Path(str(filepath) + ".tmp")

    data = {
        "type": "message",
        "chatJid": jid,
        "text": msg,
        "groupFolder": "whatsapp_atendimento-dra-marina",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }

    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp_path.rename(filepath)

    print(f"✓ Retorno anual enviado para {nome} ({jid})")


main()
