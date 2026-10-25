#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Coletor de lembretes de consulta (véspera útil).

Roda às 15h (seg-sex). Regra exactly-once: se HOJE não é dia útil, sai; senão
ALVO = próximo dia útil (pula fim de semana + feriado). Busca a agenda do ALVO
na **Clínica nas Nuvens** (só CONSULTAS e RETORNOS — exclui cirurgia, exame e
solicitação), puxa o telefone de cada paciente (SEM adivinhar o 9º dígito — o
resolver de JID do core resolve), grava o manifesto e AGENDA os envios
escalonados chamando send_reminder.py (uma task 'once' por paciente, com jitter).

⛔ Migrado do iClinic em 25/10/2026, véspera da virada. O iClinic continua de pé
até 20/11, mas CONGELADO: a partir de segunda ninguém lança nada nele. Ler de lá
passaria a devolver agenda VAZIA, e agenda vazia neste script não dá erro — dá
silêncio. Ninguém seria lembrado e só o paciente faltando revelaria.

Imprime {"wakeAgent": false} — o agente NÃO deve ser acordado (envio mecânico).
Flag --dry-run: imprime o alvo + lista + telefones, sem manifesto e sem agendar.
"""
import json
import os
import random
import re
import string
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import cnn

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
MANIFEST_ULTIMO = Path(GROUP) / "lembrete_manifest_ultimo.json"

DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
        "sexta-feira", "sábado", "domingo"]

# ⚠️ A whitelist de "o que merece lembrete" mudou de EIXO na migração. No
# iClinic era o NOME do procedimento ("consulta", "retorno"); na CNN é o
# `idTipoConsulta`, que é campo próprio e enumerável. A regra conservadora
# continua: fora da lista, não manda. Ver TIPOS_DE_CONSULTA em cnn.py.
#
# Conferido contra a agenda real de 26 e 27/10/2026: a terça (só CIRURGIA) não
# gera lembrete nenhum, e na segunda os dois EXAMES ficaram de fora — igual ao
# que a regra antiga fazia.

# Feriados nacionais — fixos + móveis (2026–2027). NÃO cobre feriado municipal
# de Teresina (tratado como dia útil; agenda provavelmente vazia → no-op).
FERIADOS = {
    date(2026, 1, 1), date(2026, 2, 16), date(2026, 2, 17), date(2026, 4, 3),
    date(2026, 4, 21), date(2026, 5, 1), date(2026, 6, 4), date(2026, 9, 7),
    date(2026, 10, 12), date(2026, 11, 2), date(2026, 11, 15), date(2026, 11, 20),
    date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 2, 8), date(2027, 2, 9), date(2027, 3, 26),
    date(2027, 4, 21), date(2027, 5, 1), date(2027, 5, 27), date(2027, 9, 7),
    date(2027, 10, 12), date(2027, 11, 2), date(2027, 11, 15), date(2027, 11, 20),
    date(2027, 12, 25),
}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in FERIADOS


def next_business_day(d: date) -> date:
    d += timedelta(days=1)
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def normalize_phone(raw):
    """Normaliza sem ADIVINHAR o 9º dígito: só garante prefixo 55 e tira lixo.
    O resolver de JID (onWhatsApp) no core decide 13 vs 12 dígitos / LID."""
    if not raw:
        return None
    d = re.sub(r"\D", "", raw)
    if not d:
        return None
    if not d.startswith("55"):
        d = "55" + d
    if len(d) < 12:  # 55 + DDD(2) + 8 mínimos
        return None
    return d


def match_key(phone):
    """Chave de correlação estável entre 13 e 12 dígitos: 55 + DDD + últimos 8."""
    d = re.sub(r"\D", "", phone or "")
    if len(d) < 12:
        return d
    return "55" + d[2:4] + d[-8:]


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_TASKS_DIR / f"{int(time.time() * 1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(fp)
    time.sleep(0.05)


def coletar_agenda(alvo_str):
    """As consultas do dia ALVO, com nome e telefone, prontas para o lembrete.

    ⚠️ Levanta `CnnIndisponivel` em vez de devolver lista vazia. Este pipeline é
    SILENCIOSO — ninguém olha o log às 15h — e "não consegui ler a agenda" é
    indistinguível de "não há consulta amanhã" se as duas devolverem vazio. A
    primeira tem de explodir para alguém ver.
    """
    eventos = [e for e in cnn.agenda(alvo_str, alvo_str) if cnn.eh_consulta(e)]

    pacientes = []
    for ev in eventos:
        pid = ev.get("idPaciente")
        # O nome NÃO vem no evento da agenda da CNN (vem no cadastro), e o
        # lembrete usa o primeiro nome. É a única razão desta segunda chamada —
        # o telefone já viaja no evento.
        cadastro = cnn.paciente(pid)
        nome = (cadastro.get("nome") or "").strip()
        if not nome:
            continue
        contato = cadastro.get("contato") or {}
        phone = normalize_phone(
            ev.get("telefoneCelularPaciente")
            or contato.get("telefoneCelular")
            or contato.get("telefoneResidencial")
            or ""
        )
        pacientes.append({
            "nome": nome,
            "primeiro_nome": (nome.split() or ["paciente"])[0].capitalize(),
            "telefone": phone,
            "hora": (ev.get("horaInicio") or "")[:5],
            "procedimento": cnn.NOME_DO_TIPO.get(
                ev.get("idTipoConsulta"), "Consulta"),
            "patient_id": pid,
            "match_key": match_key(phone) if phone else None,
        })

    pacientes.sort(key=lambda x: x["hora"])
    # dedup por patient_id (mesmo paciente com mais de um agendamento no dia)
    seen, uniq = set(), []
    for p in pacientes:
        if p["patient_id"] in seen:
            continue
        seen.add(p["patient_id"])
        uniq.append(p)
    return uniq


def main():
    dry = "--dry-run" in sys.argv
    hoje = datetime.now(TZ).date()

    if not is_business_day(hoje):
        print(json.dumps({"wakeAgent": False,
                          "data": {"message": f"{hoje} não é dia útil — sem lembretes."}},
                         ensure_ascii=False))
        return

    alvo = next_business_day(hoje)
    alvo_str = alvo.strftime("%Y-%m-%d")
    alvo_disp = alvo.strftime("%d/%m/%Y")
    dia_semana = DIAS[alvo.weekday()]

    pacientes = coletar_agenda(alvo_str)
    com_tel = [p for p in pacientes if p.get("telefone")]
    sem_tel = [p for p in pacientes if not p.get("telefone")]

    if dry:
        print(f"[DRY-RUN] hoje={hoje} → ALVO={alvo_str} ({dia_semana}), "
              f"{len(pacientes)} consultas/retornos:")
        for p in pacientes:
            print(f"  {p['hora']} | {p['nome']:<38} | {p['telefone'] or 'SEM TEL'} "
                  f"| {p['procedimento']}")
        if sem_tel:
            print(f"  ⚠️ sem telefone: {', '.join(p['nome'] for p in sem_tel)}")
        return

    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "whatsapp_atendimento-dra-marina")
    gerado_em = datetime.now(TZ)

    # Agenda envios escalonados (jitter 90-240s entre cada) a partir de agora.
    base = gerado_em
    accum = timedelta(0)
    for i, p in enumerate(com_tel):
        if i > 0:
            accum += timedelta(seconds=random.randint(90, 240))
        send_at = (base + accum).strftime("%Y-%m-%dT%H:%M:%S")
        nome_safe = p["nome"].replace('"', "").replace("\\", "")
        script = (
            f'python3 /workspace/group/scripts/send_reminder.py '
            f'"{nome_safe}" "{p["telefone"]}" "{dia_semana}" "{alvo_disp}" "{p["hora"]}"'
        )
        write_ipc_task({
            "type": "schedule_task",
            "taskId": f"lembrete-{int(time.time() * 1000)}-{rand_id()}",
            "prompt": "<internal>Lembrete de consulta agendado.</internal>",
            "script": script,
            "schedule_type": "once",
            "schedule_value": send_at,
            "context_mode": "isolated",
            "targetJid": chat_jid,
            "createdBy": group_folder,
            "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        })

    manifest = {
        "alvo": alvo_str,
        "alvo_disp": alvo_disp,
        "dia_semana": dia_semana,
        "gerado_em": gerado_em.strftime("%Y-%m-%dT%H:%M:%S"),
        "gerado_em_epoch": gerado_em.timestamp(),
        "gerado_em_data": hoje.strftime("%Y-%m-%d"),
        "pacientes": com_tel,
        "sem_telefone": [p["nome"] for p in sem_tel],
    }
    Path(GROUP).mkdir(parents=True, exist_ok=True)
    (Path(GROUP) / f"lembrete_manifest_{alvo_str}.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2))
    MANIFEST_ULTIMO.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    print(json.dumps({"wakeAgent": False, "data": {
        "alvo": alvo_disp, "agendados": len(com_tel),
        "sem_telefone": len(sem_tel)}}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"wakeAgent": False,
                          "data": {"error": str(e), "traceback": traceback.format_exc()}},
                         ensure_ascii=False))
