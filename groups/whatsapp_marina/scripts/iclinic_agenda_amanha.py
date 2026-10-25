#!/usr/bin/env python3
"""
Agenda do PRÓXIMO DIA (informativo). Roda 20h de domingo a quinta e envia pra
Dra. Marina — só pra ela saber o que vem amanhã. Nenhuma ação, nenhuma aprovação.
Saída (última linha stdout): JSON { wakeAgent, data: { data, dia_semana, total, agendamentos } }
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
import cnn

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza
EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
        "sexta-feira", "sábado", "domingo"]
# ⛔ Migrado do iClinic para a Clínica nas Nuvens em 25/10/2026. A regra de
# "não mostrar cancelado/faltou/bloqueio" agora vive em cnn.STATUS_SEM_VALOR,
# e o bloqueio deixou de ser status: na CNN é ausência de disponibilidade.


def run():
    amanha = datetime.now(TZ).date() + timedelta(days=1)
    d = amanha.strftime("%Y-%m-%d")
    d_disp = amanha.strftime("%d/%m/%Y")
    dia_semana = DIAS[amanha.weekday()]

    # A agenda inteira do dia, SEM filtrar tipo: aqui a Marina quer ver tudo
    # que está marcado — cirurgia e exame inclusive —, ao contrário do lembrete,
    # que só avisa consulta e retorno.
    eventos = [
        e for e in cnn.agenda(d, d)
        if e.get("status") not in cnn.STATUS_SEM_VALOR and e.get("idPaciente")
    ]

    if "--debug" in sys.argv:
        print(f"[DEBUG] amanhã={d} ({dia_semana}), {len(eventos)} eventos:")
        for e in sorted(eventos, key=lambda x: x.get("horaInicio") or ""):
            print(f"  {e.get('horaInicio')} status={e.get('status')!r} "
                  f"tipo={cnn.NOME_DO_TIPO.get(e.get('idTipoConsulta'), e.get('idTipoConsulta'))!r} "
                  f"convenio={e.get('idTipoConvenio')!r} paciente={e.get('idPaciente')}")
        return

    ags = []
    for ev in eventos:
        # O nome não vem no evento da CNN; vem no cadastro.
        nome = (cnn.paciente(ev["idPaciente"]).get("nome") or "").strip()
        if not nome:
            continue
        ags.append({
            "hora": (ev.get("horaInicio") or "")[:5],
            "nome": nome,
            "procedimento": cnn.NOME_DO_TIPO.get(
                ev.get("idTipoConsulta"), "Consulta"),
            "convenio": cnn.NOME_DO_CONVENIO.get(ev.get("idTipoConvenio")),
        })
    ags.sort(key=lambda x: x["hora"])

    if not ags:
        print(json.dumps({"wakeAgent": False,
                          "data": {"message": f"Sem agendamentos para {d_disp}."}},
                         ensure_ascii=False))
        return

    print(json.dumps({"wakeAgent": True,
                      "data": {"data": d_disp, "dia_semana": dia_semana,
                               "total": len(ags), "agendamentos": ags}},
                     ensure_ascii=False))


try:
    run()
except Exception as e:
    import traceback
    print(json.dumps({"wakeAgent": False,
                      "data": {"error": str(e), "traceback": traceback.format_exc()}}))
