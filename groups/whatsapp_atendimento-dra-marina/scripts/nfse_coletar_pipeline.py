#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CRON da NFS-e (roda 18:30 seg-sex). Coleta os particulares da Clínica nas Nuvens (janela
móvel, CUMULATIVO por receita_id já emitido), salva a lista pendente e acorda o
agente pra apresentar no grupo do atendimento p/ aprovação.

Saída: última linha = JSON {wakeAgent, data} (contrato do task-scheduler).
Nada é emitido aqui. Credenciais da CNN via env CNN_CLIENT_ID/SECRET/CID.
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

    # ⛔ Era Playwright + `nc.login(pw)` + `nc.coletar(pg, csrf, d0, d1, emitidas)`.
    #
    # Em 25/10/2026 eu reescrevi o `nfse_coletar.py` para a CNN (HTTP puro, sem
    # navegador) e NÃO olhei o único arquivo que o chama — este. O `nc.login`
    # deixou de existir e o `coletar` passou a receber três argumentos, então o
    # cron das 18:30 ia morrer em `AttributeError` na primeira execução depois
    # da virada.
    #
    # ⚠️ E o sintoma NÃO foi um erro visível. O `pending_nfse.json` continuou
    # no disco com a coleta de 23/10 — a última que rodou, ainda do iClinic —,
    # e a emissão seguiu lendo aquele arquivo velho. Em 26/10 a recepção
    # preencheu o bairro da paciente no sistema e o item continuou falhando com
    # "faltou xBairro", porque o cadastro vinha de um retrato de três dias
    # antes. Arquivo de ontem é indistinguível de arquivo de hoje para quem lê,
    # e foi por isso que pareceu cache.
    out = nc.coletar(d0, d1, emitidas)

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

    # cadastro incompleto (sem CPF/CNPJ ou sem CEP/município) — não emitível; traz o motivo.
    # ref "C1, C2..." + receita_id → permite descartar (deixar pra lá) os que nunca
    # serão emitidos, via nfse_ignorar.py, pra a lista não acumular.
    sem_cpf = [{"ref": f"C{i}", "receita_id": x["receita_id"],
                "paciente": x["paciente"], "servico": x["servico"], "valor": x["valor"],
                "motivo": x.get("motivo") or "cadastro incompleto"}
               for i, x in enumerate(out["sem_cpf"], 1)]

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
                       "origem": x["tomador"].get("origem"),   # 'pagador' ou 'paciente'
                       "tem_telefone": bool(x["tomador"].get("telefone"))}
                      for x in itens],
        "sem_cpf": sem_cpf,
        "janela": [d0, d1],
    }
    # aciona se há emitíveis OU bloqueadas sem CPF (pra avisar de preencher o cadastro)
    print(json.dumps({"wakeAgent": bool(itens) or bool(sem_cpf), "data": data},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
