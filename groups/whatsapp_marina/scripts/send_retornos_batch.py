#!/usr/bin/env python3
"""
Agenda envio escalonado das mensagens de retorno anual após aprovação da Marina.
Lê pending_retorno.json, valida a janela (hoje), aplica a seleção e cria uma
task IPC 'once' por paciente com delay aleatório (60-180s) entre envios.
Uso: python3 send_retornos_batch.py "1,3,5" | "todos" | "nenhum"
"""

import json
import os
import random
import string
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PENDING_FILE = Path("/workspace/group/pending_retorno.json")
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")

TZ_OFFSET = timezone(timedelta(hours=-3))  # America/Fortaleza

# Feriados nacionais brasileiros — fixos + móveis (2026–2027)
FERIADOS = {
    # 2026 — Easter: Apr 5
    date(2026, 1, 1),
    date(2026, 2, 16),  # Carnaval Segunda
    date(2026, 2, 17),  # Carnaval Terça
    date(2026, 4, 3),   # Sexta-Feira Santa
    date(2026, 4, 21),  # Tiradentes
    date(2026, 5, 1),   # Dia do Trabalho
    date(2026, 6, 4),   # Corpus Christi
    date(2026, 9, 7),   # Independência
    date(2026, 10, 12), # Nossa Sra. Aparecida
    date(2026, 11, 2),  # Finados
    date(2026, 11, 15), # Proclamação da República
    date(2026, 11, 20), # Consciência Negra
    date(2026, 12, 25), # Natal
    # 2027 — Easter: Mar 28
    date(2027, 1, 1),
    date(2027, 2, 8),
    date(2027, 2, 9),
    date(2027, 3, 26),
    date(2027, 4, 21),
    date(2027, 5, 1),
    date(2027, 5, 27),  # Corpus Christi
    date(2027, 9, 7),
    date(2027, 10, 12),
    date(2027, 11, 2),
    date(2027, 11, 15),
    date(2027, 11, 20),
    date(2027, 12, 25),
}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in FERIADOS


def get_base_send_time(now_local: datetime) -> datetime:
    """Now if today is a business day; else 13:00 of next business day."""
    d = now_local.date()
    if is_business_day(d):
        return now_local
    d += timedelta(days=1)
    while not is_business_day(d):
        d += timedelta(days=1)
    return datetime(d.year, d.month, d.day, 13, 0, 0, tzinfo=now_local.tzinfo)


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time() * 1000)}-{rand_id()}.json"
    filepath = IPC_TASKS_DIR / filename
    tmp = Path(str(filepath) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(filepath)
    time.sleep(0.05)


def main():
    if len(sys.argv) < 2:
        print("Uso: send_retornos_batch.py 'indices|todos|nenhum'", file=sys.stderr)
        sys.exit(1)

    selecao = sys.argv[1].strip().lower()

    if not PENDING_FILE.exists():
        print("Erro: pending_retorno.json não encontrado.", file=sys.stderr)
        sys.exit(1)

    pending = json.loads(PENDING_FILE.read_text())
    candidatos = pending["candidatos"]
    data_dia = pending["data"]
    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "whatsapp_marina")

    # Gate de janela: a lista precisa ser de hoje (o cron diário sobrescreve
    # o pending. Se Marina responder no dia seguinte, descarta).
    date_captured = pending.get("date_captured")
    today_str = date.today().strftime("%Y-%m-%d")
    if date_captured and date_captured != today_str:
        print(
            f"⚠️ Lista de retorno de *{data_dia}* expirou (hoje é "
            f"{date.today().strftime('%d/%m/%Y')}). Aguarde a próxima captura."
        )
        return

    if selecao == "nenhum":
        PENDING_FILE.unlink()
        print("Nenhum envio solicitado.")
        return

    if selecao == "todos":
        selecionados = candidatos
    else:
        try:
            indices = [int(x.strip()) - 1 for x in selecao.replace(",", " ").split()]
            selecionados = [candidatos[i] for i in indices if 0 <= i < len(candidatos)]
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
    base_time = get_base_send_time(now_local)
    accumulated = timedelta(0)
    agendados = []

    for i, paciente in enumerate(com_tel):
        if i > 0:
            accumulated += timedelta(seconds=random.randint(60, 180))

        send_at = base_time + accumulated
        send_at_str = send_at.strftime("%Y-%m-%dT%H:%M:%S")  # local, sem Z

        script = (
            f'python3 /workspace/group/scripts/send_retorno.py '
            f'"{paciente["nome"]}" "{paciente["telefone"]}"'
        )

        write_ipc_task({
            "type": "schedule_task",
            "taskId": f"retorno-{int(time.time() * 1000)}-{rand_id()}",
            "prompt": "<internal>Retorno anual agendado enviado.</internal>",
            "script": script,
            "schedule_type": "once",
            "schedule_value": send_at_str,
            "context_mode": "isolated",
            "targetJid": chat_jid,
            "createdBy": group_folder,
            "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        })

        agendados.append((paciente["nome"], send_at.strftime("%d/%m %H:%M")))

    PENDING_FILE.unlink()

    lines = [f"✅ *{len(agendados)}* mensagem(ns) de retorno agendada(s) — {data_dia}:"]
    for nome, quando in agendados:
        lines.append(f"• {nome} — {quando}")
    if sem_tel:
        lines.append(f"\n⚠️ Sem telefone (não enviado): {', '.join(p['nome'] for p in sem_tel)}")

    print("\n".join(lines))


main()
