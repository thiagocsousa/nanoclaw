#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cliente da Clínica nas Nuvens.

Substitui o par Playwright+endpoint-interno do iClinic. Aqui é HTTP puro: Basic
auth + header `clinicaNasNuvens-cid`. **Sem navegador** — e isso é o que tira o
Chromium, o `--disable-dev-shm-usage`, o `wait_for_selector` de 45 s e os ~20 s
de login de cada pipeline.

Ver `docs/CNN-MAPEAMENTO.md` para o levantamento medido contra a API.

⚠️ ESTE ARQUIVO É COPIADO entre pastas de grupo. Só `/workspace/group` é
montado no container, então um script de `whatsapp_marina` não importa de
`whatsapp_atendimento-dra-marina`. As cópias têm de ser idênticas, e o teste
`cnn-client-copias.test.ts` falha quando divergem. Mexeu numa, rode a suíte.

⚠️ Limite da API: 120 requisições por minuto, por token.
"""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.clinicanasnuvens.com.br"

# Tipos de consulta que contam como CONSULTA para efeito de lembrete, lidos de
# /tipo-consulta/lista em 24/10/2026. É uma allowlist de propósito: a regra
# antiga ("só consulta e retorno, na dúvida não manda") é conservadora, e
# traduzi-la assim preserva a conservadoria.
#
# ⚠️ FORA da lista, e cada um por um motivo:
#   126578 CIRURGIA        — não é consulta; a terça é disso (Thiago, 25/10)
#   126581 EXAME / 126595 EXAME EXTERNO / 126596 SOLICITAÇÃO
#   126579 Encaixe         — ambíguo. "Na dúvida, não manda" é a regra de casa.
TIPOS_DE_CONSULTA = {
    126577,  # CONSULTA
    126583,  # RETORNO
    126594,  # RETORNO PÓS-OPERATÓRIO
    126591,  # AVALIAÇÃO CIRÚRGICA – CATARATA
    126592,  # AVALIAÇÃO CIRÚRGICA – REFRATIVA
    126593,  # AVALIAÇÃO CIRÚRGICA – PTERÍGIO
}

# Nome legível de cada tipo, para o relatório e o manifesto. Não decide nada.
NOME_DO_TIPO = {
    126577: "Consulta",
    126583: "Retorno",
    126594: "Retorno pós-operatório",
    126591: "Avaliação cirúrgica – catarata",
    126592: "Avaliação cirúrgica – refrativa",
    126593: "Avaliação cirúrgica – pterígio",
    126578: "Cirurgia",
    126581: "Exame",
    126595: "Exame externo",
    126596: "Solicitação",
    126579: "Encaixe",
}

# Status que significam "este horário não vale" — o equivalente do
# STATUS_EXCLUIR = {ca, fl, na, bl, hd} do iClinic.
#
# ⚠️ O iClinic tinha `bl`/`hd` (bloqueio, feriado) como STATUS; na CNN isso não
# é status, é ausência de disponibilidade. Por isso a lista aqui é menor sem ser
# mais permissiva.
STATUS_SEM_VALOR = {
    "CANCELADO",
    "CANCELADO_PACIENTE",
    "FALTOU",
    "REMARCOU",
}

# Compareceu — base do retorno anual e do pedido de avaliação.
STATUS_COMPARECEU = "FINALIZADO"


class CnnIndisponivel(RuntimeError):
    """A API não respondeu. Melhor não agir do que agir com meia agenda."""


def _credenciais():
    cid = os.environ.get("CNN_CID")
    usuario = os.environ.get("CNN_CLIENT_ID")
    senha = os.environ.get("CNN_CLIENT_SECRET")
    if not (cid and usuario and senha):
        raise CnnIndisponivel(
            "faltam CNN_CLIENT_ID, CNN_CLIENT_SECRET ou CNN_CID no ambiente "
            "(FORWARDED_ENV_VARS em container-runner.ts)"
        )
    return usuario, senha, cid


def pega(caminho, **params):
    """GET autenticado. Levanta CnnIndisponivel em qualquer falha.

    ⚠️ NUNCA devolve vazio por erro de rede. Agenda não lida ≠ agenda vazia —
    é a mesma lição do `AgendaIndisponivel` do iclinic_vagas.py, e aqui ela
    vale dobrado: um pipeline silencioso que lê vazio simplesmente não manda
    lembrete nenhum, e ninguém percebe até o paciente faltar.
    """
    usuario, senha, cid = _credenciais()
    url = f"{BASE}{caminho}"
    if params:
        url += "?" + urllib.parse.urlencode(
            {k: v for k, v in params.items() if v is not None}
        )
    req = urllib.request.Request(url)
    cred = base64.b64encode(f"{usuario}:{senha}".encode()).decode()
    req.add_header("Authorization", f"Basic {cred}")
    req.add_header("clinicaNasNuvens-cid", cid)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        corpo = exc.read()[:200].decode("utf-8", "replace")
        raise CnnIndisponivel(f"HTTP {exc.code} em {caminho}: {corpo}") from exc
    except Exception as exc:
        raise CnnIndisponivel(f"falha em {caminho}: {exc}") from exc


def _paginado(caminho, **params):
    """Percorre todas as páginas. A CNN começa em 0 e devolve `totalPaginas`."""
    pagina, tudo = 0, []
    while True:
        d = pega(caminho, pagina=pagina, registrosPorPagina=100, **params)
        tudo.extend(d.get("lista") or [])
        total = d.get("totalPaginas") or 1
        pagina += 1
        if pagina >= total:
            return tudo


def agenda(data_inicial, data_final, **extra):
    """Agendamentos do período, em ISO (yyyy-MM-dd)."""
    return _paginado(
        "/agenda/lista", dataInicial=data_inicial, dataFinal=data_final, **extra
    )


def eh_consulta(ev):
    """Este evento é consulta/retorno que merece lembrete?"""
    return (
        ev.get("idTipoConsulta") in TIPOS_DE_CONSULTA
        and ev.get("status") not in STATUS_SEM_VALOR
        and bool(ev.get("idPaciente"))
    )


def compareceu(ev):
    return ev.get("status") == STATUS_COMPARECEU


def paciente(id_paciente):
    """Cadastro completo: cpfcnpj, endereco (com CEP) e contato."""
    return pega(f"/paciente/{id_paciente}")


def orcamentos(data_inicial, data_final, status="APROVADO", tipo_data="EMISSAO"):
    """Orçamentos do período.

    ⚠️ É a fonte do financeiro para a NF-e desde 24/10/2026: a CNN não tem
    endpoint de "cobrança do dia", e a clínica passou a lançar a cobrança como
    ORÇAMENTO APROVADO (decisão do Thiago). Sem isso o `nfse_coletar` não tem
    de onde ler.
    """
    return _paginado(
        "/orcamento/lista",
        dataInicial=data_inicial,
        dataFinal=data_final,
        status=status,
        tipoData=tipo_data,
    )
