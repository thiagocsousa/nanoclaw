#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Puller de NFs a emitir — agora a partir da Clínica nas Nuvens.

⛔ Migrado do iClinic em 25/10/2026, véspera da virada.

## O que mudou de FONTE

No iClinic a fonte era `financas/busca` (receitas pagas). A CNN não tem
endpoint de "cobrança do dia": a clínica passou a lançar a cobrança como
**ORÇAMENTO APROVADO** (decisão do Thiago, 24/10/2026), e é daí que isto lê.

A janela é a data de **APROVAÇÃO** do orçamento — o instante em que o dinheiro
foi combinado. (`tipoData=EMISSAO` nem existe na API: devolve HTTP 400.)

## O que ficou MAIS SIMPLES, e por quê

O iClinic exigia parear uma receita de "honorário" com uma cirurgia REALIZADA na
agenda, porque a receita sozinha não dizia se a cirurgia aconteceu. Na CNN o
orçamento aprovado **é** o registro da cobrança, e ele já traz os procedimentos.
Não há o que parear.

⚠️ Isso é uma SUPOSIÇÃO sobre como a clínica vai lançar cirurgia, e não deu
para verificar: em 25/10 não havia **nenhum** orçamento na CNN. O resto deste
script foi escrito contra o modelo da API, não contra dado real — ao contrário
do lembrete e da agenda, que conferi contra pacientes de verdade.

Por isso a regra do desconhecido é CONSERVADORA: procedimento que não casa com
nenhum serviço conhecido **não é descartado em silêncio** — entra em `sem_cpf`
com o motivo "procedimento desconhecido", que é a lista que a recepção já
recebe com ref `C1`/`C2`. Sumir calado é o que não se pode fazer com dinheiro.

## O que ficou IGUAL

O contrato de saída (`diretos`, `cirurgias`, `sem_cpf`, `janela`), o dedup
cumulativo por id, e a regra de bloqueio por cadastro incompleto: Teresina exige
CPF/CNPJ **e** CEP do tomador, e sem isso a prefeitura devolve o erro enganoso
`cpfCnpjTomadorInvalido` (L999). Bloquear aqui e pedir para completar é melhor
que tentar e falhar com erro confuso.

⚠️ Sem credencial literal. Antes este arquivo trazia a senha do iClinic como
valor padrão de `os.environ.get` — ver `src/sem-segredo-no-repo.test.ts`.
"""
import argparse
import json
import os
import re
from datetime import date
from pathlib import Path

import cnn

EMITIDAS_FILE = Path(os.environ.get("NFSE_EMITIDAS_FILE", "nfse_emitidas.json"))

# ⛔ NÃO existe mais um município padrão.
#
# Até 26/10/2026 havia `TERESINA_IBGE = "2211001"` e o endereço do tomador
# recebia esse código sempre que o cadastro tivesse `idCidade` preenchido —
# qualquer que fosse a cidade. O comentário prometia o contrário ("quando não
# for, o município sai vazio"), e ninguém conferia.
#
# O caso que mostrou: ANA CAMILA, `idCidade` 5622, é de São João da Fronteira
# (IBGE 2209872). A nota sairia com Teresina. Município errado em documento
# fiscal é pior que nota não emitida, que é só atraso.
#
# Agora o código vem de `cnn.cidade(idCidade)["codIbge"]`. Sem palpite e sem
# padrão: cadastro sem cidade é bloqueado com motivo.

# procedimento da CNN -> serviço do emissor. Por ID, não por nome: nome muda
# com reconfiguração da clínica, id não. Ver /tipo-procedimento/lista.
SERVICO_DO_PROCEDIMENTO = {
    1212102: ("direto", "consulta"),
    1212181: ("direto", "topografia"),
    1212182: ("direto", "mapeamento"),
    1212183: ("direto", "yag"),
    1212184: ("cirurgia", "lente_faco"),   # CIRURGIA CATARATA
    1212185: ("cirurgia", "refrativa"),    # CIRURGIA PRK
    1212186: ("cirurgia", "refrativa"),    # CIRURGIA LASIK
    1212187: ("cirurgia", "pterigio"),     # CIRURGIA PTERÍGIO
}


def only_digits(s):
    return re.sub(r"\D", "", s or "")


def endereco_do_cadastro(cadastro):
    end = cadastro.get("endereco") or {}
    ibge, nome_cidade = "", ""
    if end.get("idCidade"):
        try:
            c = cnn.cidade(end["idCidade"])
            ibge = (c.get("codIbge") or "").strip()
            nome_cidade = (c.get("nome") or "").strip()
        except cnn.CnnIndisponivel:
            # ⚠️ Falha de rede NÃO vira município vazio em silêncio nem palpite:
            # fica vazio, o item cai em `sem_cpf` com "sem município" e a
            # recepção vê. Emitir com o município de outra cidade é irreversível
            # — nota emitida errada se cancela com processo.
            ibge = ""
    return {
        "rua": end.get("rua"),
        "numero": end.get("numero"),
        "bairro": end.get("bairro"),
        "cep": only_digits(end.get("cep")),
        "cidade": nome_cidade,
        "codigo_municipio": ibge,
    }


def resolve_tomador(orc):
    """Pagador quando houver; senão o próprio paciente.

    O ENDEREÇO é SEMPRE o do paciente — nem o iClinic nem a CNN guardam o do
    pagador terceiro, e o município é obrigatório para emitir.
    """
    pac = orc.get("paciente") or {}
    contato = pac.get("contato") or {}
    endereco = endereco_do_cadastro(pac)
    tel = only_digits(
        contato.get("telefoneCelular") or contato.get("telefoneResidencial")
    )

    pagador = orc.get("clientePagadorFinanceiro") or {}
    doc_pagador = only_digits(pagador.get("cpfCnpj") or pagador.get("cpfcnpj"))
    if doc_pagador and doc_pagador != only_digits(pac.get("cpfcnpj")):
        return {
            "origem": "pagador",
            "nome": pagador.get("nome"),
            "doc": doc_pagador,
            "tipo": "PJ" if len(doc_pagador) == 14 else "PF",
            "endereco": endereco,
            "telefone": tel,
        }
    return {
        "origem": "paciente",
        "nome": pac.get("nome"),
        "doc": only_digits(pac.get("cpfcnpj")),
        "tipo": "PF",
        "endereco": endereco,
        "telefone": tel,
    }


def motivo_incompleto(tom):
    """None se dá para emitir, ou o motivo do bloqueio.

    ⛔ A lista cresce quando a prefeitura rejeita um campo novo, e cada item
    aqui vale mais que o erro dela: o retorno do emissor é enganoso de
    propósito curto. "cpfCnpjTomadorInvalido" (L999) era CEP faltando, e
    "cadastro incompleto, faltou xBairro" é o que apareceu em 26/10/2026 —
    três tentativas de emissão da mesma paciente, a recepção preenchendo o
    campo e tentando de novo.

    Bloquear aqui, com o nome do campo que falta, troca três tentativas por uma
    linha na lista de incompletos que diz o que fazer.
    """
    if not tom.get("doc"):
        return "sem CPF/CNPJ"
    end = tom.get("endereco") or {}
    if not only_digits(end.get("cep")):
        return "sem CEP"
    if not end.get("codigo_municipio"):
        return "sem município"
    # ⚠️ `xBairro` é obrigatório no layout de Teresina, e NADA conferia.
    if not (end.get("bairro") or "").strip():
        return "sem bairro"
    if not (end.get("rua") or "").strip():
        return "sem rua"
    return None


def servicos_do_orcamento(orc):
    """[(origem, servico, nome_do_procedimento)] — e o que não casa vem junto."""
    out = []
    for pr in orc.get("procedimentos") or []:
        par = SERVICO_DO_PROCEDIMENTO.get(pr.get("idTipoProcedimento"))
        out.append(
            (par[0] if par else None, par[1] if par else None,
             pr.get("nomeProcedimento") or "")
        )
    return out


def coletar(d0, d1, emitidas):
    diretos, cirurgias, sem_cpf = [], [], []

    for orc in cnn.orcamentos(d0, d1, status="APROVADO", tipo_data="APROVACAO"):
        if str(orc.get("id")) in emitidas:
            continue
        aprovado = (orc.get("dataAprovacao") or "")[:10]
        valor = float(orc.get("valorLiquido") or 0)
        if valor <= 0:
            continue

        pac = orc.get("paciente") or {}
        tom = resolve_tomador(orc)
        mot = motivo_incompleto(tom)

        for origem, servico, nome_proc in servicos_do_orcamento(orc):
            item = {
                "origem": origem or "desconhecido",
                "receita_id": orc["id"],
                "servico": servico,
                "procedimento": nome_proc,
                "valor": f"{valor:.2f}",
                "pay_date": aprovado,
                "paciente": pac.get("nome"),
                "patient_id": pac.get("id"),
                "tomador": tom,
                "motivo": mot,
            }
            if origem is None:
                # ⛔ NÃO descarta, e NÃO inventa uma quinta chave que ninguém lê.
                #
                # A primeira versão punha isto num bucket `nao_categorizado`
                # próprio — que o `nfse_coletar_pipeline.py` não consome. O
                # comentário prometia "aparece no grupo" e o comportamento
                # observável era o descarte silencioso que ele dizia evitar.
                # Entra em `sem_cpf`, que é a lista de incompletos que a
                # recepção JÁ recebe com motivo e ref C1/C2.
                item["motivo"] = f"procedimento desconhecido ({nome_proc})"
                sem_cpf.append(item)
            elif mot:
                sem_cpf.append(item)
            elif origem == "cirurgia":
                cirurgias.append(item)
            else:
                diretos.append(item)

    chave = lambda x: (x["pay_date"], x["paciente"] or "")
    diretos.sort(key=chave)
    cirurgias.sort(key=chave)
    return {
        "diretos": diretos,
        "cirurgias": cirurgias,
        "sem_cpf": sem_cpf,
    }


def main():
    ap = argparse.ArgumentParser(description="Coleta NFs a emitir (CNN)")
    hoje = date.today().isoformat()
    ap.add_argument("--desde", default=hoje)
    ap.add_argument("--ate", default=hoje)
    args = ap.parse_args()

    emitidas = (
        set(map(str, json.loads(EMITIDAS_FILE.read_text())))
        if EMITIDAS_FILE.exists()
        else set()
    )
    out = coletar(args.desde, args.ate, emitidas)
    out["janela"] = [args.desde, args.ate]
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
