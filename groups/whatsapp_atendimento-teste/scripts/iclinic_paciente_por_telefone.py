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
from datetime import date, timedelta

import cnn

# Janela do "última consulta". Um ano cobre o retorno anual e cabe numa
# requisição, porque /agenda/lista aceita período.
HOJE = date.today().isoformat()
DESDE_HISTORICO = (date.today() - timedelta(days=366)).isoformat()


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
            # Preenchidos abaixo, só para quem sobrou do filtro.
            "convenio": "",
            "ultima_consulta": "",
        })

    # ⛔ `convenio` e `ultima_consulta` TÊM consumidor, e eu os tinha deixado
    # vazios na migração.
    #
    # `executor.ts` dispara o template `confirma_convenio` a partir de
    # `cad.convenio` e preenche o convênio do candidato; `ultima_consulta` vai
    # no escalonamento "para poupar a recepção de abrir o sistema"
    # (`src/paciente.ts`). Entregar vazio não dá erro — faz a triagem
    # PERGUNTAR de novo o que estava no cadastro, e transfere o custo para
    # turnos de conversa e para a recepção.
    #
    # ⚠️ Só para os candidatos que sobraram (quase sempre 1), depois do filtro.
    # São 1-2 requisições que se pagam num turno a menos, contra as 14 da
    # varredura que já foram gastas.
    for c in candidatos:
        try:
            vincs = cnn._paginado("/convenio-paciente/lista", idPaciente=c["id"])
            ativo = next((v for v in vincs if v.get("ativo")), None)
            if ativo:
                c["convenio"] = (ativo.get("nomeTipoConvenio") or "").strip()
            hist = [e for e in cnn.agenda(DESDE_HISTORICO, HOJE,
                                          codigoPaciente=c["id"])
                    if cnn.compareceu(e)]
            if hist:
                c["ultima_consulta"] = max(e.get("data") or "" for e in hist)
        except cnn.CnnIndisponivel:
            # ⚠️ Enriquecimento é OPCIONAL: falhar aqui não pode derrubar o
            # reconhecimento do paciente, que é o trabalho principal e já está
            # feito. Segue com os campos vazios.
            pass

    # Mais velho primeiro: quem escreve para a clínica tende a ser o adulto
    # titular do telefone, e menor de idade escala de qualquer jeito. É palpite
    # de ORDEM, não de identidade — quem confirma é a pessoa.
    candidatos.sort(key=lambda c: c["nascimento"] or "9999-99-99")
    responde(True, candidatos=candidatos, total=len(candidatos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
