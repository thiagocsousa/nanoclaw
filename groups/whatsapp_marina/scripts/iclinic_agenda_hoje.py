#!/usr/bin/env python3
"""
Busca consultas atendidas hoje na Clínica nas Nuvens.
Saída (última linha stdout): JSON { wakeAgent, data: { consultas, data } }
Salva pending_avaliacao.json para a fase de seleção.
"""

import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import cnn

TZ_OFFSET = timezone(timedelta(hours=-3))  # America/Fortaleza


PENDING_FILE = Path("/workspace/group/pending_avaliacao.json")
SEEN_FILE = Path("/workspace/group/avaliacao_seen.json")


def clean_phone(raw: str) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) >= 10 and not digits.startswith("55"):
        digits = "55" + digits
    if len(digits) < 12:
        return None
    # 9 dígitos locais: remove o primeiro 9 após DDI+DDD
    if len(digits) == 13 and digits[4] == "9":
        digits = digits[:4] + digits[5:]
    return digits


def run():
    now_local = datetime.now(TZ_OFFSET)
    today = now_local.date().strftime("%Y-%m-%d")
    today_display = now_local.date().strftime("%d/%m/%Y")
    # Sem janela fixa: cada run apresenta as consultas atendidas (cp) de hoje que
    # ainda não foram apresentadas. Corrige o timing — a recepção marca "cp" aos
    # poucos, então quem era marcado depois do run da janela antiga ficava órfão.
    # Os patient_ids já apresentados hoje ficam em SEEN_FILE (resetado a cada dia).
    janela_display = f"até {now_local.strftime('%Hh%M')}"

    seen_data = {}
    if SEEN_FILE.exists():
        try:
            seen_data = json.loads(SEEN_FILE.read_text())
        except Exception:
            seen_data = {}
    if seen_data.get("date") != today:
        seen_data = {"date": today, "patient_ids": []}
    seen_ids = set(seen_data["patient_ids"])

    # ⛔ Migrado do iClinic para a Clínica nas Nuvens em 25/10/2026.
    # "Atendido" era o status `cp`; na CNN é FINALIZADO (cnn.compareceu).
    eventos = cnn.agenda(today, today)

    if "--debug" in sys.argv:
        print(f"[DEBUG] {len(eventos)} eventos hoje ({today}), janela {janela_display}:")
        for e in sorted(eventos, key=lambda x: x.get("horaInicio") or ""):
            print(f"  {e.get('horaInicio')} | status={e.get('status')!r} | "
                  f"tipo={cnn.NOME_DO_TIPO.get(e.get('idTipoConsulta'))!r} | "
                  f"paciente={e.get('idPaciente')}")
        return

    atendidos = [e for e in eventos if cnn.compareceu(e) and e.get("idPaciente")]

    if not atendidos:
        print(json.dumps(
            {"wakeAgent": False,
             "data": {"message": "Nenhuma consulta atendida hoje ainda."}}))
        return

    consultas = []
    for ev in atendidos:
        pid = ev["idPaciente"]
        if pid in seen_ids:
            continue  # já apresentado hoje num run anterior
        # ⚠️ Só CONSULTA e afins pedem avaliação. O filtro era por NOME do
        # procedimento ("solicita"/"exame" fora); agora é pelo tipo de consulta,
        # que é campo próprio — e a mesma allowlist que decide o lembrete.
        if ev.get("idTipoConsulta") not in cnn.TIPOS_DE_CONSULTA:
            continue
        cadastro = cnn.paciente(pid)
        nome = (cadastro.get("nome") or "").strip()
        if not nome:
            continue
        contato = cadastro.get("contato") or {}
        consultas.append({
            "nome": nome,
            "patient_id": pid,
            "telefone": clean_phone(
                ev.get("telefoneCelularPaciente")
                or contato.get("telefoneCelular") or ""),
            "procedimento": cnn.NOME_DO_TIPO.get(
                ev.get("idTipoConsulta"), "Consulta"),
        })

    # Deduplica por patient_id (paciente com mais de um procedimento no dia)
    seen = set()
    unique = []
    for c in consultas:
        if c["patient_id"] not in seen:
            seen.add(c["patient_id"])
            unique.append(c)
    consultas = unique

    if not consultas:
        print(
            json.dumps(
                {"wakeAgent": False,
                 "data": {"message": "Nenhuma consulta nova atendida para avaliação."}},
                ensure_ascii=False,
            )
        )
        return

    # Marca os apresentados agora como "vistos" hoje — não reaparecem no próximo run.
    seen_data["patient_ids"] = list(seen_ids | {c["patient_id"] for c in consultas})
    SEEN_FILE.write_text(json.dumps(seen_data, ensure_ascii=False, indent=2))

    pending = {
        "data": today_display,
        "timestamp": time.time(),
        "hour_captured": now_local.hour,        # hora da apresentação; gate em send_avaliacoes_batch
        "janela": janela_display,               # rótulo de hora, ex: "até 16h30"
        "expires_at": time.time() + 150 * 60,   # backup TTL — o gate primário é hour_captured
        "consultas": consultas,
    }
    PENDING_FILE.write_text(json.dumps(pending, ensure_ascii=False, indent=2))

    print(
        json.dumps(
            {"wakeAgent": True,
             "data": {"consultas": consultas, "data": today_display, "janela": janela_display}},
            ensure_ascii=False,
        )
    )


try:
    run()
except Exception as e:
    import traceback
    print(
        json.dumps(
            {"wakeAgent": False, "data": {"error": str(e), "traceback": traceback.format_exc()}}
        )
    )
