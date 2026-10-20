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

from playwright.sync_api import sync_playwright

TZ = timezone(timedelta(hours=-3))                 # America/Fortaleza
EMAIL = os.environ.get("ICLINIC_EMAIL")            # forwarded — nunca hardcodar
SENHA = os.environ.get("ICLINIC_PASSWORD")         # forwarded — nunca hardcodar
CLINIC_ID = os.environ.get("ICLINIC_CLINIC_ID", "263255")
PHYSICIAN_ID = os.environ.get("ICLINIC_PHYSICIAN_ID", "284806")

DIAS_PT = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]

# ---------------------------------------------------------------- regras fixas
# 0=segunda ... 6=domingo. Dia ausente = não há consultório.
JANELAS = {0: ("08:00", "12:00"), 2: ("14:30", "18:30"), 4: ("08:00", "12:00")}

# Duração por TIPO. Fonte única: usada tanto para o que se quer marcar (PERFIS)
# quanto para medir o que já está marcado (dur_de). Mexeu aqui, mexeu nos dois.
DURACOES = {"particular": 30, "unimed": 20, "retorno-cirurgia": 30,
            "retorno": 20, "exame": 10}

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
    """Busca a agenda com cache. O endpoint devolve a SEMANA inteira, não o dia
    (ver nfse_coletar.py, que pagina de 7 em 7). Sem cache, um horizonte de 2
    semanas custaria ~13 requests sequenciais — com timeout de 25 s cada, isso
    estoura o limite de 180 s do agent-runner e o paciente não recebe nada."""

    def __init__(self, page, headers):
        self.page, self.headers = page, headers
        self.por_data = {}          # 'YYYY-MM-DD' -> [eventos]
        self.coberto = set()        # datas que já sabemos ter vindo numa resposta

    def eventos(self, d):
        """Eventos do dia. Levanta AgendaIndisponivel se a agenda não pôde ser lida —
        NUNCA devolve lista vazia por falha de rede: dia não lido ≠ dia livre."""
        ds = d.isoformat()
        if ds not in self.coberto:
            self._buscar(ds)
        return self.por_data.get(ds, [])

    def _buscar(self, ds):
        try:
            r = self.page.request.get(
                f"https://app.iclinic.com.br/agenda/{PHYSICIAN_ID}/{ds}/"
                f"?clinic={CLINIC_ID}&slide=1", headers=self.headers, timeout=25000)
        except Exception as exc:
            raise AgendaIndisponivel(f"{ds}: falha na requisição ({exc})") from exc
        if r.status != 200:
            raise AgendaIndisponivel(f"{ds}: iClinic respondeu HTTP {r.status}")
        self.coberto.add(ds)
        datas = []
        for e in r.json().get("events", []):
            k = (e.get("date") or "")[:10]
            if not k:
                continue
            self.por_data.setdefault(k, []).append(e)
            datas.append(k)
        # tudo entre a primeira e a última data da resposta veio junto: não repetir
        if datas:
            a, b = date.fromisoformat(min(datas)), date.fromisoformat(max(datas))
            while a <= b:
                self.coberto.add(a.isoformat())
                a += timedelta(days=1)


def ocupacao(eventos):
    """(ocupados_consulta, ocupados_exame, n_unimed, dia_travado)."""
    cons, exam, n_unimed, travado = [], [], 0, False
    for e in eventos:
        st = e.get("status") or ""
        if st in STATUS_BLOQUEIO:
            travado = True                # feriado/bloqueio: dia inteiro fora
            continue
        if st in STATUS_LIVRE:
            continue                      # cancelado/faltou: horário está vago
        hora = (e.get("start_time") or "")[:5]
        if not hora:
            continue
        procs = e.get("procedures") or []
        proc = norm((procs[0].get("procedure") or {}).get("name") if procs else "")
        if RX_IGNORAR.search(proc):
            continue                      # solicitação, honorário, cirurgia: não é sala
        ini = hm(hora)
        par = (ini, ini + dur_de(proc))
        if RX_EXAME.search(proc):
            exam.append(par)
        else:
            cons.append(par)
            if RX_UNIMED_COTA.match(proc):
                n_unimed += 1
    return sorted(cons), sorted(exam), n_unimed, travado


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


def vagas_do_dia(eventos, d, pista, dur, hora, minimo_hm=None):
    """(vagas, recusa) para um dia. Pura — não toca a rede, dá para testar sozinha.

    `minimo_hm` é o começo mais cedo aceitável, em minutos desde a meia-noite.
    Serve para HOJE: sem ele o script oferece horário que já passou, porque o
    filtro de dia (`d >= hoje`) não diz nada sobre a hora.
    """
    jan = tuple(hm(x) for x in JANELAS[d.weekday()])
    if minimo_hm is not None:
        # Recortar a janela cobre os dois caminhos de uma vez: o pedido de hora
        # específica e a listagem de candidatos.
        jan = (max(jan[0], minimo_hm), jan[1])
        if jan[0] + dur > jan[1]:
            return [], "já passou da hora de encaixar hoje"
    cons, exam, n_unimed, travado = ocupacao(eventos)
    if travado:
        return [], "dia bloqueado na agenda (feriado ou bloqueio)"
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

    if not EMAIL or not SENHA:
        print("ICLINIC_EMAIL/ICLINIC_PASSWORD não definidos no ambiente.", file=sys.stderr)
        responder([]); return 1

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
    alvos = [d for d in alvos if d.weekday() in JANELAS and d >= primeiro]

    if dia_pedido == hoje and tipo not in TIPOS_COM_ENCAIXE_HOJE:
        responder([f"{hoje.isoformat()}: encaixe no mesmo dia só para particular."],
                  vagas=[], recusas=[(hoje.isoformat(), "mesmo dia só para particular")])
        return 0

    cab = [f"perfil: {a.perfil} ({dur} min, pista {pista})"]
    if conta_cota:
        cab.append(f"regra Unimed: mínimo {antec} dias de antecedência, teto {COTA_UNIMED_DIA}/dia")

    # Checagens que não dependem da rede — respondidas antes de subir o Chromium
    # (login custa ~6-9 s, e terça/quinta são pergunta esperada, não caso raro).
    if not alvos:
        responder(cab + ["", "Esse dia não tem consultório (seg, qua e sex apenas)."])
        return 0
    if a.hora and not (hm(JANELAS[alvos[0].weekday()][0]) <= hm(a.hora)
                       and hm(a.hora) + dur <= hm(JANELAS[alvos[0].weekday()][1])):
        j = JANELAS[alvos[0].weekday()]
        responder(cab + ["", f"{a.hora} está fora da janela desse dia ({j[0]}–{j[1]})."],
                  recusas=[(f"{a.dia} {a.hora}", "fora da janela de atendimento")])
        return 0

    achadas, recusas, falhou_leitura = [], [], False
    with sync_playwright() as p:
        br = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
            # ⚠️ Sem isto o chromium usa /dev/shm para a memória compartilhada
            # entre seus processos, e o Docker dá 64 MB por padrão. Com 64 MB
            # ele não falha com erro: PENDURA — `Page.goto: Timeout 30000ms` em
            # app.iclinic.com.br enquanto um curl da MESMA imagem respondia 200
            # em 2 s (medido em 19/10/2026).
            #
            # O host já passa `--shm-size=1g` (ver src/script-container.ts), mas
            # o flag do host cobre só os 3 spawns que ele controla: o container
            # do AGENTE não tem o flag, e o FAQ manda o agente rodar estes
            # scripts de dentro dele. Aqui o conserto viaja COM o script.
            args=["--disable-dev-shm-usage"])
        try:
            ctx = br.new_context()
            pg = ctx.new_page()
            pg.goto("https://app.iclinic.com.br/", wait_until="domcontentloaded")
            # ⚠️ Esperar o campo HABILITAR antes de digitar.
            #
            # O `fill` do Playwright já espera por "visible, enabled and
            # editable", mas com um orçamento FIXO de 30 s — e 30 s não bastam.
            # Medido em 19/10/2026 na VM: o campo leva ~2,5 s numa máquina
            # folgada, e passa de 30 s sob carga, porque a página de login ainda
            # soma um tracker cujo DNS não resolve
            # (event.getblue.io, ERR_NAME_NOT_RESOLVED) e uma geolocalização que
            # vai até o próprio timeout no headless.
            #
            # Quando estoura, o erro que chega é
            # '<input disabled ... placeholder="Email de acesso">' com "element
            # is not enabled" — que se lê como "o iClinic bloqueou a conta", e
            # não é: é corrida perdida. Foi o que derrubou a busca por telefone
            # em A07 e E08 na passada 25.
            #
            # ⚠️ 45 s, não 90: o orçamento grande conserta a corrida mas triplica
            # o que um login PERDIDO custa, e aí uma corrida perdida come metade
            # do teto de 180 s do host antes da colheita poder agir. 45 s cobre
            # o caso medido sob carga com folga.
            pg.wait_for_selector(
                'input[name="email"]:not([disabled])', timeout=45000)
            pg.fill('input[name="email"]', EMAIL)
            pg.fill('input[name="password"]', SENHA)
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=25000):
                pg.click('button[type="submit"]')
            pg.wait_for_timeout(3000)
            csrf = next((c["value"] for c in ctx.cookies() if c["name"] == "csrftoken"), "")
            agenda = Agenda(pg, {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf})

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
                    ev = agenda.eventos(d)
                except AgendaIndisponivel as exc:
                    recusas.append((ds, f"não consegui ler a agenda — {exc}"))
                    falhou_leitura = True
                    continue
                if conta_cota:
                    _, _, n_unimed, _ = ocupacao(ev)
                    if n_unimed >= COTA_UNIMED_DIA:
                        recusas.append((ds, f"cota Unimed cheia ({n_unimed}/{COTA_UNIMED_DIA})"))
                        continue
                vs, motivo = vagas_do_dia(ev, d, pista, dur, a.hora, minimo_hm)
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
        finally:
            br.close()

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
