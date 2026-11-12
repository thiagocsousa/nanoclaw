#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
O emissor de NFS-e recusa item que já tem nota?

⛔ Em 12/11/2026 foram emitidas SEIS notas para três serviços da mesma
paciente. O coletor deduplicava por `receita_id`; o emissor não, porque ele
escolhe por ÍNDICE da lista pendente — reaprovar a mesma lista emitia de novo.
E `emitir_com_protecao` não salva: a idempotência dele é por `id_dps`, derivado
do contador `nDPS`, então contador novo dá nota nova.

Este checador roda o `main()` do emissor de verdade, SEM certificado no
ambiente. O sentinela é a própria recusa do certificado:

- trava funcionou  → `main()` retorna antes de `cert_path()`, e a mensagem
  "NFSE_CERT_B64 não definido" NÃO aparece;
- trava falhou     → chega em `cert_path()` e a mensagem aparece.

Assim o teste não precisa de certificado falso, e em nenhum caminho toca a
rede ou a prefeitura.

Rodar o código real, e não uma cópia da regra, é deliberado: foi uma cópia da
regra que deixou o `send_avaliacao` quebrado por seis meses.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
EMISSOR = (
    AQUI.parent
    / "groups"
    / "whatsapp_atendimento-dra-marina"
    / "scripts"
    / "nfse_emitir_pipeline.py"
)

TOMADOR = {
    "nome": "PACIENTE DE TESTE",
    "doc": "02696519340",
    "tipo": "PF",
    "endereco": {
        "logradouro": "Rua Qualquer",
        "numero": "1",
        "bairro": "Centro",
        "cep": "64000000",
        "cidade": "Teresina",
        "codigo_municipio": "2211001",
    },
}


def item(n, receita_id, servico="consulta", valor="430.00"):
    return {
        "n": n,
        "receita_id": receita_id,
        "origem": "direto",
        "servico": servico,
        "valor": valor,
        "pay_date": "2026-11-11",
        "paciente": "PACIENTE DE TESTE",
        "tomador": TOMADOR,
    }


def roda(grupo, selecao):
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("NFSE_CERT_B64", "NFSE_CERT_PASSWORD")
    }
    env["NANOCLAW_GROUP_DIR"] = str(grupo)
    env["NFSE_AMBIENTE"] = "homologacao"
    r = subprocess.run(
        [sys.executable, str(EMISSOR), selecao],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def cenario(itens, emitidas, selecao):
    with tempfile.TemporaryDirectory() as td:
        g = Path(td)
        (g / "pending_nfse.json").write_text(
            json.dumps({"janela": ["2026-11-01", "2026-11-12"], "itens": itens,
                        "sem_cpf": []}),
            encoding="utf-8",
        )
        (g / "nfse_emitidas.json").write_text(
            json.dumps(emitidas), encoding="utf-8"
        )
        return roda(g, selecao)


CHEGOU = "NFSE_CERT_B64 não definido"


def main():
    falhas = []

    # 1. Todos já emitidos → recusa tudo e NÃO chega ao emissor.
    code, saida = cenario(
        [item(1, "agenda-1-1212102"), item(2, "agenda-1-1212181", "topografia")],
        ["agenda-1-1212102", "agenda-1-1212181"],
        "1,2",
    )
    if "JÁ EMITIDO" not in saida:
        falhas.append("seleção toda já emitida: não avisou (saída: %r)" % saida[:200])
    if CHEGOU in saida:
        falhas.append(
            "seleção toda já emitida CHEGOU AO EMISSOR — a trava não barrou"
        )

    # 2. Mistura: o emitido é barrado, o novo segue (e aí sim bate no modo).
    code, saida = cenario(
        [item(1, "agenda-1-1212102"), item(2, "agenda-2-1212102")],
        ["agenda-1-1212102"],
        "1,2",
    )
    if "JÁ EMITIDO" not in saida or "agenda-1-1212102" not in saida:
        falhas.append("mistura: não avisou o item repetido (saída: %r)" % saida[:200])
    if CHEGOU not in saida:
        falhas.append(
            "mistura: o item NOVO também foi barrado — a trava barrou demais"
        )

    # 3. Nada emitido antes → nada barrado.
    code, saida = cenario([item(1, "agenda-9-1212102")], [], "1")
    if "JÁ EMITIDO" in saida:
        falhas.append("lista limpa: barrou item que nunca foi emitido")
    if CHEGOU not in saida:
        falhas.append("lista limpa: não chegou ao emissor (saída: %r)" % saida[:200])

    for f in falhas:
        print("FALHA: %s" % f)
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
