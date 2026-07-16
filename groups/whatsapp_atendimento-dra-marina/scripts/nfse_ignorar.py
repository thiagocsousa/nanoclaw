#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Descarta itens da lista de NFS-e SEM emitir (paciente não quer, não vai emitir).
Marca os receita_id em nfse_ignoradas.json → o coletor para de listá-los.

Uso: python3 nfse_ignorar.py "2,4"   (números da lista apresentada)
"""
import json
import os
import re
import sys
from pathlib import Path

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
PENDING_FILE = Path(GROUP) / "pending_nfse.json"
IGNORADAS_FILE = Path(GROUP) / "nfse_ignoradas.json"


def parse_nums(sel):
    idxs = set()
    for tok in re.split(r"[,\s]+", (sel or "").strip()):
        if "-" in tok:
            a, b = tok.split("-", 1)
            if a.isdigit() and b.isdigit():
                idxs.update(range(int(a), int(b) + 1))
        elif tok.isdigit():
            idxs.add(int(tok))
    return idxs


def main():
    if len(sys.argv) < 2:
        print("Uso: nfse_ignorar.py '2,4'", file=sys.stderr)
        sys.exit(1)
    if not PENDING_FILE.exists():
        print("Erro: pending_nfse.json não encontrado.", file=sys.stderr)
        sys.exit(1)
    pending = json.loads(PENDING_FILE.read_text())
    nums = parse_nums(sys.argv[1])
    alvos = [x for x in pending["itens"] if x["n"] in nums]
    if not alvos:
        print("Nenhum item correspondente aos números informados.")
        return

    ign = set(map(str, json.loads(IGNORADAS_FILE.read_text()))) if IGNORADAS_FILE.exists() else set()
    for x in alvos:
        ign.add(str(x["receita_id"]))
    IGNORADAS_FILE.write_text(json.dumps(sorted(ign), ensure_ascii=False))

    lines = [f"🗑️ *{len(alvos)}* item(ns) descartado(s) (não serão emitidos e saem da lista):"]
    for x in alvos:
        lines.append(f"• {x['paciente']} — {x['servico']} — R$ {x['valor']}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
