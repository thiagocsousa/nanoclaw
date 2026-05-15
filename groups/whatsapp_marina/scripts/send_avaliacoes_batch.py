#!/usr/bin/env python3
"""
Agenda envio escalonado de mensagens de avaliação.
Cria uma task IPC 'once' por paciente com delay aleatório (60-180s) entre cada envio.
Uso: python3 send_avaliacoes_batch.py "1,3,5" | "todos" | "nenhum"
"""

import json
import os
import random
import string
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

PENDING_FILE = Path("/workspace/group/pending_avaliacao.json")
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")

TZ_OFFSET = timezone(timedelta(hours=-3))  # America/Fortaleza


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time() * 1000)}-{rand_id()}.json"
    filepath = IPC_TASKS_DIR / filename
    tmp = Path(str(filepath) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(filepath)
    time.sleep(0.05)  # evita colisão de timestamp nos filenames


def main():
    if len(sys.argv) < 2:
        print("Uso: send_avaliacoes_batch.py 'indices|todos|nenhum'", file=sys.stderr)
        sys.exit(1)

    selecao = sys.argv[1].strip().lower()

    if not PENDING_FILE.exists():
        print("Erro: pending_avaliacao.json não encontrado.", file=sys.stderr)
        sys.exit(1)

    pending = json.loads(PENDING_FILE.read_text())
    consultas = pending["consultas"]
    data_dia = pending["data"]
    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "whatsapp_marina")

    if selecao == "nenhum":
        PENDING_FILE.unlink()
        print("Nenhum envio solicitado.")
        return

    if selecao == "todos":
        selecionados = consultas
    else:
        try:
            indices = [int(x.strip()) - 1 for x in selecao.replace(",", " ").split()]
            selecionados = [consultas[i] for i in indices if 0 <= i < len(consultas)]
        except (ValueError, IndexError) as e:
            print(f"Erro ao interpretar seleção '{selecao}': {e}", file=sys.stderr)
            sys.exit(1)

    com_tel = [p for p in selecionados if p.get("telefone")]
    sem_tel = [p for p in selecionados if not p.get("telefone")]

    if not com_tel:
        PENDING_FILE.unlink()
        print("Nenhum paciente selecionado tem telefone cadastrado.")
        if sem_tel:
            print(f"Sem telefone: {', '.join(p['nome'] for p in sem_tel)}")
        return

    now_local = datetime.now(TZ_OFFSET)
    accumulated = timedelta(0)
    agendados = []

    for i, paciente in enumerate(com_tel):
        if i > 0:
            accumulated += timedelta(seconds=random.randint(60, 180))

        send_at = now_local + accumulated
        send_at_str = send_at.strftime("%Y-%m-%dT%H:%M:%S")  # local, sem Z

        script = (
            f'python3 /workspace/group/scripts/send_avaliacao.py '
            f'"{paciente["nome"]}" "{paciente["telefone"]}"'
        )

        write_ipc_task({
            "type": "schedule_task",
            "taskId": f"avaliacao-{int(time.time() * 1000)}-{rand_id()}",
            "prompt": "<internal>Avaliação agendada enviada.</internal>",
            "script": script,
            "schedule_type": "once",
            "schedule_value": send_at_str,
            "context_mode": "isolated",
            "targetJid": chat_jid,
            "createdBy": group_folder,
            "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        })

        agendados.append((paciente["nome"], send_at.strftime("%H:%M")))

    PENDING_FILE.unlink()

    lines = [f"✅ *{len(agendados)}* avaliação(ões) agendada(s) — {data_dia}:"]
    for nome, hora in agendados:
        lines.append(f"• {nome} — {hora}")
    if sem_tel:
        lines.append(f"\n⚠️ Sem telefone (não enviado): {', '.join(p['nome'] for p in sem_tel)}")

    print("\n".join(lines))


main()
