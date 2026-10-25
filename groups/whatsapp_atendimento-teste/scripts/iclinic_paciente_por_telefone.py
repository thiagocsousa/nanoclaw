#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Acha o cadastro do paciente pelo TELEFONE — na Clínica nas Nuvens.

⛔ Migrado do iClinic em 25/10/2026.

## A lacuna que a CNN tem e o iClinic não tinha

`GET /paciente/lista` filtra por `cpfCnpj`, `nomeContem`, `numeroIdentificacao`
e data — **não por telefone**. E é por telefone que a Lara reconhece quem
escreve no WhatsApp: é o único dado que ela tem antes de a pessoa dizer o nome.

A saída é varrer a base e indexar localmente. Medido em 25/10/2026:
**1328 pacientes, 14 páginas de 100, 9,7 segundos.** Cabe folgado no teto de
180 s do agent-runner e no limite de 120 requisições/minuto da API.

⚠️ Varredura inteira a cada consulta é aceitável AGORA, com 1328 cadastros.
Se a base crescer muito, isto vira um índice persistido — mas índice tem
invalidação, e invalidação errada faz a Lara não reconhecer paciente que
existe. Enquanto couber no tempo, varrer é mais simples e não erra.

## O casamento é pelos ÚLTIMOS 8 DÍGITOS

O 9º dígito do celular brasileiro aparece e some entre cadastros e o JID do
WhatsApp. Comparar o número inteiro faria a Lara não achar quem está lá. Os 8
finais são estáveis — é a mesma `match_key` que os pipelines de lembrete usam.

Saída: {"ok": true, "candidatos": [...], "total": N}. Quem confirma a
identidade é a PESSOA, com nome e nascimento; isto aqui só levanta candidatos.
"""
import argparse
import json
import re
import sys

import cnn


def so_digitos(s):
    return re.sub(r"\D", "", s or "")


def chave(telefone):
    """Os 8 últimos dígitos. Vazio quando não há número utilizável."""
    d = so_digitos(telefone)
    return d[-8:] if len(d) >= 8 else ""


def responde(ok, **extra):
    print(json.dumps({"wakeAgent": False, "ok": ok, **extra}, ensure_ascii=False))


def telefones_do_cadastro(p):
    c = p.get("contato") or {}
    return [
        c.get("telefoneCelular"),
        c.get("telefoneResidencial"),
        c.get("telefoneComercial"),
        c.get("telefoneRecados"),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--telefone", required=True)
    a = ap.parse_args()

    alvo = chave(a.telefone)
    if not alvo:
        responde(False, erro="telefone_invalido", telefone=a.telefone)
        return 2

    try:
        # `somenteAtivos=false`: paciente inativo ainda é paciente conhecido, e
        # não reconhecer quem já é da casa é pior que listar um a mais — quem
        # confirma é a pessoa.
        todos = cnn._paginado("/paciente/lista", somenteAtivos="false")
    except cnn.CnnIndisponivel as exc:
        # ⛔ Não devolve "nenhum candidato" quando a BUSCA falhou. Os dois são
        # indistinguíveis para quem chama, e tratar falha como "paciente novo"
        # faria a Lara criar cadastro duplicado de quem já existe.
        responde(False, erro="cnn_indisponivel", detalhe=str(exc))
        return 1

    candidatos = []
    for p in todos:
        if not any(chave(t) == alvo for t in telefones_do_cadastro(p)):
            continue
        c = p.get("contato") or {}
        candidatos.append({
            "id": p.get("id"),
            "nome": (p.get("nome") or "").strip(),
            "nascimento": (p.get("dataNascimento") or "")[:10],
            "telefone": c.get("telefoneCelular") or "",
            "cidade": "",   # a CNN dá idCidade, não o nome; não vale a chamada
            "ativo": bool(p.get("ativo")),
        })

    # Mais velho primeiro: quem escreve para a clínica tende a ser o adulto
    # titular do telefone, e menor de idade escala de qualquer jeito. É palpite
    # de ORDEM, não de identidade — quem confirma é a pessoa.
    candidatos.sort(key=lambda c: c["nascimento"] or "9999-99-99")
    responde(True, candidatos=candidatos, total=len(candidatos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
