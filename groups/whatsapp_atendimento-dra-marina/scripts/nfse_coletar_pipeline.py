#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CRON da NFS-e (roda 18:30 seg-sex). Coleta os particulares do iClinic (janela
móvel, CUMULATIVO por receita_id já emitido), salva a lista pendente e acorda o
agente pra apresentar no grupo do atendimento p/ aprovação.

Saída: última linha = JSON {wakeAgent, data} (contrato do task-scheduler).
Nada é emitido aqui. Credenciais iClinic via env ICLINIC_EMAIL/PASSWORD.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nfse_coletar as nc  # noqa: E402

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
PENDING_FILE = os.path.join(GROUP, "pending_nfse.json")
EMITIDAS_FILE = os.path.join(GROUP, "nfse_emitidas.json")
IGNORADAS_FILE = os.path.join(GROUP, "nfse_ignoradas.json")  # descartadas sem emitir
JANELA_DIAS = int(os.environ.get("NFSE_JANELA_DIAS", "45"))
# Corte "daqui pra frente": só coleta pagamentos a partir desta data (YYYY-MM-DD).
# Ignora o backlog. Se não setado, usa a janela móvel de JANELA_DIAS.
NFSE_INICIO = os.environ.get("NFSE_INICIO")


def _load_ids(path):
    if os.path.exists(path):
        return set(map(str, json.loads(open(path, encoding="utf-8").read())))
    return set()


def main():
    # dedup: exclui as JÁ EMITIDAS e as IGNORADAS (descartadas sem emitir)
    emitidas = _load_ids(EMITIDAS_FILE) | _load_ids(IGNORADAS_FILE)
    d1 = date.today().isoformat()
    d0 = NFSE_INICIO or (date.today() - timedelta(days=JANELA_DIAS)).isoformat()

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b, pg, csrf = nc.login(pw)
        out = nc.coletar(pg, csrf, d0, d1, emitidas)
        b.close()

    pend = out["diretos"] + out["cirurgias"]
    itens = []
    for i, it in enumerate(pend, 1):
        tom = it["tomador"]
        itens.append({
            "n": i,
            "receita_id": it["receita_id"],
            "origem": it["origem"],
            "servico": it["servico"],
            "valor": it["valor"],
            "pay_date": it.get("pay_date"),
            "paciente": it["paciente"],
            "tomador": tom,                       # dict completo (nome/doc/tipo/endereco/telefone)
        })

    sem_cpf = [{"paciente": x["paciente"], "servico": x["servico"], "valor": x["valor"]}
               for x in out["sem_cpf"]]

    payload = {"gerado_em": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
               "janela": [d0, d1], "itens": itens, "sem_cpf": sem_cpf}
    os.makedirs(GROUP, exist_ok=True)
    with open(PENDING_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    # dados enxutos p/ o agente montar a mensagem de aprovação
    data = {
        "total": len(itens),
        "pendentes": [{"n": x["n"], "paciente": x["paciente"], "servico": x["servico"],
                       "valor": x["valor"], "tomador": x["tomador"].get("nome"),
                       "doc": x["tomador"].get("doc"),
                       "tem_telefone": bool(x["tomador"].get("telefone"))}
                      for x in itens],
        "sem_cpf": sem_cpf,
        "janela": [d0, d1],
    }
    print(json.dumps({"wakeAgent": len(itens) > 0, "data": data}, ensure_ascii=False))


if __name__ == "__main__":
    main()
