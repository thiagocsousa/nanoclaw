#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vagas livres na agenda da Dra. Marina (iClinic). SOMENTE LEITURA.

Calcula onde cabe um novo agendamento e devolve as melhores posições. NÃO marca,
NÃO desmarca, NÃO remarca — efetivar continua sendo da recepção (FAQ.md F12).

Este arquivo é a ÚNICA fonte da aritmética de agenda: janelas, durações, cota
Unimed e compactação. O FAQ descreve o que a Lara faz com o resultado; não repita
estes números lá.

Uso:
    iclinic_vagas.py --perfil particular-cirurgia
    iclinic_vagas.py --perfil unimed --dia 2026-10-20
    iclinic_vagas.py --perfil particular --dia 2026-10-20 --hora 10:00
    iclinic_vagas.py --perfil exame --dia 2026-10-20 --todas

Saída: texto legível + última linha JSON {"wakeAgent": false, "vagas": [...]}.
"""
import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone

import cnn

TZ = timezone(timedelta(hours=-3))                 # America/Fortaleza

DIAS_PT = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]

# ---------------------------------------------------------------- regras fixas
# 0=segunda ... 6=domingo. Dia ausente = não há consultório.
# ⛔ A JANELA DE ATENDIMENTO SAIU DAQUI (25/10/2026, migração para a CNN).
#
# Era `JANELAS = {0: ("08:00","12:00"), ...}` — a agenda da médica cravada em
# Python. Agora vem de `/executor-agenda/disponibilidade`, que devolve a grade
# livre JÁ com a configuração da agenda E as marcações subtraídas (conferido
# com uma marcação de teste em 24/10: 24 slots → 23 ao marcar → 24 ao
# cancelar).
#
# Não é só mover código: enquanto a janela morava aqui, mudar o horário de
# atendimento exigia lembrar de editar este dict. Em 24/10 isso quase produziu
# o pior caso — a CNN configurada num horário e a Lara oferecendo noutro.
#
# ⚠️ A dependência mudou de lugar, não sumiu: se a agenda da CNN estiver mal
# configurada, a Lara oferece o que ela disser. Quem vigia é
# `scripts/conferir-agenda-cnn.py`, e a regra esperada vive lá.
EXECUTOR_AGENDA = int(os.environ.get("CNN_EXECUTOR_AGENDA", "163882"))
CONVENIO_UNIMED = 74544
# Não ocupam sala de consulta: solicitação é papel, cirurgia é no hospital.
TIPOS_FORA_DA_SALA = {126596, 126578}
TIPOS_DE_EXAME = {126581, 126595}
DURACAO_DO_SLOT = 20

# ⛔ TUDO 20 MINUTOS (Thiago, 24/10/2026). Antes particular era 30 e convênio
# 20; a grade da CNN é de 20 para todos, e manter 30 aqui faria a Lara reservar
# um slot e meio — ofertas que não casam com a grade de quem marca na tela.
#
# A tabela continua existindo em vez de virar uma constante porque ela é lida
# nos DOIS sentidos: o que se quer marcar (PERFIS) e o que já está marcado
# (`dur_de`). Se um dia voltarem a divergir, é aqui.
DURACOES = {"particular": 20, "unimed": 20, "retorno-cirurgia": 20,
            "retorno": 20, "exame": 20}

# perfil pedido -> (tipo, conta na cota Unimed). Pista e antecedência saem daqui.
PERFIS = {
    "particular-cirurgia": ("particular", False),
    "unimed-cirurgia":     ("unimed", False),
    "particular":          ("particular", False),
    "unimed":              ("unimed", True),
    "retorno-cirurgia":    ("retorno-cirurgia", False),
    "retorno":             ("retorno", False),
    "exame":               ("exame", False),
}

# Encaixe no MESMO DIA: só para particular, e com 2 h de antecedência (regra do
# Thiago em 05/10/2026).
#
# São duas travas distintas e as duas são necessárias:
#
# 1. `TIPOS_COM_ENCAIXE_HOJE` — convênio exige autorização e conferência, que
#    não se resolve em horas. Para quem não é particular, hoje simplesmente não
#    existe, e o primeiro dia possível é amanhã.
# 2. `ANTECEDENCIA_MINIMA_MIN` — mesmo para particular, é o tempo de o paciente
#    ver a mensagem, decidir e chegar à clínica.
#
# Antes disso o script oferecia qualquer vaga livre do dia: às 14:00 de
# 05/10/2026 ofereceu "segunda, dia 05/10, às 10:10". O filtro de DIA existia
# (`d >= hoje`); o de HORA, não.
TIPOS_COM_ENCAIXE_HOJE = {"particular"}
ANTECEDENCIA_MINIMA_MIN = 120

# Dias extras varridos à procura de um SEGUNDO dia com vaga, depois de já ter
# achado o primeiro. Cada dia é uma requisição à agenda.
#
# ⚠️ Era 8, e isso custou tempo de resposta medido em produção no mesmo dia
# (19/10/2026): 55 s e 68 s em turnos de agenda, com um container de busca 4
# MINUTOS no ar — perto do teto de 180 s, acima do qual o paciente não recebe
# nada. O Thiago viu o buraco no grupo: "já tá 6 min sem resposta alguma".
#
# Dois é o número certo, não um chute conservador: `alvos` já só tem dias com
# janela (seg/qua/sex, ver a linha do filtro), então UM dia extra basta para
# achar o segundo dia no caso comum, e o segundo cobre o caso de o dia seguinte
# estar cheio. Não achando, a oferta sai com uma opção — que é o fallback
# combinado com o Thiago.
MAX_DIAS_EXTRA = 2

COTA_UNIMED_DIA = 5
ANTECEDENCIA_UNIMED = 7          # dias

# Status que LIBERAM o horário: cancelado, faltou, não compareceu. Os scripts
# irmãos usam {ca,fl,na,bl,hd} com outro sentido ("não exibir"); aqui o sentido é
# "está vago", e bloqueio/feriado NÃO estão — eles travam o dia (STATUS_BLOQUEIO).
STATUS_LIVRE = {"ca", "fl", "na"}

# Feriado e bloqueio travam o DIA INTEIRO. Vêm sem procedimento e tipicamente às
# 00:00 (o feriado de 07/09 na agenda real é assim), então medi-los por duração
# os jogaria para fora da janela e o dia apareceria livre.
STATUS_BLOQUEIO = {"bl", "hd"}

RX_EXAME = re.compile(
    r"TOPOGRAFIA|MAPEAMENTO|BIOMETRIA|PAQUIMETRIA|OCT|CAMPIMETRIA|RETINOGRAFIA", re.I)
# administrativo e cirurgia: não ocupam sala de consulta
RX_IGNORAR = re.compile(
    r"SOLICITA|HONOR[ÁA]RIO|EXAMES FORA|FORA DO CONSULT|^CIRURGIA ", re.I)
RX_UNIMED_COTA = re.compile(r"^CONSULTA\s+UNIMED$", re.I)   # CIRURGIA não entra


def norm(p):
    """iClinic grava 'CONSULTA  PARTICULAR' com dois espaços. Normalize antes de comparar."""
    return re.sub(r"\s+", " ", (p or "")).strip()


def dur_de(proc):
    """Duração que um agendamento JÁ EXISTENTE ocupa, pelo nome do procedimento."""
    p = norm(proc).upper()
    if "RETORNO CIRURGIA" in p:
        return DURACOES["retorno-cirurgia"]
    if p.startswith("RETORNO"):
        return DURACOES["retorno"]
    if "UNIMED" in p:
        return DURACOES["unimed"]
    if "PARTICULAR" in p:
        return DURACOES["particular"]
    if RX_EXAME.search(p):
        return DURACOES["exame"]
    return max(DURACOES.values())      # desconhecido/bloqueio: assume o pior caso


RX_HORA = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def hm(s):
    """'HH:MM' -> minutos. Levanta ValueError em formato inválido (não fatia às cegas)."""
    m = RX_HORA.match((s or "").strip())
    if not m:
        raise ValueError(f"horário inválido: {s!r} (use HH:MM)")
    return int(m.group(1)) * 60 + int(m.group(2))


def mh(m):
    return f"{m // 60:02d}:{m % 60:02d}"


# ------------------------------------------------------------------- iclinic
class AgendaIndisponivel(RuntimeError):
    """A agenda não pôde ser lida. Melhor não responder do que responder errado."""


class Agenda:
    """Agenda e disponibilidade do dia, com cache por data.

    São DUAS perguntas diferentes e a CNN responde cada uma num endpoint:
      - `disponibilidade` diz o que PODE ser oferecido (grade + bloqueios +
        marcações já subtraídas);
      - `agenda` diz o que ESTÁ marcado, e é disso que saem a cota Unimed e a
        separação consulta/exame, que são regras NOSSAS.
    """

    def __init__(self):
        self.por_data = {}
        self.grade = {}

    def eventos(self, d):
        ds = d.isoformat()
        if ds not in self.por_data:
            try:
                self.por_data[ds] = cnn.agenda(ds, ds)
            except cnn.CnnIndisponivel as exc:
                raise AgendaIndisponivel(str(exc)) from exc
        return self.por_data[ds]

    def janela(self, d):
        """(inicio, fim) em minutos, ou None quando não há consultório no dia.

        ⛔ É a UNIÃO dos horários livres com os já marcados, e não só os
        livres. Derivar a janela só da disponibilidade foi o meu primeiro
        desenho e estava errado: num dia com a manhã toda ocupada, a janela
        encolhia para a última folga, o `recortar` jogava fora toda a ocupação,
        e o resultado saía com `agenda_vazia: true` num dia de nove consultas —
        o que faz o host chamar o paciente de "âncora do dia" e muda o texto
        que ele recebe. Peguei lendo a saída, não por teste.

        A janela de atendimento é onde a médica atende; o que está marcado
        dentro dela continua sendo atendimento.
        """
        ds = d.isoformat()
        if ds not in self.grade:
            try:
                slots = cnn.pega(
                    "/executor-agenda/disponibilidade",
                    idExecutorAgenda=EXECUTOR_AGENDA,
                    data=ds, dataFim=ds,
                )
            except cnn.CnnIndisponivel as exc:
                raise AgendaIndisponivel(str(exc)) from exc
            # ⛔ SEM disponibilidade, não há consultório — e o que está
            # marcado no dia NÃO abre o dia.
            #
            # Segundo erro meu no mesmo método, também pego lendo a saída: ao
            # unir livres com marcados eu fiz a TERÇA voltar a ser ofertável.
            # Terça é dia de CIRURGIA, está bloqueada na agenda, e a
            # disponibilidade devolve zero — mas as cirurgias marcadas nela
            # viravam janela, e como cirurgia não ocupa sala de consulta
            # (`TIPOS_FORA_DA_SALA`), o dia inteiro parecia livre. A Lara
            # ofereceria 10:20 de terça, em cima do centro cirúrgico.
            if not slots:
                self.grade[ds] = None
                return None
            pares = [
                (hm(s["horaInicio"][:5]), hm(s["horaFim"][:5])) for s in slots
            ]
            for e in self.eventos(d):
                if e.get("status") in cnn.STATUS_SEM_VALOR:
                    continue
                ini, fim = (e.get("horaInicio") or "")[:5], (e.get("horaFim") or "")[:5]
                if ini and fim:
                    pares.append((hm(ini), hm(fim)))
            self.grade[ds] = (
                (min(a for a, _ in pares), max(b for _, b in pares))
                if pares else None
            )
        return self.grade[ds]


def ocupacao(eventos):
    """(ocupados_consulta, ocupados_exame, n_unimed) a partir dos eventos da CNN.

    ⚠️ `travado` saiu da tupla. No iClinic o bloqueio era um STATUS (`bl`/`hd`)
    que vinha junto dos eventos; na CNN bloqueio é AUSÊNCIA de disponibilidade,
    e quem responde isso é `Agenda.janela`. Deixar um `travado` aqui que nunca
    fosse verdadeiro seria pior que não ter: daria a impressão de que o dia
    bloqueado está sendo checado.
    """
    cons, exam, n_unimed = [], [], 0
    for e in eventos:
        if e.get("status") in cnn.STATUS_SEM_VALOR:
            continue                      # cancelado/faltou: o horário está vago
        hora = (e.get("horaInicio") or "")[:5]
        if not hora:
            continue
        tipo = e.get("idTipoConsulta")
        if tipo in TIPOS_FORA_DA_SALA:
            continue                      # solicitação e cirurgia não ocupam sala
        ini = hm(hora)
        fim_ev = (e.get("horaFim") or "")[:5]
        # A duração REAL do evento, quando a CNN a informa. O `dur_de` por nome
        # era aproximação; aqui o dado existe e é melhor.
        dur = (hm(fim_ev) - ini) if fim_ev and hm(fim_ev) > ini else DURACAO_DO_SLOT
        par = (ini, ini + dur)
        if tipo in TIPOS_DE_EXAME:
            exam.append(par)
        else:
            cons.append(par)
            if e.get("idTipoConvenio") == CONVENIO_UNIMED:
                n_unimed += 1
    return sorted(cons), sorted(exam), n_unimed


# ------------------------------------------------------------------ vagas
def recortar(ocupados, janela):
    """Só o que cai DENTRO da janela conta. Sem isto, um compromisso fora dela
    (ex.: o recorrente das 13:00 na sexta, com a janela até 12:00) entra no
    cálculo e infla o 'buraco' de todas as posições, errando o ranking."""
    ini, fim = janela
    return sorted((max(a, ini), min(b, fim)) for a, b in ocupados
                  if b > ini and a < fim)


def candidatos(ocupados, janela, dur):
    """Posições onde cabe 'dur', encostadas no que já existe (ocupados já recortados)."""
    ini_j, fim_j = janela
    livres, cursor = [], ini_j
    for a, b in ocupados:
        if a > cursor:
            livres.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < fim_j:
        livres.append((cursor, fim_j))
    return sorted({c for a, b in livres if b - a >= dur for c in (a, b - dur)})


def buraco_com(ocupados, inicio, dur):
    """Minutos ociosos ENTRE agendamentos se marcarmos aqui. É o que queremos minimizar."""
    xs = sorted(ocupados + [(inicio, inicio + dur)])
    return sum(max(0, b[0] - a[1]) for a, b in zip(xs, xs[1:]))


def choca(ocupados, inicio, dur):
    """Sobreposição clássica de intervalos."""
    return any(a < inicio + dur and inicio < b for a, b in ocupados)


def vaga(d, inicio, dur, ocup, n_unimed, pedido=False):
    return {"data": d.isoformat(), "dia_semana": DIAS_PT[d.weekday()],
            "inicio": mh(inicio), "fim": mh(inicio + dur),
            "buraco_resultante": buraco_com(ocup, inicio, dur),
            "agenda_vazia": not ocup, "unimed_no_dia": n_unimed,
            "pedido_pelo_paciente": pedido}


def vagas_do_dia(eventos, d, pista, dur, hora, jan, minimo_hm=None):
    """(vagas, recusa) para um dia. Pura — não toca a rede, dá para testar sozinha.

    `minimo_hm` é o começo mais cedo aceitável, em minutos desde a meia-noite.
    Serve para HOJE: sem ele o script oferece horário que já passou, porque o
    filtro de dia (`d >= hoje`) não diz nada sobre a hora.
    """
    if jan is None:
        return [], "não há consultório neste dia"
    if minimo_hm is not None:
        # Recortar a janela cobre os dois caminhos de uma vez: o pedido de hora
        # específica e a listagem de candidatos.
        jan = (max(jan[0], minimo_hm), jan[1])
        if jan[0] + dur > jan[1]:
            return [], "já passou da hora de encaixar hoje"
    cons, exam, n_unimed = ocupacao(eventos)
    ocup = recortar(exam if pista == "exame" else cons, jan)

    if hora:
        ini = hm(hora)
        if not (jan[0] <= ini and ini + dur <= jan[1]):
            return [], "fora da janela de atendimento"
        if choca(ocup, ini, dur):
            return [], "horário ocupado"
        return [vaga(d, ini, dur, ocup, n_unimed, pedido=True)], None

    return [vaga(d, c, dur, ocup, n_unimed) for c in candidatos(ocup, jan, dur)], None


# ------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--perfil", required=True, choices=sorted(PERFIS))
    ap.add_argument("--dia", help="checar uma data específica (YYYY-MM-DD)")
    ap.add_argument("--hora", help="checar um horário específico (HH:MM); exige --dia")
    ap.add_argument("--dias", type=int, default=14, help="horizonte de busca")
    ap.add_argument("--antecedencia", type=int, default=0,
                    help="dias mínimos a partir de hoje; soma-se à regra do perfil")
    ap.add_argument("--todas", action="store_true",
                    help="listar todas as vagas do dia; exige --dia")
    a = ap.parse_args()

    def responder(linhas, vagas=(), recusas=()):
        for l in linhas:
            print(l)
        print(json.dumps({"wakeAgent": False, "perfil": a.perfil,
                          "vagas": list(vagas), "recusas": list(recusas)},
                         ensure_ascii=False))

    if a.hora and not a.dia:
        print("--hora exige --dia.", file=sys.stderr)
        responder([]); return 1
    if a.todas and not a.dia:
        print("--todas exige --dia.", file=sys.stderr)
        responder([]); return 1
    try:
        dia_pedido = date.fromisoformat(a.dia) if a.dia else None
        if a.hora:
            hm(a.hora)                      # valida cedo, antes de qualquer trabalho
    except ValueError as exc:
        print(f"entrada inválida: {exc}", file=sys.stderr)
        responder([], recusas=[(a.dia or "-", f"entrada inválida: {exc}")])
        return 1

    tipo, conta_cota = PERFIS[a.perfil]
    dur = DURACOES[tipo]
    pista = "exame" if tipo == "exame" else "consulta"
    # A antecedência do PERFIL (cota Unimed) e a do PREPARO (--antecedencia) são
    # independentes e as duas valem: quem é Unimed e usa lente de contato espera
    # o maior dos dois prazos, não a soma nem o menor.
    #
    # `--antecedencia` entrou em 19/10/2026 para o preparo de lente de contato:
    # a lente deforma a córnea e a medida da avaliação refrativa sai errada, e
    # sem isto a Lara podia oferecer amanhã para quem precisa de 3 dias sem usar
    # — o paciente viaja, faz o exame, e o exame não presta.
    antec = max(ANTECEDENCIA_UNIMED if conta_cota else 0, max(0, a.antecedencia))
    hoje = datetime.now(TZ).date()
    minimo = hoje + timedelta(days=antec)

    # Hoje só entra para quem pode encaixar no mesmo dia. Para os demais o
    # primeiro dia possível é amanhã, e dizer isso aqui evita calcular vagas que
    # seriam descartadas depois.
    primeiro = max(
        hoje if tipo in TIPOS_COM_ENCAIXE_HOJE else hoje + timedelta(days=1),
        minimo,
    )

    alvos = ([dia_pedido] if dia_pedido
             else [hoje + timedelta(days=i) for i in range(a.dias + 1)])
    # ⚠️ O filtro por dia-da-semana saiu com o JANELAS. Quem diz se há
    # consultório é a CNN, por dia — inclusive feriado e bloqueio pontual, que
    # uma tabela de dias da semana nunca soube.
    alvos = [d for d in alvos if d >= primeiro]

    if dia_pedido == hoje and tipo not in TIPOS_COM_ENCAIXE_HOJE:
        responder([f"{hoje.isoformat()}: encaixe no mesmo dia só para particular."],
                  vagas=[], recusas=[(hoje.isoformat(), "mesmo dia só para particular")])
        return 0

    cab = [f"perfil: {a.perfil} ({dur} min, pista {pista})"]
    if conta_cota:
        cab.append(f"regra Unimed: mínimo {antec} dias de antecedência, teto {COTA_UNIMED_DIA}/dia")

    # ⛔ A pré-checagem sem rede ACABOU, e de propósito.
    #
    # Ela existia porque subir o Chromium e fazer login custava 6–9 s, e
    # "terça tem consulta?" é pergunta esperada. Sem navegador, perguntar à CNN
    # é um GET de ~200 ms — e a resposta dela sabe de feriado e bloqueio
    # pontual, que a tabela local nunca soube. A otimização cobrava uma segunda
    # fonte da verdade e não compra mais nada.
    if not alvos:
        responder(cab + ["", "Esse dia já passou."])
        return 0

    achadas, recusas, falhou_leitura = [], [], False
    # ⛔ Sem navegador. O bloco que vinha aqui subia o Chromium, esperava o
    # campo de e-mail habilitar (45 s de orçamento), fazia login e pegava o
    # csrftoken — ~60 linhas de comentário sobre /dev/shm, tracker com DNS
    # quebrado e corrida perdida. Nada disso existe contra a API da CNN.
    agenda = Agenda()

    extras = 0
    for d in alvos:
        ds = d.isoformat()
        # cota e antecedência não dependem da agenda do dia: barre antes de buscar
        # Vale para TODO perfil agora, não só para quem conta cota: o
        # preparo de lente não tem nada a ver com convênio.
        if d < minimo:
            recusas.append((ds, f"antecedência mínima de {antec} dias"))
            continue
        agora = datetime.now(TZ)
        minimo_hm = (agora.hour * 60 + agora.minute + ANTECEDENCIA_MINIMA_MIN
                     if d == agora.date() else None)
        try:
            jan = agenda.janela(d)
            ev = agenda.eventos(d) if jan else []
        except AgendaIndisponivel as exc:
            recusas.append((ds, f"não consegui ler a agenda — {exc}"))
            falhou_leitura = True
            continue
        if conta_cota:
            _, _, n_unimed = ocupacao(ev)
            if n_unimed >= COTA_UNIMED_DIA:
                recusas.append((ds, f"cota Unimed cheia ({n_unimed}/{COTA_UNIMED_DIA})"))
                continue
        vs, motivo = vagas_do_dia(ev, d, pista, dur, a.hora, jan, minimo_hm)
        if motivo:
            recusas.append((f"{ds} {a.hora}", motivo))
        achadas.extend(vs)
        # Para no SEGUNDO dia com vaga, não no primeiro.
        #
        # Antes era `if achadas: break`, com a razão escrita "compactação
        # é intradia: o dia mais cedo já resolve". Verdade para UMA vaga
        # — e foi o que inviabilizou a decisão do Thiago de 19/10/2026,
        # de oferecer duas opções em dias DISTINTOS: `achadas` nunca
        # tinha mais de um dia, então o host caía sempre no fallback do
        # mesmo dia e o paciente recebia "17:40 ou 18:00".
        #
        # A compactação continua intradia e o `sort` abaixo continua
        # pondo o dia mais cedo primeiro: o segundo dia é alternativa,
        # nunca preferência.
        #
        # ⚠️ TETO de dias extras, e ele é sobre TEMPO DE RESPOSTA, não
        # só sobre o limite de 180 s: cada dia extra é uma requisição, e
        # com 8 a resposta chegou a 68 s em produção. Ver MAX_DIAS_EXTRA.
        if not a.todas:
            dias_com_vaga = {v["data"] for v in achadas}
            if len(dias_com_vaga) >= 2:
                break
            if achadas:
                extras += 1
                if extras >= MAX_DIAS_EXTRA:
                    break

        # Data primeiro: "próximo slot disponível" quer dizer o mais cedo. A compactação
        # desempata DENTRO do dia — é por isso que o break acima, no dia mais cedo que
        # tem vaga, não descarta nada melhor.
    achadas.sort(key=lambda v: (v["data"], v["buraco_resultante"], v["inicio"]))
    # Até 3 por dia, dos 2 primeiros dias — e não as 3 melhores no geral.
    #
    # Com `achadas[:3]` e um dia com 3 vagas ou mais, o segundo dia NUNCA chegava
    # ao JSON, e o `duasOpcoes` do host não tinha como oferecer dias distintos.
    if a.todas or a.dia:
        top = achadas
    else:
        top, por_dia = [], {}
        for v in achadas:                      # já ordenado por (data, encaixe)
            n = por_dia.get(v["data"], 0)
            if len(por_dia) >= 2 and v["data"] not in por_dia:
                break
            if n >= 3:
                continue
            por_dia[v["data"]] = n + 1
            top.append(v)

    if top:
        linhas = [""]
        for v in top:
            extra = (" (agenda vazia — este paciente ancora o dia)" if v["agenda_vazia"]
                     else f" (deixa {v['buraco_resultante']} min de buraco no dia)")
            linhas.append(f"   {v['dia_semana']} {v['data']}  {v['inicio']}–{v['fim']}{extra}")
    else:
        linhas = ["", f"{a.hora} de {a.dia} não dá." if a.hora
                      else ("Não consegui ler a agenda — NÃO ofereça horário, escale."
                            if falhou_leitura else "Nenhuma vaga encontrada no período.")]
        linhas += [f"   {ds}: {m}" for ds, m in recusas[:6]]
        if a.hora:
            linhas.append("   → rode sem --hora para ver o que há nesse dia.")

    responder(cab + linhas, top, recusas[:10])
    return 0


if __name__ == "__main__":
    sys.exit(main())
