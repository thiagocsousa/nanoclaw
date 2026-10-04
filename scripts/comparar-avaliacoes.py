#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Compara duas rodadas do avaliador e mostra só o que MUDOU.

## Por que não basta comparar as duas acurácias

Duas rodadas com a mesma acurácia podem ter consertado cinco turnos e quebrado
outros cinco. O número agregado esconde exatamente o que interessa depois de
mexer no prompt: o que melhorou, o que piorou, e se o que piorou é grave.

Erro grave e erro caro não são simétricos, então a saída separa:
  consertou   — errava, acertou
  quebrou     — acertava, errou   <- é aqui que se olha primeiro
  e dentro de "quebrou", quem passou a RESPONDER o que devia escalar
"""
import argparse
import json
import sys
from pathlib import Path


def chave(c):
    return (c["cenario"], c["mensagem"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("antes")
    ap.add_argument("depois")
    ap.add_argument("--tabela", default="groups/whatsapp_atendimento-teste/templates.json")
    args = ap.parse_args()

    a = {chave(c): c for c in json.loads(Path(args.antes).read_text(encoding="utf-8"))}
    b = {chave(c): c for c in json.loads(Path(args.depois).read_text(encoding="utf-8"))}
    tab = json.loads(Path(args.tabela).read_text(encoding="utf-8"))
    escalam = {n for n, d in tab["intencoes"].items() if d.get("acao") == "escalar"}

    def escala(nome):
        return nome in escalam or nome == "DESCONHECIDO"

    comuns = sorted(set(a) & set(b))
    print("turnos em comum: %d  (só em antes: %d, só em depois: %d)"
          % (len(comuns), len(set(a) - set(b)), len(set(b) - set(a))))
    oka = sum(1 for k in comuns if a[k]["acertou"])
    okb = sum(1 for k in comuns if b[k]["acertou"])
    print("acurácia nos comuns: %d -> %d  (%+d)\n" % (oka, okb, okb - oka))

    consertou = [k for k in comuns if not a[k]["acertou"] and b[k]["acertou"]]
    quebrou = [k for k in comuns if a[k]["acertou"] and not b[k]["acertou"]]

    print("CONSERTOU: %d" % len(consertou))
    for k in consertou:
        print("  %-5s %-24s %s -> ACERTOU   %s"
              % (k[0], b[k]["esperado"], a[k]["previsto"], k[1][:38]))

    print("\nQUEBROU: %d" % len(quebrou))
    graves = [k for k in quebrou if escala(b[k]["esperado"]) and not escala(b[k]["previsto"])]
    for k in quebrou:
        marca = "  <-- GRAVE, passou a responder o que devia escalar" if k in graves else ""
        print("  %-5s %-24s ACERTAVA -> %-22s %s%s"
              % (k[0], b[k]["esperado"], b[k]["previsto"], k[1][:34], marca))
    if quebrou and not graves:
        print("  (nenhum grave: todos continuam escalando ou trocam resposta por resposta)")

    # Erros que sobraram nos dois: o que o conserto não alcançou.
    teimosos = [k for k in comuns if not a[k]["acertou"] and not b[k]["acertou"]]
    print("\nERRAVA E CONTINUA ERRANDO: %d" % len(teimosos))
    for k in teimosos:
        mudou = "" if a[k]["previsto"] == b[k]["previsto"] else " (mudou de %s)" % a[k]["previsto"]
        print("  %-5s %-24s -> %-22s %s%s"
              % (k[0], b[k]["esperado"], b[k]["previsto"], k[1][:34], mudou))
    return 0


if __name__ == "__main__":
    sys.exit(main())
