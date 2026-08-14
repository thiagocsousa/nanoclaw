#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Resumo das confirmações de lembrete de consulta — roda no MESMO dia da coleta,
às 17h (2h após o envio das 15h). Lê o manifesto gerado hoje + o log passivo de
respostas dos pacientes (lembrete_respostas.jsonl, alimentado pelo core) e
classifica cada paciente em SIM / NÃO / a conferir / sem resposta.

Imprime {"wakeAgent": true, "data": {...}} → o agente é acordado NO GRUPO do
atendimento e posta o resumo lá. O agente NUNCA fala com o paciente.
Se não houve coleta hoje (fim de semana/feriado) → {"wakeAgent": false}.
"""
import json
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
MANIFEST_ULTIMO = Path(GROUP) / "lembrete_manifest_ultimo.json"
RESPOSTAS = Path(GROUP) / "lembrete_respostas.jsonl"

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza

SIM = ("sim", "confirmo", "confirmado", "confirmar", "confirma", "ok", "okay",
       "isso", "pode", "podem", "claro", "positivo", "blz", "beleza", "vou",
       "estarei", "comparecer", "comparecerei", "certo", "perfeito", "👍", "✅")
NAO = ("nao", "remarcar", "remarca", "cancelar", "cancela", "desmarcar",
       "desmarca", "negativo", "impossivel", "consigo nao", "outro dia",
       "outra data", "🔄", "❌", "❎")


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return s.lower().strip()


def match_key(phone):
    d = re.sub(r"\D", "", phone or "")
    if len(d) < 12:
        return d
    return "55" + d[2:4] + d[-8:]


def classify(text):
    t = norm(text)
    raw = (text or "").strip()
    # NÃO tem prioridade sobre SIM ("não posso" contém "posso" que não é SIM)
    if any(k in t for k in NAO) or "❌" in raw or "🔄" in raw:
        return "nao"
    if any(k in t for k in SIM) or "👍" in raw or "✅" in raw:
        return "sim"
    return "outro"


def parse_ts(iso):
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def main():
    hoje = datetime.now(TZ).strftime("%Y-%m-%d")
    if not MANIFEST_ULTIMO.exists():
        print(json.dumps({"wakeAgent": False, "data": {"message": "Sem manifesto."}}))
        return
    manifest = json.loads(MANIFEST_ULTIMO.read_text())
    if manifest.get("gerado_em_data") != hoje:
        # coleta não rodou hoje (fim de semana/feriado) — nada a resumir
        print(json.dumps({"wakeAgent": False,
                          "data": {"message": "Sem coleta hoje."}}))
        return

    since = float(manifest.get("gerado_em_epoch") or 0)
    pacientes = manifest.get("pacientes", [])

    # Índice das respostas por match_key (só as recebidas após o envio)
    respostas = {}
    if RESPOSTAS.exists():
        for line in RESPOSTAS.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if parse_ts(r.get("timestamp")) < since:
                continue
            k = match_key(r.get("phone") or r.get("jid", "").split("@")[0])
            respostas.setdefault(k, []).append(r)

    confirmados, recusados, conferir, sem_resposta = [], [], [], []
    for p in pacientes:
        k = p.get("match_key") or match_key(p.get("telefone"))
        msgs = respostas.get(k, [])
        item = {"nome": p["nome"], "hora": p.get("hora"), "proc": p.get("procedimento")}
        if not msgs:
            sem_resposta.append(item)
            continue
        # usa a ÚLTIMA resposta do paciente
        last = sorted(msgs, key=lambda m: parse_ts(m.get("timestamp")))[-1]
        item["resposta"] = (last.get("text") or "").strip()[:120]
        c = classify(last.get("text"))
        (confirmados if c == "sim" else recusados if c == "nao" else conferir).append(item)

    data = {
        "alvo": manifest.get("alvo_disp"),
        "dia_semana": manifest.get("dia_semana"),
        "total": len(pacientes),
        "confirmados": confirmados,
        "recusados": recusados,
        "conferir": conferir,
        "sem_resposta": sem_resposta,
    }
    print(json.dumps({"wakeAgent": True, "data": data}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"wakeAgent": False,
                          "data": {"error": str(e), "traceback": traceback.format_exc()}}))
