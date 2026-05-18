#!/usr/bin/env python3
"""
Envia mensagem de avaliação a um paciente via IPC NanoClaw.
Uso: python3 send_avaliacao.py "Nome Paciente" "558599999999"
"""

import json
import random
import string
import sys
import time
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        print("Uso: send_avaliacao.py 'Nome' 'telefone_com_ddi'", file=sys.stderr)
        sys.exit(1)

    nome_completo = sys.argv[1]
    primeiro_nome = nome_completo.split()[0]
    telefone = sys.argv[2]
    jid = f"{telefone}@s.whatsapp.net"

    msg = (
        f"Olá, *{primeiro_nome}*, tudo bem? Esperamos que tenha ido tudo bem na consulta. 😊 "
        f"Se tiver um tempinho livre, poderia deixar uma avaliação no Google sobre a sua experiência? "
        f"Ela é importante para ajudar outras pessoas a encontrarem o nosso consultório. "
        f"Leva menos de 1 minuto 👇\n"
        f"https://g.page/r/CdVKgz3jItQ7EBE/review"
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

    print(f"✓ Avaliação enviada para {nome} ({jid})")


main()
