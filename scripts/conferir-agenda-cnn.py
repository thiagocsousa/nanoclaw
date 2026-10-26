#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mostra o que a Lara TEM PARA OFERECER, dia a dia, na Clínica nas Nuvens.

## A pergunta mudou em 26/10/2026

Até aqui ele perguntava "a agenda da CNN bate com a regra?". Fazia sentido
enquanto a grade da CNN era a fonte da oferta: em 24/10 ela devolvia 08:00–18:00
em TODOS os dias, sábado e domingo inclusive, e a Lara teria oferecido domingo.

Decisão do Thiago em 26/10: a agenda da CNN fica **aberta de propósito**, porque
é por ela que a secretária marca exame na quinta e cirurgia na terça, e quem
restringe consulta é a Lara (`JANELAS_DE_CONSULTA`, em `iclinic_vagas.py`).

Com isso a pergunta velha passou a ter resposta "diverge" **sempre**, por
desenho — 12 dias de 14 no primeiro dia. Guarda que grita sem motivo é guarda
que alguém desliga, e aí ela não pega o dia em que importa.

A pergunta certa agora é **"a Lara tem o que oferecer?"**, que é a única que o
paciente sente.

## Os três estados, e por que viagem não é alarme

| o que se vê | significa | sai como |
|---|---|---|
| grade dentro da janela | normal | ✅ com os blocos |
| dia SEM grade nenhuma | bloqueado: viagem, feriado, dia cheio | ℹ️ sem alarme |
| grade no dia, nada DENTRO da janela | turno divergente | ⛔ |

A terceira linha é a que vale o ⛔, e distingui-la da segunda é o ponto todo.
Em 30/10/2026 a Marina viajou e o dia ficou bloqueado; a versão anterior
reportou isso como "⚠️ falta 12 horários" — alerta sobre uma decisão correta.
Dia fechado é informação; dia aberto no turno errado é defeito.

## O que ele NÃO faz

Não corrige nada, e não configura: o único endpoint que mexe na agenda é do
módulo clínica-escola, carrega permissões de acesso junto e não tem GET para
ler o estado atual — escrita cega não se faz em conta de produção. Configurar é
trabalho de tela; conferir é isto aqui.

Uso:
  CNN_CLIENT_ID=... CNN_CLIENT_SECRET=... CNN_CID=... \\
    python3 scripts/conferir-agenda-cnn.py [--semanas 2]
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE = "https://api.clinicanasnuvens.com.br"
EXECUTOR = int(os.environ.get("CNN_EXECUTOR_AGENDA", "163882"))

# ⛔ A regra real, e agora o ÚNICO lugar onde ela vive em código.
#
# O comentário anterior dizia "espelhando JANELAS de iclinic_vagas.py" — e o
# JANELAS saiu de lá na migração de 25/10, porque a janela passou a vir da
# própria CNN. O espelho ficou apontando para um dict apagado.
#
# ⚠️ E essa inversão deixou de valer em 26/10/2026. Decisão do Thiago: a agenda
# da CNN fica ABERTA, para a secretária marcar exame e cirurgia nos outros
# dias, e quem restringe CONSULTA aos horários da Marina volta a ser a Lara.
#
# Então esta tabela é as DUAS coisas agora: a expectativa contra a qual se
# confere a CNN, e — copiada em
# `groups/whatsapp_atendimento-teste/scripts/iclinic_vagas.py`, como
# `JANELAS_DE_CONSULTA` — a regra que a Lara aplica sobre a grade.
#
# ⛔ As duas cópias têm de ser idênticas, e divergir é o pior caso: mudar o
# horário da quarta em uma só faz este script dizer "agenda ok" enquanto a Lara
# oferece noutro turno. `src/janela-de-consulta.test.ts` falha quando
# discordam. Cópia existe porque script de grupo não importa script do
# repositório — só `/workspace/group` é montado.
JANELAS = {
    0: [("08:00", "12:00")],   # segunda
    2: [("14:00", "18:00")],   # quarta (mudou em 24/10/2026)
    4: [("08:00", "12:00")],   # sexta
}
DIAS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]

# Decidido em 24/10/2026: tudo 20 minutos, inclusive particular (eram 30).
DURACAO_ESPERADA = 20


def pega(caminho):
    cid = os.environ.get("CNN_CID")
    usuario = os.environ.get("CNN_CLIENT_ID")
    senha = os.environ.get("CNN_CLIENT_SECRET")
    if not (cid and usuario and senha):
        sys.exit("faltam CNN_CLIENT_ID, CNN_CLIENT_SECRET e CNN_CID no ambiente")
    req = urllib.request.Request(f"{BASE}{caminho}")
    cred = base64.b64encode(f"{usuario}:{senha}".encode()).decode()
    req.add_header("Authorization", f"Basic {cred}")
    req.add_header("clinicaNasNuvens-cid", cid)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        sys.exit(f"HTTP {exc.code} em {caminho}: {exc.read()[:200]}")


def minutos(hhmm):
    h, m = hhmm.split(":")[:2]
    return int(h) * 60 + int(m)


def janela_do_dia(d):
    """[(ini, fim)] em minutos que a Lara pode oferecer neste dia. Vazio = não."""
    return [
        (minutos(a), minutos(b)) for a, b in JANELAS.get(d.weekday(), [])
    ]


def blocos(ms, passo=DURACAO_ESPERADA):
    """Agrupa minutos soltos em [(ini, fim)] contíguos, para ler como humano."""
    if not ms:
        return []
    ms = sorted(ms)
    out, ini, ant = [], ms[0], ms[0]
    for m in ms[1:]:
        if m - ant > passo:
            out.append((ini, ant + passo))
            ini = m
        ant = m
    out.append((ini, ant + passo))
    return out


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


# Fortaleza é UTC−3 o ano inteiro (o Brasil não tem mais horário de verão), e a
# VM roda em UTC. Sem isto, "hoje" aqui é o dia e a hora errados.
FORTALEZA = timezone(timedelta(hours=-3))


def agendamentos_do_dia(d):
    """Quantos eventos a agenda tem nesse dia. Separa 'cheio' de 'bloqueado'."""
    try:
        r = pega(
            f"/agenda/lista?dataInicial={d.isoformat()}&dataFinal={d.isoformat()}"
            f"&dataPor=AGENDAMENTO&registrosPorPagina=100"
        )
        return len(r.get("lista") or [])
    except SystemExit:
        # `pega` encerra o processo em erro HTTP. Aqui a contagem é um detalhe
        # da mensagem, não o trabalho — melhor não derrubar a conferência toda.
        return None


def ja_passou(d, janela):
    """A janela desse dia já ficou no passado? Só faz sentido para HOJE.

    ⛔ Existe por um erro meu, em 26/10/2026. Medindo a disponibilidade às
    13h30 locais, vi a segunda devolver só 14:20 em diante e reportei ao Thiago
    que "os turnos de segunda e quarta estão invertidos". Não estavam: a manhã
    simplesmente já tinha passado, e a API não devolve slot no passado.

    Uma mensagem que diz "viagem, feriado ou cheio" para um dia que só acabou
    manda procurar problema onde não há.
    """
    agora = datetime.now(FORTALEZA)
    if d != agora.date():
        return False
    fim = max(b for _, b in janela)
    return agora.hour * 60 + agora.minute >= fim


def legivel(bs):
    return "  ".join(f"{hhmm(a)}-{hhmm(b)}" for a, b in bs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--semanas", type=int, default=2)
    a = ap.parse_args()

    hoje = date.today()
    turno_errado = 0
    dias_com_oferta = 0
    dias_de_consulta = 0
    print(f"executor {EXECUTOR} · {a.semanas} semana(s) a partir de {hoje}")
    print("o que a Lara ofereceria, depois da interseção com a janela:\n")

    for i in range(a.semanas * 7):
        d = hoje + timedelta(days=i)
        janela = janela_do_dia(d)
        rot = f"{d.isoformat()} {DIAS[d.weekday()]:8}"

        if not janela:
            # Terça, quinta, sábado e domingo: a Lara não oferece, e isso não
            # depende da CNN. Dizer "ok" aqui seria dizer que conferi algo.
            print(f"  {rot} —        (a Lara não oferece neste dia)")
            continue

        dias_de_consulta += 1
        slots = pega(
            f"/executor-agenda/disponibilidade?idExecutorAgenda={EXECUTOR}"
            f"&data={d.isoformat()}&dataFim={d.isoformat()}"
        )
        tem = {minutos(s["horaInicio"]) for s in slots}
        dentro = {m for m in tem if any(a <= m < b for a, b in janela)}

        if dentro:
            dias_com_oferta += 1
            print(f"  {rot} ✅ {len(dentro):2d} slots   {legivel(blocos(dentro))}")
            continue

        if not tem:
            # ⚠️ Dia fechado é DECISÃO, não defeito: viagem, feriado, ou o dia
            # inteiro já marcado. Em 30/10/2026 a Marina viajou, e a versão
            # anterior deste script reportou isso como falta.
            if ja_passou(d, janela):
                print(f"  {rot} ℹ️  a janela de hoje já passou")
                dias_de_consulta -= 1    # não conta contra: não há o que conferir
                continue
            n = agendamentos_do_dia(d)
            if n is None:
                motivo = "não consegui contar os agendamentos"
            elif n == 0:
                motivo = "bloqueado (nenhum agendamento no dia)"
            else:
                motivo = f"cheio ou bloqueado ({n} agendamento(s) no dia)"
            print(f"  {rot} ℹ️  sem horário — {motivo}")
            continue

        # ⛔ O caso que vale alarme: o dia está ABERTO e nada cai na janela.
        # Isso é turno divergente — a agenda foi configurada noutro horário —, e
        # não dá para confundir com bloqueio, porque bloqueio não deixa slot.
        turno_errado += 1
        print(f"  {rot} ⛔ {len(tem)} slots no dia, NENHUM na janela")
        print(f"      a janela pede {legivel(janela)}")
        print(f"      a CNN oferece {legivel(blocos(tem))}")

    print()
    if turno_errado:
        print(
            f"⛔ {turno_errado} dia(s) abertos no turno ERRADO — a agenda da CNN "
            "foi configurada noutro horário."
        )
        return 1
    if dias_de_consulta and not dias_com_oferta:
        # A Lara muda no horizonte inteiro. Sem este ramo, um script que só
        # imprime "ℹ️" em tudo sairia com 0 e pareceria saudável.
        print(
            "⛔ NENHUM dia de consulta tem horário no horizonte — a Lara está "
            "muda. Agenda não configurada, ou bloqueio longo demais."
        )
        return 1
    print(f"✅ {dias_com_oferta} de {dias_de_consulta} dia(s) de consulta com horário.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
