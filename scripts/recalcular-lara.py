#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Recalcula o placar de uma rodada já executada, sem falar com a Lara de novo.

## Por que existe

Em 04/10/2026 a 3ª passada acusou 8 falhas duras nos primeiros 15 cenários, e as
8 eram falso positivo meu: a resposta estava certa e o regex da suíte é que
estava errado. Parar a passada e recomeçar custaria uma hora de turnos de agente
e tokens, para medir exatamente as mesmas conversas.

O relatório guarda o texto completo de cada turno, então o critério pode ser
reaplicado offline, de graça. Isso também vale toda vez que uma regra mudar:
dá para reavaliar rodadas antigas com o critério novo e ver se a conclusão
muda, em vez de só confiar na memória.

Uso:
  python3 scripts/recalcular-lara.py tests/relatorios/passada3.json
  python3 scripts/recalcular-lara.py <json> --suite tests/conversas-lara.json
"""
import argparse
import json
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "scripts"))

# Reusa as checagens nomeadas do runner, para não existirem duas semânticas de
# "preço de cirurgia" divergindo com o tempo.
import importlib.util

_spec = importlib.util.spec_from_file_location("tl", RAIZ / "scripts" / "testar-lara.py")
_tl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tl)
CHECAGENS = _tl.CHECAGENS


def avalia(resposta, proibido, esperado, globais):
    duras, avisos = [], []
    for nome, rx in globais.items():
        if rx.startswith("@"):
            fn = CHECAGENS.get(rx)
            achado = fn(resposta) if fn else None
            if achado:
                duras.append("global/%s: %r" % (nome, achado))
            continue
        m = re.search(rx, resposta, re.I)
        if m:
            duras.append("global/%s: %r" % (nome, m.group(0)[:60]))
    for rx in proibido:
        fn = CHECAGENS.get(rx)
        if fn:
            achado = fn(resposta)
            if achado:
                duras.append("%s: %r" % (rx, achado))
            continue
        m = re.search(rx, resposta, re.I)
        if m:
            duras.append("proibido %s: %r" % (rx, m.group(0)[:60]))
    for rx in esperado:
        if not re.search(rx, resposta, re.I):
            avisos.append("esperado e ausente: %s" % rx)
    return duras, avisos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rodada", help="json produzido pelo testar-lara.py")
    ap.add_argument("--suite", default=str(RAIZ / "tests" / "conversas-lara.json"))
    ap.add_argument("--saida", default="")
    args = ap.parse_args()

    rodada = json.loads(Path(args.rodada).read_text(encoding="utf-8"))
    suite = json.loads(Path(args.suite).read_text(encoding="utf-8"))
    globais = suite["_proibido_global"]
    porid = {c["id"]: c for c in suite["cenarios"]}

    antes_d = sum(len(r["duras"]) for r in rodada)
    antes_a = sum(len(r["avisos"]) for r in rodada)

    novos = []
    for r in rodada:
        cen = porid.get(r["id"])
        if not cen:
            novos.append(r)
            continue
        nr = dict(r, duras=[], avisos=[], turnos=[])
        for i, t in enumerate(r["turnos"]):
            turno = cen["turnos"][i] if i < len(cen["turnos"]) else {}
            resposta = t["lara"]
            if not resposta:
                d, a = (["SEM RESPOSTA"], [])
            else:
                d, a = avalia(resposta, turno.get("proibido", []),
                              turno.get("esperado", []), globais)
                if i == 0:
                    for rx in cen.get("proibido_abertura", []):
                        m = re.search(rx, resposta, re.I)
                        if m:
                            d.append("abertura proibida: %r" % m.group(0)[:50])
                    for rx in cen.get("esperado_abertura", []):
                        if not re.search(rx, resposta, re.I):
                            a.append("abertura sem: %s" % rx)
            nt = dict(t, duras=d, avisos=a)
            nr["turnos"].append(nt)
            nr["duras"] += ["T%d: %s" % (i + 1, x) for x in d]
            nr["avisos"] += ["T%d: %s" % (i + 1, x) for x in a]
        novos.append(nr)

    dep_d = sum(len(r["duras"]) for r in novos)
    dep_a = sum(len(r["avisos"]) for r in novos)

    print("cenários reavaliados: %d" % len(novos))
    print("falhas duras: %d  ->  %d" % (antes_d, dep_d))
    print("avisos:       %d  ->  %d" % (antes_a, dep_a))
    rep = [r for r in novos if r["duras"]]
    if rep:
        print("\nainda reprovados:")
        for r in rep:
            print("  %s · %s" % (r["id"], r["categoria"]))
            for x in r["duras"]:
                print("     %s" % x)
    else:
        print("\nnenhum cenário reprovado com o critério corrigido")

    avisados = [r for r in novos if r["avisos"]]
    if avisados:
        print("\navisos (esperado ausente, pode ser só redação diferente):")
        for r in avisados:
            print("  %s · %s" % (r["id"], r["categoria"]))
            for x in r["avisos"]:
                print("     %s" % x)

    destino = Path(args.saida) if args.saida else Path(
        args.rodada).with_name(Path(args.rodada).stem + "-recalculado.json")
    destino.write_text(json.dumps(novos, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\ngravado: %s" % destino)
    return 0


if __name__ == "__main__":
    sys.exit(main())
