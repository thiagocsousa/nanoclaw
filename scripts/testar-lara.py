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
SENDER = "195421196562669@lid"
SENDER_NAME = "Thiago Carvalho"
# DM do Thiago: é onde a guarda de saída e a cobrança de escalonamento avisam.
DM_THIAGO = "558681512111@s.whatsapp.net"

CONTROLE = "--- NOVO PACIENTE ---"
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


def injeta(texto):
    """Grava a mensagem do 'paciente' e devolve o timestamp usado."""
    ts = agora_iso()
    mid = "TESTE" + "".join(random.choices(string.ascii_uppercase + string.digits, k=15))
    with conn() as c:
        c.execute(
            "INSERT INTO messages (id, chat_jid, sender, sender_name, content,"
            " timestamp, is_from_me, is_bot_message) VALUES (?,?,?,?,?,?,1,0)",
            (mid, CHAT, SENDER, SENDER_NAME, texto, ts),
        )
    return ts


def espera_resposta(desde):
    """Coleta as mensagens da Lara posteriores a `desde`. Lista vazia = silêncio."""
    limite = time.time() + TIMEOUT_TURNO
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


CHECAGENS = {
    "@preco_cirurgia": acha_preco_de_cirurgia,
    "@pede_dado_repetido": pede_dado_repetido,
}


def checa(resposta, turno, globais):
    """Devolve (falhas_duras, avisos)."""
    duras, avisos = [], []
    for nome, rx in globais.items():
        m = re.search(rx, resposta, re.I)
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
    for rx in turno.get("esperado", []):
        if not re.search(rx, resposta, re.I):
            avisos.append("esperado e ausente: %s" % rx)
    return duras, avisos


def roda_cenario(cen, globais):
    res = {"id": cen["id"], "categoria": cen["categoria"], "sobre": cen["sobre"],
           "turnos": [], "duras": [], "avisos": []}
    for i, turno in enumerate(cen["turnos"]):
        texto = turno["paciente"]
        if i == 0:
            texto = CONTROLE + "\n" + texto
        marco = agora_iso()
        t0 = time.time()
        injeta(texto)
        partes = espera_resposta(marco)
        resposta = "\n".join(partes)
        bloqueios = avisos_da_guarda(marco)

        duras, avisos = ([], [])
        if not partes:
            duras.append("SEM RESPOSTA em %ds" % TIMEOUT_TURNO
                         + (" (guarda bloqueou)" if bloqueios else ""))
        else:
            duras, avisos = checa(resposta, turno, globais)
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
        ids = {x.strip().upper() for x in args.only.split(",")}
        cenarios = [c for c in cenarios if c["id"] in ids]
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
    estimado = (turnos * 35 + len(cenarios) * args.pausa) / 60
    print("rodando %d cenários (%d turnos), pausa de %ds entre cenários"
          % (len(cenarios), turnos, args.pausa), flush=True)
    print("estimativa: ~%d min" % estimado, flush=True)
    resultados = []
    for n, cen in enumerate(cenarios, 1):
        print("[%d/%d] %s %s ..." % (n, len(cenarios), cen["id"], cen["categoria"]),
              end=" ", flush=True)
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
