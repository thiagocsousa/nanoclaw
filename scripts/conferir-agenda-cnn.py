#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Confere se a agenda da Dra. Marina na Clínica nas Nuvens bate com a regra real.

## Por que existe

Em 24/10/2026, varrendo a semana pela API, a CNN devolvia grade cheia
(08:00–18:00) em TODOS os dias, inclusive sábado e domingo. A agenda não estava
configurada. Se a Lara passasse a oferecer horário a partir dessa grade, ela
ofereceria domingo — e o paciente iria à clínica sem médica.

Configurar é trabalho de tela (o único endpoint que mexe nisso é do módulo
clínica-escola, carrega permissões de acesso junto e não tem GET para ler o
estado atual — escrita cega não se faz em conta de produção). Conferir, sim, é
trabalho de API, e é isto aqui.

## O que ele NÃO faz

Não corrige nada. Só compara e diz onde difere.

Uso:
  CNN_CLIENT_ID=... CNN_CLIENT_SECRET=... CNN_CID=... \\
    python3 scripts/conferir-agenda-cnn.py [--semanas 2]
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = "https://api.clinicanasnuvens.com.br"
EXECUTOR = int(os.environ.get("CNN_EXECUTOR_AGENDA", "163882"))

# ⛔ A regra real, e agora o ÚNICO lugar onde ela vive em código.
#
# O comentário anterior dizia "espelhando JANELAS de iclinic_vagas.py" — e o
# JANELAS saiu de lá na migração de 25/10, porque a janela passou a vir da
# própria CNN. O espelho ficou apontando para um dict apagado.
#
# ⚠️ E essa inversão deixou de valer em 26/10/2026. Decisão do Thiago: a agenda
# da CNN fica ABERTA, para a secretária marcar exame e cirurgia nos outros
# dias, e quem restringe CONSULTA aos horários da Marina volta a ser a Lara.
#
# Então esta tabela é as DUAS coisas agora: a expectativa contra a qual se
# confere a CNN, e — copiada em
# `groups/whatsapp_atendimento-teste/scripts/iclinic_vagas.py`, como
# `JANELAS_DE_CONSULTA` — a regra que a Lara aplica sobre a grade.
#
# ⛔ As duas cópias têm de ser idênticas, e divergir é o pior caso: mudar o
# horário da quarta em uma só faz este script dizer "agenda ok" enquanto a Lara
# oferece noutro turno. `src/janela-de-consulta.test.ts` falha quando
# discordam. Cópia existe porque script de grupo não importa script do
# repositório — só `/workspace/group` é montado.
JANELAS = {
    0: [("08:00", "12:00")],   # segunda
    2: [("14:00", "18:00")],   # quarta (mudou em 24/10/2026)
    4: [("08:00", "12:00")],   # sexta
}
DIAS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]

# Decidido em 24/10/2026: tudo 20 minutos, inclusive particular (eram 30).
DURACAO_ESPERADA = 20


def pega(caminho):
    cid = os.environ.get("CNN_CID")
    usuario = os.environ.get("CNN_CLIENT_ID")
    senha = os.environ.get("CNN_CLIENT_SECRET")
    if not (cid and usuario and senha):
        sys.exit("faltam CNN_CLIENT_ID, CNN_CLIENT_SECRET e CNN_CID no ambiente")
    req = urllib.request.Request(f"{BASE}{caminho}")
    cred = base64.b64encode(f"{usuario}:{senha}".encode()).decode()
    req.add_header("Authorization", f"Basic {cred}")
    req.add_header("clinicaNasNuvens-cid", cid)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        sys.exit(f"HTTP {exc.code} em {caminho}: {exc.read()[:200]}")


def minutos(hhmm):
    h, m = hhmm.split(":")[:2]
    return int(h) * 60 + int(m)


def esperado(d):
    """Os minutos que DEVEM estar disponíveis neste dia, pela regra real."""
    fora = set()
    for ini, fim in JANELAS.get(d.weekday(), []):
        fora.update(range(minutos(ini), minutos(fim), DURACAO_ESPERADA))
    return fora


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--semanas", type=int, default=2)
    a = ap.parse_args()

    hoje = date.today()
    problemas = 0
    print(f"executor {EXECUTOR} · {a.semanas} semana(s) a partir de {hoje}\n")

    for i in range(a.semanas * 7):
        d = hoje + timedelta(days=i)
        slots = pega(
            f"/executor-agenda/disponibilidade?idExecutorAgenda={EXECUTOR}"
            f"&data={d.isoformat()}&dataFim={d.isoformat()}"
        )
        tem = {minutos(s["horaInicio"]) for s in slots}
        duracoes = {
            minutos(s["horaFim"]) - minutos(s["horaInicio"]) for s in slots
        }
        deve = esperado(d)

        # ⛔ O erro CARO é oferecer horário que não existe. O barato é deixar de
        # oferecer um que existe. Por isso os dois são reportados, mas só o
        # primeiro leva ⛔.
        sobra = sorted(tem - deve)
        falta = sorted(deve - tem)

        rot = f"{d.isoformat()} {DIAS[d.weekday()]:8}"
        if not deve and not tem:
            print(f"  {rot} ok (sem consultório)")
            continue
        if not sobra and not falta and duracoes <= {DURACAO_ESPERADA}:
            print(f"  {rot} ok ({len(tem)} slots)")
            continue

        problemas += 1
        print(f"  {rot} DIVERGE")
        if sobra:
            print(
                f"      ⛔ oferece {len(sobra)} horário(s) fora da regra: "
                + " ".join(f"{m//60:02d}:{m%60:02d}" for m in sobra[:8])
                + (" …" if len(sobra) > 8 else "")
            )
        if falta:
            print(
                f"      ⚠️  falta {len(falta)}: "
                + " ".join(f"{m//60:02d}:{m%60:02d}" for m in falta[:8])
                + (" …" if len(falta) > 8 else "")
            )
        if duracoes and duracoes != {DURACAO_ESPERADA}:
            print(f"      ⚠️  durações encontradas: {sorted(duracoes)} min")

    print()
    if problemas:
        print(f"{problemas} dia(s) divergindo — a agenda da CNN ainda não está pronta.")
        return 1
    print("agenda da CNN bate com a regra real.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
