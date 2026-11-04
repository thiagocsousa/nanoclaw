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
        # ⛔ `logradouro`, NÃO `rua`. O nome do campo na CNN é `rua`, e eu usei
        # esse nome ao reescrever este arquivo em 25/10/2026 — sem olhar quem
        # consome. O `nfse_emitir_pipeline` lê `end.get("logradouro")` para
        # montar o `xLgr` da DPS, então TODO item da era CNN falhava com
        # "cadastro incompleto, faltou xLgr".
        #
        # Descoberto em 04/11, emitindo três notas à mão: a Kecya, única da
        # lista automática desde 03/11, teria falhado igual. É a mesma falha do
        # `nc.login` — reescrevi o produtor e não conferi o consumidor — e a
        # guarda de chamadas não pega, porque aqui o contrato é chave de dict,
        # não assinatura de função. Ver `src/contrato-nfse.test.ts`.
        "logradouro": end.get("rua"),
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
    if not (end.get("logradouro") or "").strip():
        return "sem logradouro"
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


# ⛔ O QUE FATURA, por tipo de atendimento. Decisão do Thiago em 04/11/2026.
#
# Orçamento cobre só CIRURGIA — foi ele que apontou: "orçamento não vai ser só
# pra cirurgia? os demais vai ser faturar atendimento, não?". Estava certo, e
# a premissa de 24/10 ("tudo vira orçamento aprovado") era minha, não da
# clínica. Medido: um orçamento em três semanas e meia, justamente a cirurgia,
# enquanto 29 atendimentos particulares foram finalizados só em outubro.
#
# Então consulta e exame passam a sair da AGENDA, e o que fatura é esta tabela:
FATURA_COMO_CONSULTA = {
    126577,  # Consulta
    126591,  # Avaliação cirúrgica – catarata
    126592,  # Avaliação cirúrgica – refrativa
    126593,  # Avaliação cirúrgica – pterígio
}
FATURA_PELO_PROCEDIMENTO = {
    126581,  # Exame
}
# ⛔ NÃO faturam, e cada um por um motivo diferente:
#   126583 Retorno / 126594 Retorno pós-op — "o retorno está incluído em até 30
#          dias" é texto aprovado da clínica. Faturar aqui emitiria nota de
#          consulta gratuita. (Thiago, 04/11: "retorno nunca fatura".)
#   126595 Exame externo — feito fora; a clínica só registra. (idem)
#   126596 Solicitação  — é papel.
#   126578 Cirurgia     — vem por orçamento, e faturar dos dois lados duplica.
#   126579 Encaixe      — ambíguo; na dúvida não fatura, que é a regra da casa.

# O procedimento usado quando o atendimento não tem nenhum registrado e o tipo
# fatura como consulta.
PROCEDIMENTO_CONSULTA = 1212102


# ⛔ PISO da fonte AGENDA. Antes disto, quem faturava era o iClinic.
#
# O dedup é por `receita_id`, e os ids não se correspondem: o iClinic usava
# números, a derivação usa `agenda-<evento>-<procedimento>`. Então um serviço de
# agosto, já faturado por lá e registrado em `nfse_emitidas.json` com o id do
# iClinic, seria re-derivado da agenda com id NOVO — e sairia DE NOVO.
#
# Medido em 04/11/2026, antes de a lista rodar: sem este piso, a janela de
# 16/07 traria 29 itens e R$ 12.110,00, dos quais **22 anteriores à virada**.
# Aprovar "todos" emitiria nota duplicada de serviço já faturado.
#
# ⚠️ A assimetria que decide o valor: nota não emitida é atraso, e volta na
# lista do dia seguinte; nota duplicada se cancela com processo e tem efeito
# fiscal. Então o piso erra para o lado de deixar passar.
#
# 24/10 porque a última coleta do iClinic rodou em 23/10 — o que ela listou,
# listou; daí em diante ninguém coletou nada até hoje.
AGENDA_DESDE = os.environ.get("NFSE_AGENDA_DESDE", "2026-10-24")


def itens_da_agenda(d0, d1, emitidas):
    """Faturáveis derivados da AGENDA: consulta e exame particulares.

    ⚠️ Isto é o que foi ATENDIDO, não o que foi RECEBIDO. O iClinic tinha
    `financas/busca` — o dinheiro do dia —; a CNN não tem endpoint financeiro
    (varri os 55 em 04/11/2026). Desconto de balcão, cortesia e pagamento
    parcial não aparecem aqui, e é o preço de não haver a informação.

    ⛔ `/agenda/lista` NÃO filtra por status: o filtro de `FINALIZADO` é nosso,
    em Python, depois de puxar a janela.
    """
    out = []
    # O piso só aperta a janela; nunca a alarga.
    inicio = max(d0, AGENDA_DESDE)
    for ev in cnn.agenda(inicio, d1):
        if not cnn.compareceu(ev):
            continue
        if ev.get("idTipoConvenio") not in cnn.CONVENIOS_PARTICULARES:
            continue        # convênio é faturado ao plano, não ao paciente
        tipo = ev.get("idTipoConsulta")
        if tipo not in FATURA_COMO_CONSULTA and tipo not in FATURA_PELO_PROCEDIMENTO:
            continue
        data = (ev.get("data") or "")[:10]
        conv = ev.get("idTipoConvenio")
        procs = ev.get("procedimentos") or []

        if tipo in FATURA_COMO_CONSULTA and not procs:
            procs = [{"idTipoProcedimento": PROCEDIMENTO_CONSULTA,
                      "nome": "CONSULTA", "quantidade": 1}]

        for pr in procs:
            idp = pr.get("idTipoProcedimento")
            # `agenda-<evento>-<procedimento>`: estável entre execuções (não
            # reemite) e distinto dos ids de orçamento, que são números.
            rid = "agenda-%s-%s" % (ev.get("id"), idp)
            if rid in emitidas:
                continue
            valor = cnn.valor_de_venda(idp, conv, data) if idp else None
            par = SERVICO_DO_PROCEDIMENTO.get(idp)
            item = {
                "origem": "direto",
                "receita_id": rid,
                "servico": par[1] if par else None,
                "procedimento": pr.get("nome") or "",
                "valor": "%.2f" % float(valor) if valor else "0.00",
                "pay_date": data,
                "paciente": None,
                "patient_id": ev.get("idPaciente"),
                "tomador": None,
                "motivo": None,
            }
            if not idp or valor in (None, 0):
                item["motivo"] = ("exame sem procedimento registrado"
                                  if not idp else
                                  "sem preço na CNN para %s" % (pr.get("nome") or idp))
            out.append(item)
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

    # ⛔ A segunda fonte: a AGENDA. O orçamento cobre cirurgia; consulta e exame
    # saem daqui. Ver `itens_da_agenda`.
    #
    # O cadastro do paciente é buscado SÓ AGORA, uma vez por paciente: a agenda
    # devolve `idPaciente`, não o endereço, e puxar cadastro dentro do laço de
    # eventos faria uma requisição por atendimento em vez de uma por pessoa.
    cadastros = {}
    for item in itens_da_agenda(d0, d1, emitidas):
        pid = item["patient_id"]
        if pid not in cadastros:
            try:
                cadastros[pid] = cnn.paciente(pid)
            except cnn.CnnIndisponivel:
                cadastros[pid] = None
        pac = cadastros[pid]
        if not pac:
            item["paciente"] = "(cadastro não lido)"
            item["motivo"] = item["motivo"] or "não consegui ler o cadastro na CNN"
            sem_cpf.append(item)
            continue
        item["paciente"] = pac.get("nome")
        item["tomador"] = resolve_tomador({"paciente": pac})
        mot = item["motivo"] or motivo_incompleto(item["tomador"])
        item["motivo"] = mot
        (sem_cpf if mot else diretos).append(item)

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
