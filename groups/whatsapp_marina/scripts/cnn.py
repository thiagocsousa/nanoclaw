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

# Convênios da clínica, lidos de /tipo-convenio/lista em 24/10/2026.
NOME_DO_CONVENIO = {
    74546: "IASPI",
    74545: "IPMT",
    74466: "Particular",
    74543: "Particular com desconto",
    74544: "Unimed",
}

# Os que são "particular" para efeito de regra de negócio (desconto, retorno
# anual). Por ID, não por texto: `"particular" in nome.lower()` casaria com
# qualquer convênio novo que tivesse a palavra.
CONVENIOS_PARTICULARES = {74466, 74543}

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


# `dataPor` do /agenda/lista. Lido do Swagger em 25/10/2026.
TIPOS_DE_DATA_DA_AGENDA = ("AGENDAMENTO", "CRIACAO")


def agenda(data_inicial, data_final, data_por="AGENDAMENTO", **extra):
    """Agendamentos do período, em ISO (yyyy-MM-dd).

    ⛔ `dataPor` vai EXPLÍCITO, e não é zelo: o Swagger declara o enum
    (`AGENDAMENTO`, `CRIACAO`) e **não declara o default**. Se o default fosse
    `CRIACAO`, toda janela daqui passaria a significar "agendamentos CADASTRADOS
    nestes dias" em vez de "consultas NESTES dias" — e cinco pipelines leriam
    dado errado sem um erro: retorno anual, agenda de hoje, agenda de amanhã,
    lembrete da véspera e a última consulta do paciente.

    MEDIDO em 25/10/2026, contra a API de produção, numa janela FUTURA
    (26/10 a 07/11 — nada pode ter sido *criado* no futuro):

        dataPor=AGENDAMENTO    31 eventos
        dataPor=CRIACAO         0 eventos
        sem dataPor            31 eventos   <- o default É AGENDAMENTO

    Então os pipelines liam certo, e cravar é blindagem, não conserto. O que a
    medição mostrou é o TAMANHO do estrago que o default errado faria: na
    janela de 24-25/10, que são os dias da importação da base, `CRIACAO`
    devolve **1470 eventos com consultas de 2023-02-15 a 2027-03-03** — a base
    inteira de uma vez. O lembrete da véspera mandaria mensagem para quatro
    anos de pacientes.

    Basta a CNN mudar o default para a leitura virar aquilo, calada.

    `codigoPaciente` (integer) é o filtro por paciente — é assim que se acha a
    última consulta, porque a API **não tem** endpoint de histórico.
    """
    if data_por not in TIPOS_DE_DATA_DA_AGENDA:
        raise CnnIndisponivel(
            f"dataPor {data_por!r} não existe; use um de {TIPOS_DE_DATA_DA_AGENDA}"
        )
    return _paginado(
        "/agenda/lista",
        dataInicial=data_inicial,
        dataFinal=data_final,
        dataPor=data_por,
        **extra,
    )


def disponibilidade(id_executor, data_inicial, data_final):
    """Os horários LIVRES do período, agrupados por data.

    ⛔ Devolve a GRADE, não a janela. Medido em 25/10/2026: com `dataFim`
    maior que `data`, cada slot vem com o campo `data` — então o período
    inteiro cabe numa requisição, e não numa por dia.

    A grade já traz subtraídos: a configuração da agenda da médica, o almoço,
    o bloqueio pontual e as consultas marcadas. É a resposta da CNN para "o que
    pode ser oferecido", e reduzi-la a (primeiro, último) joga fora justamente
    o buraco do meio.
    """
    slots = pega(
        "/executor-agenda/disponibilidade",
        idExecutorAgenda=id_executor,
        data=data_inicial, dataFim=data_final,
    )
    por_data = {}
    for s in slots:
        por_data.setdefault(s.get("data"), []).append(
            (s["horaInicio"][:5], s["horaFim"][:5])
        )
    for v in por_data.values():
        v.sort()
    return por_data


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


# Cache de cidade por processo. Uma clínica atende dezenas de pacientes das
# mesmas poucas cidades, e `/cidade/{id}` é imutável na prática.
_CIDADES = {}


def cidade(id_cidade):
    """{id, nome, codIbge, estado} da cidade. Memoizado no processo.

    ⛔ Existe porque o `idCidade` do cadastro NÃO é o código IBGE, e a nota
    fiscal precisa do IBGE. Até 26/10/2026 o `nfse_coletar` cravava Teresina
    (2211001) para qualquer paciente que tivesse `idCidade` preenchido — o
    comentário lá dizia que o município sairia vazio para quem fosse de fora, e
    o código fazia o contrário.

    Custou um caso real: ANA CAMILA, `idCidade` 5622, é de **São João da
    Fronteira** (IBGE 2209872). A nota dela sairia com o município errado, que
    num documento fiscal é pior que não sair.

    E a suposição nunca foi necessária: `codIbge` vem neste endpoint.
    """
    if id_cidade in _CIDADES:
        return _CIDADES[id_cidade]
    c = pega(f"/cidade/{id_cidade}")
    _CIDADES[id_cidade] = c
    return c


# Valores aceitos pela API (medidos em 25/10/2026 — `EMISSAO` devolve HTTP 400).
TIPOS_DE_DATA = ("CRIACAO", "APROVACAO", "PREVISAO_EXECUCAO")
STATUS_DE_ORCAMENTO = ("ABERTO", "APROVADO", "PERDIDO", "CANCELADO")


def orcamentos(data_inicial, data_final, status="APROVADO",
               tipo_data="APROVACAO"):
    """Orçamentos do período.

    ⚠️ É a fonte do financeiro para a NF-e desde 24/10/2026: a CNN não tem
    endpoint de "cobrança do dia", e a clínica passou a lançar a cobrança como
    ORÇAMENTO APROVADO (decisão do Thiago). Sem isso o `nfse_coletar` não tem
    de onde ler.

    ⚠️ `tipo_data` é APROVACAO, não "emissão": a janela da nota é quando o
    orçamento foi APROVADO, que é o instante em que o dinheiro foi combinado.
    `EMISSAO` nem existe na API — devolve HTTP 400.
    """
    if tipo_data not in TIPOS_DE_DATA:
        raise CnnIndisponivel(
            f"tipoData {tipo_data!r} não existe; use um de {TIPOS_DE_DATA}"
        )
    if status not in STATUS_DE_ORCAMENTO:
        raise CnnIndisponivel(
            f"status {status!r} não existe; use um de {STATUS_DE_ORCAMENTO}"
        )
    return _paginado(
        "/orcamento/lista",
        dataInicial=data_inicial,
        dataFinal=data_final,
        status=status,
        tipoData=tipo_data,
    )


def posta(caminho, corpo):
    """POST autenticado com corpo JSON."""
    usuario, senha, cid = _credenciais()
    dados = json.dumps(corpo).encode()
    req = urllib.request.Request(f"{BASE}{caminho}", data=dados, method="POST")
    cred = base64.b64encode(f"{usuario}:{senha}".encode()).decode()
    req.add_header("Authorization", f"Basic {cred}")
    req.add_header("clinicaNasNuvens-cid", cid)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            corpo_resp = r.read().decode()
            return json.loads(corpo_resp) if corpo_resp.strip() else {}
    except urllib.error.HTTPError as exc:
        detalhe = exc.read()[:300].decode("utf-8", "replace")
        raise CnnIndisponivel(f"HTTP {exc.code} em {caminho}: {detalhe}") from exc
    except Exception as exc:
        raise CnnIndisponivel(f"falha em {caminho}: {exc}") from exc


def convenio_do_paciente(id_paciente, id_tipo_convenio):
    """O `idPacienteConvenio` — associando antes, se ainda não existir.

    ⚠️ `idPacienteConvenio` NÃO é `idTipoConvenio`: é a associação
    paciente↔convênio, e o `/agenda/novo` exige a associação, não o tipo. Foi a
    pegadinha que mais custou a entender no mapeamento.
    """
    for c in _paginado("/convenio-paciente/lista", idPaciente=id_paciente):
        if c.get("idTipoConvenio") == id_tipo_convenio and c.get("ativo"):
            return c.get("id")
    novo = posta("/convenio-paciente/associar", {
        "idPaciente": id_paciente,
        "idTipoConvenio": id_tipo_convenio,
    })
    return novo.get("id")
