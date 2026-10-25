#!/usr/bin/env python3
"""
Busca pacientes particulares atendidos há ~1 ano que não retornaram e escreve
pending_retorno.json para a fase de seleção (Marina aprova quais enviar).
Saída (stdout): JSON { wakeAgent, data: { message, date_captured } }.
"""

import json
import os
import re
import time
from datetime import date, timedelta
from pathlib import Path
import cnn

EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

PENDING_FILE = Path("/workspace/group/pending_retorno.json")


def clean_phone(raw: str) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) >= 10 and not digits.startswith("55"):
        digits = "55" + digits
    if len(digits) < 12:
        return None
    if len(digits) == 13 and digits[4] == "9":
        digits = digits[:4] + digits[5:]
    return digits


def historico_do_paciente(pid, data_alvo, hoje_str):
    """(voltou, aniversario_particular) do histórico do paciente.

    - voltou: existe QUALQUER atendimento finalizado DEPOIS da data-aniversário.
      Na CNN, como no iClinic, retorno não tem tipo próprio — qualquer volta à
      clínica conta.
    - aniversario_particular: o atendimento da PRÓPRIA data-aniversário foi
      particular. O filtro vale só para esse, não para o histórico inteiro.

    ⚠️ Na CNN "particular" é um id de convênio (74466 PARTICULAR, 74543
    PARTICULAR DESCONTO), não uma string no nome. Comparar por id é mais
    seguro que por texto — era `"particular" in insurance_name.lower()`, que
    casaria com qualquer convênio novo que tivesse a palavra.
    """
    eventos = cnn.agenda(data_alvo, hoje_str, codigoPaciente=pid)
    voltou = any(
        cnn.compareceu(e) and (e.get("data") or "") > data_alvo for e in eventos
    )
    aniversario_particular = any(
        cnn.compareceu(e)
        and (e.get("data") or "") == data_alvo
        and e.get("idTipoConvenio") in cnn.CONVENIOS_PARTICULARES
        for e in eventos
    )
    return voltou, aniversario_particular


def run():
    today = date.today()
    target_date = today - timedelta(days=366)
    target_str = target_date.strftime("%Y-%m-%d")

    # ⛔ Migrado do iClinic para a Clínica nas Nuvens em 25/10/2026.
    #
    # ⚠️ Em 24/10 ficou decidido que o histórico NÃO migraria e este pipeline
    # ficaria 12 meses cego. Estava errado: conferido em 25/10, a CNN tem 495
    # atendimentos de 2025 e 430 de jan–ago/2026. O histórico VEIO, e o retorno
    # anual funciona desde o primeiro dia.
    hoje_str = today.strftime("%Y-%m-%d")
    attended_year_ago = [
        e for e in cnn.agenda(target_str, target_str)
        if cnn.compareceu(e) and e.get("idPaciente")
    ]

    if not attended_year_ago:
        print(json.dumps({
            "wakeAgent": False,
            "data": {"message": f"Nenhuma consulta atendida em {target_str}"},
        }))
        return

    # Deduplica por paciente (mais de um procedimento no mesmo dia)
    seen_pids: set = set()
    unique_events = []
    for e in attended_year_ago:
        pid = e["idPaciente"]
        if pid not in seen_pids:
            seen_pids.add(pid)
            unique_events.append(e)

    candidatos = []
    for ev in unique_events:
        pid = ev["idPaciente"]

        voltou, aniversario_particular = historico_do_paciente(
            pid, target_str, hoje_str)
        if voltou or not aniversario_particular:
            continue

        if ev.get("idTipoConsulta") not in cnn.TIPOS_DE_CONSULTA:
            continue

        cadastro = cnn.paciente(pid)
        nome = (cadastro.get("nome") or "").strip()
        contato = cadastro.get("contato") or {}
        phone = clean_phone(
            ev.get("telefoneCelularPaciente")
            or contato.get("telefoneCelular") or "")
        if not phone or not nome:
            continue

        candidatos.append({
            "nome": nome,
            "patient_id": pid,
            "telefone": phone,
            "procedimento": cnn.NOME_DO_TIPO.get(
                ev.get("idTipoConsulta"), "Consulta"),
        })

    if not candidatos:
        print(json.dumps({
            "wakeAgent": False,
            "data": {"message": "Nenhum paciente elegível para retorno"},
        }))
        return

    today_display = today.strftime("%d/%m/%Y")
    pending = {
        "date_captured": today.strftime("%Y-%m-%d"),
        "data": today_display,
        "timestamp": time.time(),
        "candidatos": candidatos,
    }
    PENDING_FILE.write_text(json.dumps(pending, ensure_ascii=False, indent=2))

    lines = [f"*Pacientes para retorno anual ({today_display}):*"]
    for i, c in enumerate(candidatos, start=1):
        lines.append(f"{i}. {c['nome']} — {c['procedimento']}")
    lines.append("")
    lines.append(
        "Quais devem receber a mensagem de retorno? "
        "Responda com os números (ex: *1, 3*), *todos* ou *nenhum*."
    )

    print(json.dumps(
        {"wakeAgent": True, "data": {
            "message": "\n".join(lines),
            "date_captured": pending["date_captured"],
            "total": len(candidatos),
        }},
        ensure_ascii=False,
    ))


try:
    run()
except Exception as e:
    import traceback
    print(
        json.dumps(
            {"wakeAgent": False, "data": {"error": str(e), "traceback": traceback.format_exc()}}
        )
    )
