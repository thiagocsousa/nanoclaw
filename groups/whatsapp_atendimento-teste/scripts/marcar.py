#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Registra a autoavaliação da agente sobre a resposta que ela acabou de dar.

## Por que existe

A medição do teste era uma linha no fim da própria mensagem:

    [intenção: verificar vaga | fonte: base (F12)]

Isso funcionou para medir, mas o paciente lia a linha. Num teste de tom isso é
fatal duas vezes: estraga justamente o que se quer medir (a resposta parece de
robô por causa do instrumento, não da redação) e, se o grupo de teste virar
produção por descuido, a telemetria vaza para o paciente.

Então a marcação saiu do texto e virou arquivo. Mesma informação, mesmo custo
de honestidade — só não passa pelos olhos de quem está do outro lado.

Uso:
  marcar.py --intencao "verificar vaga" --fonte base --bloco F12 [--script iclinic_vagas.py]
  marcar.py --intencao "preco da cirurgia" --fonte INVENTADO

  --fonte  base | escalado | INVENTADO

Use INVENTADO com honestidade quando afirmar algo que não está na base. É
exatamente o que o teste quer medir — esconder isso não melhora o resultado,
só cega quem está lendo.

Grava em rodadas.jsonl. Não envia nada a ninguém.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

GROUP = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
LOG = GROUP / "rodadas.jsonl"
TZ = timezone(timedelta(hours=-3))  # America/Fortaleza

FONTES = ("base", "escalado", "INVENTADO")


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--intencao", required=True, help="o que o paciente queria")
    ap.add_argument("--fonte", required=True, choices=FONTES)
    ap.add_argument("--bloco", default="", help="bloco do FAQ usado, ex.: F12")
    ap.add_argument("--script", default="", help="script executado, se houve")
    ap.add_argument("--nota", default="", help="observação livre")
    args = ap.parse_args()

    entrada = {
        "quando": datetime.now(TZ).isoformat(timespec="seconds"),
        "intencao": args.intencao.strip(),
        "fonte": args.fonte,
        "bloco": args.bloco.strip(),
        "script": args.script.strip(),
        "nota": args.nota.strip(),
    }

    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entrada, ensure_ascii=False) + "\n")
    except OSError as exc:
        # Falhar aqui não pode derrubar o atendimento: a marcação é telemetria
        # do teste, o paciente esperando resposta é o que importa.
        print("marcar.py: nao gravou (%s)" % exc, file=sys.stderr)
        print(json.dumps({"wakeAgent": False, "marcado": False}))
        return 0

    print("marcado: %s / %s" % (entrada["intencao"], entrada["fonte"]))
    print(json.dumps({"wakeAgent": False, "marcado": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
