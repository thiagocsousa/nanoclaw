#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Runner da suíte de conversa da Lara (tests/conversas-lara.json).

## Como ele "manda mensagem como o paciente"

Injetando a linha direto na tabela `messages`, com o JID do Thiago e
`is_bot_message=0`. O loop do host lê mensagem nova do banco
(`getNewMessages`, src/index.ts), então a Lara recebe exatamente como se ele
tivesse digitado.

Isso é melhor que mandar pelo WhatsApp por três motivos: não desliga a marca
invisível que protege do loop, nada sai pela rede, e o teste fica repetível. O
trânsito pelo WhatsApp já foi verificado em separado (byte E281A3 no banco).

As **respostas** dela saem de verdade no grupo, que é o que se quer ver.

## Isolamento entre cenários

O grupo é uma conversa só, e a sessão do agente carrega o histórico: sem
isolamento, o cenário 2 herdaria a triagem do cenário 1. A primeira mensagem de
cada cenário vai prefixada com a linha de controle `--- NOVO PACIENTE ---`, que a
persona reconhece como "tudo acima é de outro paciente, comece do zero".

## O que ele afere, e o que ele não afere

`proibido` e `esperado` são regex, então ele pega o que é mecânico: travessão,
preço de cirurgia, telemetria vazada, frase proibida. **Tom não dá para medir com
regex** — por isso o relatório sai com a conversa inteira transcrita e o campo
`nota` de cada cenário, para leitura humana. Regex reprovando é falha; regex
aprovando não é selo de qualidade.

Uso:
  python3 scripts/testar-lara.py                   # suíte inteira
  python3 scripts/testar-lara.py --only A01,B02     # cenários escolhidos
  python3 scripts/testar-lara.py --categoria clinico
  python3 scripts/testar-lara.py --listar
"""
import argparse
import json
import random
import re
import sqlite3
import string
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DB = RAIZ / "store" / "messages.db"
SUITE = RAIZ / "tests" / "conversas-lara.json"
GRUPO_DIR = RAIZ / "groups" / "whatsapp_atendimento-teste"

CHAT = "120363275085162068@g.us"
# TELEFONE, não LID. Em produção o canal resolve o LID antes de gravar
# (`senderJid` em whatsapp.ts, conserto de 05/10/2026); o harness escreve direto
# no banco e PULA o canal. Com o LID cru aqui, `telefoneDoJid` recusa — certo —,
# a marcação vai sem telefone e a conferência de identidade reprova. O E08
# falhou por isso em 16/10, parecendo defeito de produto.
SENDER = "558681512111@s.whatsapp.net"
SENDER_NAME = "Thiago Carvalho"
# DM do Thiago: é onde a guarda de saída e a cobrança de escalonamento avisam.
DM_THIAGO = "558681512111@s.whatsapp.net"

CONTROLE = "--- NOVO PACIENTE ---"
# Estado que o HOST mantém por conversa, em arquivo, dentro da pasta do grupo.
#
# ⚠️ Todos os cenários usam o mesmo CHAT, porque é o grupo de teste de verdade.
# Então, para o host, a suíte inteira é UMA conversa: a memória vale 4 h e a
# oferta pendente 30 min, e o `--- NOVO PACIENTE ---` é só texto — o host não o
# trata, nunca tratou.
#
# O resultado, medido pelo review do Codex em 17/10/2026: o cenário seguinte
# herdava necessidade, convênio, identidade e as travas de "já perguntei" e "já
# convidei" do anterior, e um "pode ser esse horário" podia consumir uma oferta
# de outro cenário. Os resultados mudavam com a ORDEM da suíte, o que torna uma
# passada verde pouco conclusiva.
#
# Apagar os arquivos entre cenários é o isolamento que o CHAT compartilhado não
# dá. É o mesmo que o `beforeEach` do executor.test.ts já fazia com a memória.
ESTADO_DO_HOST = ("slots_conversa.json", "ofertas_pendentes.json")
# Auditoria de escalonamento do host. Usada para a checagem `escalou` do
# cenário: o TEXTO de um escalonamento é "Só um instante.", igual ao de um
# DESCONHECIDO, então pelo texto não há como saber se o caso chegou à recepção.
LOG_ESCALADAS = GRUPO_DIR / "escalonamentos.jsonl"
# Fila da revisão humana. Quando ela está ligada, a resposta NÃO vai ao
# paciente: fica aqui esperando um "ok CODIGO" vindo do grupo de atendimento.
#
# A suíte injeta no chat do paciente e espera a resposta chegar nele, então com
# revisão ligada todo cenário daria timeout. Aprovar automaticamente é o que
# mantém a suíte medindo o COMPORTAMENTO (qual texto saiu, se escalou) em vez de
# medir a presença de um humano.
#
# ⚠️ Isto NÃO testa a revisão em si: testa que o resto continua funcionando com
# ela ligada. A revisão tem teste próprio em src/revisao-humana.test.ts.
FILA_REVISAO = GRUPO_DIR / "respostas_pendentes.json"
# De onde a aprovação é aceita. Lido do .env, igual ao host: fixar aqui faria a
# suíte aprovar num JID e o host esperar noutro, e o sintoma seria 99 timeouts
# sem nenhuma pista.
def _env(chave):
    try:
        for linha in (RAIZ / ".env").read_text(encoding="utf-8").splitlines():
            if linha.startswith(chave + "="):
                return linha.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


REVISAO_JID = _env("REVISAO_JID") or _env("ESCALONAMENTO_JID")
REVISAO_SENDER = REVISAO_JID
# Teto por turno: container frio mais agente mais cadência (até 60 s).
TIMEOUT_TURNO = 240
# Depois da 1ª mensagem dela, espera este tanto de silêncio para capturar as
# seguintes: a persona manda duas mensagens curtas de propósito.
QUIETUDE = 10
PASSO = 2
# Pausa entre cenários. As respostas dela saem de verdade no WhatsApp, e uma
# rajada de 150 mensagens no mesmo grupo em uma hora é o tipo de padrão que faz
# o WhatsApp derrubar a sessão do Baileys. Devagar é requisito, não cortesia.
PAUSA_PADRAO = 25


def agora_iso(delta_ms=0):
    t = datetime.now(timezone.utc)
    s = t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000 + delta_ms)
    return s


def conn():
    c = sqlite3.connect(str(DB), timeout=30)
    c.row_factory = sqlite3.Row
    return c


def injeta(texto, chat=None, sender=None):
    """Grava uma mensagem e devolve o timestamp usado.

    Sem `chat`, fala como o paciente no grupo de teste. Com `chat`, fala como
    outra pessoa noutro lugar — é assim que a aprovação da revisão é imitada,
    falando como o grupo de atendimento.
    """
    ts = agora_iso()
    mid = "TESTE" + "".join(random.choices(string.ascii_uppercase + string.digits, k=15))
    with conn() as c:
        c.execute(
            "INSERT INTO messages (id, chat_jid, sender, sender_name, content,"
            " timestamp, is_from_me, is_bot_message) VALUES (?,?,?,?,?,?,1,0)",
            (mid, chat or CHAT, sender or SENDER, SENDER_NAME, texto, ts),
        )
    return ts


TIMEOUT_SILENCIO = 45


def espera_resposta(desde, limite_s=None):
    """Coleta as mensagens da Lara posteriores a `desde`. Lista vazia = silêncio.

    `limite_s` existe para o turno de `silencio: true`, onde a ausência é o
    comportamento certo: confirmar que não veio nada não precisa do pior caso,
    só de tempo suficiente para uma resposta plausível chegar. Com o timeout
    cheio, cada turno silencioso queimava 240s em 120 consultas vazias — os 5
    turnos de silêncio custavam ~20min numa passada que o estimador orçava em 3.
    """
    limite = time.time() + (TIMEOUT_TURNO if limite_s is None else limite_s)
    achou_em = None
    while time.time() < limite:
        with conn() as c:
            rows = c.execute(
                "SELECT content, timestamp FROM messages WHERE chat_jid=? AND"
                " is_bot_message=1 AND timestamp>? ORDER BY timestamp",
                (CHAT, desde),
            ).fetchall()
        if rows:
            if achou_em is None:
                achou_em = time.time()
            elif time.time() - achou_em >= QUIETUDE:
                return [r["content"] for r in rows]
        time.sleep(PASSO)
    with conn() as c:
        rows = c.execute(
            "SELECT content FROM messages WHERE chat_jid=? AND is_bot_message=1"
            " AND timestamp>? ORDER BY timestamp",
            (CHAT, desde),
        ).fetchall()
    return [r["content"] for r in rows]


def avisos_da_guarda(desde):
    """A guarda e a cobrança avisam na DM do Thiago. Pega o que apareceu."""
    with conn() as c:
        rows = c.execute(
            "SELECT content FROM messages WHERE chat_jid=? AND timestamp>?"
            " ORDER BY timestamp",
            (DM_THIAGO, desde),
        ).fetchall()
    return [
        r["content"]
        for r in rows
        if "BLOQUEADA" in r["content"] or "ressalva" in r["content"]
    ]


# --- checagens nomeadas: onde regex não dá conta -----------------------------
#
# "preço de cirurgia" não é expressável em regex. O caso que me derrubou três
# vezes em 04/10/2026:
#
#   "A consulta de avaliação para cirurgia refrativa é R$ 430,00"   <- certo
#   "O valor da cirurgia é definido depois da avaliação,
#    que custa R$ 430,00"                                           <- certo
#   "A cirurgia refrativa custa R$ 8.000,00"                        <- proibido
#
# A diferença não está na vizinhança das palavras, e sim em DE QUE o valor é o
# preço. Então aqui vai a mesma lógica de janela do src/output-guard.ts: para
# cada valor, olhar o trecho entre o valor anterior e ele, e reprovar só quando
# esse trecho fala de cirurgia e não nomeia nada precificável.

RX_DINHEIRO = re.compile(r"R\$\s?\d[\d.,]*|\b\d{1,2}\s?mil\b|\b\d{3,4}\s?reais\b", re.I)
RX_CIRURGIA = re.compile(
    r"cirurgi|facectomia|refrativ|catarata|pter[íi]gio|lasik|prk|yag|intraocular", re.I)
RX_PRECIFICAVEL = re.compile(
    r"avalia[çc][ãa]o|consulta|retorno|exame|mapeamento|topografi|ceratoscopi", re.I)


def acha_preco_de_cirurgia(texto):
    """Devolve o trecho ofensivo, ou None. Espelha achaPrecoDeCirurgia do host."""
    inicio = 0
    for m in RX_DINHEIRO.finditer(texto):
        janela = texto[inicio:m.start()]
        inicio = m.end()
        if not RX_CIRURGIA.search(janela):
            continue
        if RX_PRECIFICAVEL.search(janela):
            continue
        return (janela + m.group(0)).strip()[-90:]
    return None


RX_FORM_CONVENIO = re.compile(r"conv[êe]nio\s*\(ou particular\)\s*:", re.I)
RX_CITA_PLANO = re.compile(
    r"\b(?:IASPI|IAPEP|IPMT|Unimed|Hapvida|Humana|Intermed|Bradesco|Amil|SulAm[ée]rica)\b", re.I)


def pede_dado_repetido(texto):
    """Pedir o convênio de volta a quem acabou de dizer o plano.

    Espelha a regra do host. A versão crua (só procurar o bloco dos quatro
    campos) reprovava o formulário legítimo de quem não disse nada, que é o
    erro que eu venho cometendo o dia todo: critério mais estreito que o
    comportamento correto.
    """
    if RX_FORM_CONVENIO.search(texto) and RX_CITA_PLANO.search(texto):
        return RX_CITA_PLANO.search(texto).group(0)
    return None


# Saudação sem pedido: "oi", "bom dia", um emoji, "informação". É o único caso em
# que a abertura (F00) é a resposta certa.
# Uma palavra de saudação. A mensagem é saudação pura quando sobra nada depois
# de tirar todas elas.
#
# A primeira versão casava a mensagem INTEIRA contra uma alternação, e aí
# aceitava uma saudação só: "oi, boa tarde" do M05 não casava, e a suíte acusava
# falha dura na abertura correta. Tirar token por token em vez de casar a frase
# inteira resolve sem quantificador aninhado, que é o que faz regex engasgar.
RX_TOKEN_SAUDACAO = re.compile(
    r"\b(oi+|ol[áa]|al[ôo]|e?a[íi]|bom|boa|dia|tarde|noite|tudo|bem|"
    r"informa[çc][õo]?[ãe]?s?)\b",
    re.I,
)


def so_saudacao(msg):
    """A mensagem é saudação e mais nada?

    Tira as palavras de saudação e a pontuação. Se sobrar alguma letra ou
    número, a pessoa pediu algo. Emoji e "???" sobrevivem como vazio, de
    propósito: não dizem o que ela quer.
    """
    resto = RX_TOKEN_SAUDACAO.sub(" ", msg or "")
    return not any(c.isalnum() for c in resto)


RX_ABREVIACAO = re.compile(r"\b(Dra?|Sra?|Av|Exm[ao])\.", re.I)


def sem_abreviacoes(texto):
    """O texto com o ponto da abreviação virado espaço.

    Espelha `semAbreviacoes` em `src/output-guard.ts`, e pela mesma razão: várias
    regras daqui delimitam a frase com `[^.!?]`, e "Dra." tem ponto — a janela
    morria no meio do nome e a regra ficava cega dali para frente. "Dra." está em
    25 dos 71 textos aprovados.

    ⚠️ O ponto vira ESPAÇO, não desaparece: o comprimento é preservado, então o
    recorte que vai ao relatório (`m.group(0)`) continua alinhado com a mensagem.

    E a normalização é aqui, não nas janelas dos regexes: minha primeira tentativa
    trocou `[^.!?]` por `[^!?\n]` nas cinco regras, o que passou a excluir a
    QUEBRA DE LINHA — e `recita_grade` e `lista_hospitais` casam listas com
    bullets, em várias linhas. As duas pararam de morder, e só o controle
    negativo de `checar-regras-suite.py` mostrou.
    """
    return RX_ABREVIACAO.sub(lambda m: m.group(1) + " ", texto)


def marcacao_esperada(turno):
    """O turno EXIGE a confirmação de agendamento?

    `confirmou_agendamento` proíbe afirmar que está marcado, e a razão é boa: a
    Lara dizendo "está agendado" sem ter marcado deixa o paciente contando com
    uma consulta que não existe.

    Mas quando a marcação ACONTECEU, dizer isso é a resposta certa — e a guarda
    de produção sabe a diferença, porque recebe `jaMarcou`. A cópia da suíte não
    recebia nada, então acusava falha dura no único turno do dia em que o
    agendamento funcionou de ponta a ponta (E08, passada 23).

    A dispensa é declarativa: vale quando o próprio cenário EXIGE "agendad". Um
    cenário que não espera marcação continua protegido.
    """
    for rx in turno.get("exige") or []:
        if "agendad" in rx or "marcad" in rx:
            return True
    return False


def ainda_sem_pedido(turno, anteriores):
    """A conversa até aqui não disse o que o paciente quer?

    Existe por causa de `empurra_trabalho`. A proibição de "em que posso
    ajudar?" nasceu com a razão escrita em PERSONA-TEXTO-LIVRE.md: ela empurra o
    trabalho para o paciente "que já disse o que quer", e a alternativa era o
    menu numerado do F00. Em 17/10/2026 o Thiago tirou o menu, e a abertura
    passou a ser exatamente essa pergunta — então a regra acusava falha dura na
    resposta certa a um "oi" seco.

    O que ela guarda continua valendo e continua ligado: devolver a pergunta
    DEPOIS que a pessoa já se explicou é regressão. Por isso a dispensa é a
    conjunção, não só "é a primeira mensagem": a mensagem atual precisa ser
    saudação pura E nenhuma antes pode ter trazido pedido. Sem a segunda metade,
    o "oi?" do I02 no terceiro turno — depois de "é pra cirurgia de catarata" —
    passaria batido.
    """
    if not so_saudacao(turno["paciente"]):
        return False
    return all(so_saudacao(m) for m in anteriores)


CHECAGENS = {
    "@preco_cirurgia": acha_preco_de_cirurgia,
    "@pede_dado_repetido": pede_dado_repetido,
}


def checa(resposta, turno, globais, anteriores=()):
    """Devolve (falhas_duras, avisos).

    Um turno pode declarar `permitido: [nome_da_regra_global]` quando a regra
    não vale ali. Existe por causa do E07: o paciente pergunta literalmente
    quais dias a médica atende, e aí recitar a grade é o comportamento CERTO
    (F06) — mas a regra global `recita_grade` proíbe em qualquer contexto,
    porque ela nasceu para impedir que a grade saia NO LUGAR de uma oferta de
    horário. Sem a exceção, o dado se contradiz e a passada acusa falha dura
    num acerto.

    A exceção é por turno e nomeada de propósito: some do radar se alguém
    apagar, e quem lê o cenário vê qual regra foi dispensada e por quê.
    """
    duras, avisos = [], []
    permitido = set(turno.get("permitido") or [])
    if ainda_sem_pedido(turno, anteriores):
        permitido.add("empurra_trabalho")
    if marcacao_esperada(turno):
        permitido.add("confirmou_agendamento")
    limpo = sem_abreviacoes(resposta)
    for nome, rx in globais.items():
        if nome in permitido:
            continue
        m = re.search(rx, limpo, re.I)
        if m:
            duras.append("global/%s: %r" % (nome, m.group(0)[:60]))
    for rx in turno.get("proibido", []):
        fn = CHECAGENS.get(rx)
        if fn:
            achado = fn(resposta)
            if achado:
                duras.append("%s: %r" % (rx, achado))
            continue
        m = re.search(rx, resposta, re.I)
        if m:
            duras.append("proibido %s: %r" % (rx, m.group(0)[:60]))
    # `exige` é falha DURA; `esperado` é aviso. A diferença é o que a ausência
    # significa.
    #
    # `esperado` cobre REDAÇÃO: "deveria citar 430" pode sair como "quatrocentos
    # e trinta" e estar certo, então acusar falha dura ali encheria o relatório
    # de ruído e treinaria quem lê a ignorá-lo.
    #
    # `exige` cobre FUNÇÃO: o horário saiu, a marcação foi confirmada, o preço
    # apareceu. Sem isto a suíte não reprovava uma Lara que respondesse "Só um
    # instante." a tudo — o Codex mediu em 17/10/2026: zero falhas duras nos 135
    # turnos, só avisos. Toda ausência era leve, inclusive a do comportamento.
    for rx in turno.get("exige", []):
        if not re.search(rx, resposta, re.I):
            duras.append("EXIGIDO e ausente: %s" % rx)
    for rx in turno.get("esperado", []):
        if not re.search(rx, resposta, re.I):
            avisos.append("esperado e ausente: %s" % rx)
    return duras, avisos


def aprova_pendentes():
    """Aprova o que estiver na fila da revisão, como a recepção faria.

    ⚠️ A aprovação TEM de passar pelo host: é ele que envia ao paciente. Apagar
    o arquivo da fila deixaria o paciente sem nada e o cenário no timeout do
    mesmo jeito. Então o harness fala como o grupo de atendimento, mandando
    "ok CODIGO" no JID de onde a aprovação é aceita.

    Devolve os códigos aprovados.
    """
    if not REVISAO_JID:
        return []
    try:
        with open(FILA_REVISAO, encoding="utf-8") as f:
            itens = json.load(f)
    except (OSError, ValueError):
        return []
    codigos = [p.get("codigo") for p in itens if p.get("codigo")]
    for codigo in codigos:
        injeta("ok %s" % codigo, chat=REVISAO_JID, sender=REVISAO_SENDER)
    return codigos


def espera_e_aprova(desde, limite_s=60):
    """Espera a resposta cair na fila da revisão e aprova. Vazio = sem revisão."""
    if not FILA_REVISAO.exists() and not REVISAO_JID:
        return []
    fim = time.time() + limite_s
    while time.time() < fim:
        codigos = aprova_pendentes()
        if codigos:
            return codigos
        time.sleep(2)
    return []


def escaladas():
    """Quantos escalonamentos o host registrou até agora."""
    try:
        with open(LOG_ESCALADAS, encoding="utf-8") as f:
            return sum(1 for linha in f if linha.strip())
    except OSError:
        return 0


def isola_cenario():
    """Apaga o estado de conversa do host antes do cenário.

    Sem isto a suíte não mede o cenário, mede o cenário mais o rastro de todos
    os anteriores. Ver ESTADO_DO_HOST.
    """
    apagados = []
    for nome in ESTADO_DO_HOST:
        alvo = GRUPO_DIR / nome
        if alvo.exists():
            try:
                alvo.unlink()
                apagados.append(nome)
            except OSError as exc:
                print("  (não consegui apagar %s: %s)" % (nome, exc), flush=True)
    return apagados


def roda_cenario(cen, globais):
    res = {"id": cen["id"], "categoria": cen["categoria"], "sobre": cen["sobre"],
           "turnos": [], "duras": [], "avisos": [],
           "_escaladas_antes": escaladas()}
    for i, turno in enumerate(cen["turnos"]):
        texto = turno["paciente"]
        if i == 0:
            texto = CONTROLE + "\n" + texto
        marco = agora_iso()
        t0 = time.time()
        injeta(texto)
        # Com revisão ligada, a resposta espera aprovação antes de ir ao
        # paciente. O harness aprova, senão todo cenário daria timeout.
        #
        # No turno de `silencio: true` nada pode entrar na fila — não há resposta
        # para aprovar — então a espera da fila é pura perda de relógio.
        calado = bool(turno.get("silencio"))
        aprovados = [] if calado else espera_e_aprova(marco)
        partes = espera_resposta(
            marco, TIMEOUT_SILENCIO if calado else None
        )
        resposta = "\n".join(partes)
        bloqueios = avisos_da_guarda(marco)

        duras, avisos = ([], [])
        # `silencio: true` inverte a regra: a ausência de resposta é o
        # comportamento CERTO, e responder é que é falha.
        #
        # Existe por causa da pergunta de robô (Thiago, 19/10/2026): a Lara
        # escala sem dizer nada, porque "Só um instante." ali soa a confissão.
        # Sem isto, o cenário certo apareceria como "SEM RESPOSTA", que é falha
        # dura — e o único jeito de passar seria a Lara responder.
        if calado:
            if partes:
                duras.append("RESPONDEU onde devia calar: %r"
                             % resposta.replace("\n", " / ")[:60])
        elif not partes:
            duras.append("SEM RESPOSTA em %ds" % TIMEOUT_TURNO
                         + (" (guarda bloqueou)" if bloqueios else ""))
        else:
            duras, avisos = checa(
                resposta, turno, globais,
                [t["paciente"] for t in cen["turnos"][:i]],
            )
        if i == 0:
            for rx in cen.get("proibido_abertura", []):
                m = re.search(rx, resposta, re.I)
                if m:
                    duras.append("abertura proibida %s: %r" % (rx, m.group(0)[:50]))
            for rx in cen.get("esperado_abertura", []):
                if not re.search(rx, resposta, re.I):
                    avisos.append("abertura sem: %s" % rx)

        res["turnos"].append({
            "paciente": turno["paciente"],
            "lara": resposta,
            "mensagens": len(partes),
            "segundos": round(time.time() - t0, 1),
            "nota": turno.get("nota", ""),
            "guarda": bloqueios,
            "duras": duras,
            "avisos": avisos,
        })
        res["duras"] += ["T%d: %s" % (i + 1, d) for d in duras]
        res["avisos"] += ["T%d: %s" % (i + 1, a) for a in avisos]

    # `escalou`: o caso chegou à recepção?
    #
    # Pelo texto não dá para saber. O escalonamento responde "Só um instante.",
    # exatamente como um DESCONHECIDO, então um cenário que DEVE escalar ficava
    # verde quer o caso tenha sido aberto ou não. Quem sabe é o log de auditoria
    # do host.
    if "escalou" in cen:
        houve = escaladas() > res["_escaladas_antes"]
        if houve != bool(cen["escalou"]):
            res["duras"].append(
                "escalou=%s, esperado %s" % (houve, bool(cen["escalou"])))
    del res["_escaladas_antes"]
    return res


def relatorio(resultados, destino):
    dur = sum(len(r["duras"]) for r in resultados)
    avi = sum(len(r["avisos"]) for r in resultados)
    reprovados = [r for r in resultados if r["duras"]]
    L = ["# Suíte de conversa da Lara", ""]
    L.append("Rodada em %s" % datetime.now().strftime("%d/%m/%Y %H:%M"))
    L.append("")
    L.append("| | |")
    L.append("|---|---|")
    L.append("| cenários | %d |" % len(resultados))
    L.append("| turnos | %d |" % sum(len(r["turnos"]) for r in resultados))
    L.append("| **falhas duras** | **%d** em %d cenários |" % (dur, len(reprovados)))
    L.append("| avisos (esperado ausente) | %d |" % avi)
    L.append("")
    L.append("> Falha dura é regex proibido que apareceu, ou silêncio. Aviso é"
             " `esperado` que não casou, o que pode ser só redação diferente."
             " **Tom não é medido aqui**: leia a transcrição.")
    L.append("")
    if reprovados:
        L.append("## Reprovados")
        L.append("")
        for r in reprovados:
            L.append("### %s · %s" % (r["id"], r["categoria"]))
            L.append("_%s_" % r["sobre"])
            for d in r["duras"]:
                L.append("- ❌ %s" % d)
            L.append("")
    L.append("## Transcrição completa")
    L.append("")
    for r in resultados:
        marca = "❌" if r["duras"] else ("⚠️" if r["avisos"] else "✅")
        L.append("### %s %s · %s" % (marca, r["id"], r["categoria"]))
        L.append("_%s_" % r["sobre"])
        L.append("")
        for t in r["turnos"]:
            L.append("**paciente:** %s" % t["paciente"])
            L.append("")
            L.append("**Lara** (%d msg, %.1fs):" % (t["mensagens"], t["segundos"]))
            L.append("")
            L.append("```")
            L.append(t["lara"] or "(SEM RESPOSTA)")
            L.append("```")
            if t["nota"]:
                L.append("> a julgar à mão: %s" % t["nota"])
            for g in t["guarda"]:
                L.append("> 🛡️ guarda: %s" % g.replace("\n", " ")[:300])
            for d in t["duras"]:
                L.append("> ❌ %s" % d)
            for a in t["avisos"]:
                L.append("> ⚠️ %s" % a)
            L.append("")
    destino.write_text("\n".join(L) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="ids separados por vírgula")
    ap.add_argument("--categoria", default="")
    ap.add_argument("--listar", action="store_true")
    ap.add_argument("--saida", default="")
    ap.add_argument("--pausa", type=int, default=PAUSA_PADRAO,
                    help="segundos entre cenários (protege a sessão do Baileys)")
    args = ap.parse_args()

    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    globais = suite["_proibido_global"]
    cenarios = suite["cenarios"]

    if args.only:
        # ⚠️ Compara em caixa alta nos DOIS lados. Com `.upper()` só no
        # argumento, qualquer id que tenha minúscula — `T08b`, `Z05b` — era
        # silenciosamente excluído: o runner imprimia "60 cenários" para uma
        # lista de 62 e não dizia quais sumiram. Perdi uma passada começando
        # sem os dois cenários que eu tinha acabado de escrever (19/10/2026).
        ids = {x.strip().upper() for x in args.only.split(",")}
        cenarios = [c for c in cenarios if c["id"].upper() in ids]
        faltando = sorted(ids - {c["id"].upper() for c in cenarios})
        if faltando:
            print("⚠️  ids que não existem na suíte: %s" % ", ".join(faltando))
    if args.categoria:
        cenarios = [c for c in cenarios if c["categoria"] == args.categoria]

    if args.listar:
        for c in cenarios:
            print("%-5s %-18s %d turnos  %s" % (
                c["id"], c["categoria"], len(c["turnos"]), c["sobre"]))
        print("\n%d cenários, %d turnos" % (
            len(cenarios), sum(len(c["turnos"]) for c in cenarios)))
        return 0

    if not cenarios:
        print("nenhum cenário selecionado", file=sys.stderr)
        return 2

    destino = Path(args.saida) if args.saida else (
        RAIZ / "tests" / ("relatorio-lara-%s.md" % datetime.now().strftime("%Y%m%d-%H%M")))

    turnos = sum(len(c["turnos"]) for c in cenarios)
    calados = sum(
        1 for c in cenarios for t in c.get("turnos", []) if t.get("silencio")
    )
    estimado = (
        (turnos - calados) * 35
        + calados * TIMEOUT_SILENCIO
        + len(cenarios) * args.pausa
    ) / 60
    print("rodando %d cenários (%d turnos), pausa de %ds entre cenários"
          % (len(cenarios), turnos, args.pausa), flush=True)
    print("estimativa: ~%d min" % estimado, flush=True)
    resultados = []
    for n, cen in enumerate(cenarios, 1):
        print("[%d/%d] %s %s ..." % (n, len(cenarios), cen["id"], cen["categoria"]),
              end=" ", flush=True)
        isola_cenario()
        r = roda_cenario(cen, globais)
        resultados.append(r)
        print("%d dura(s), %d aviso(s)" % (len(r["duras"]), len(r["avisos"])), flush=True)
        # Salva a cada cenário: suíte longa não pode perder tudo se cair.
        relatorio(resultados, destino)
        (destino.with_suffix(".json")).write_text(
            json.dumps(resultados, ensure_ascii=False, indent=2), encoding="utf-8")
        if n < len(cenarios) and args.pausa:
            time.sleep(args.pausa)

    dur = sum(len(r["duras"]) for r in resultados)
    print("\nfalhas duras: %d | avisos: %d" % (
        dur, sum(len(r["avisos"]) for r in resultados)))
    print("relatório: %s" % destino)
    # Devolve 1 quando houve falha dura. Devolvia 0 sempre, e aí nenhum laço de
    # automação em volta desta suíte conseguia reprovar uma passada — quem lesse
    # o código de saída via sucesso com 30 falhas no relatório (Codex,
    # 17/10/2026).
    return 1 if dur else 0


if __name__ == "__main__":
    sys.exit(main())
