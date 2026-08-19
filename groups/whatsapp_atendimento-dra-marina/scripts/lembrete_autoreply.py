#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Auto-resposta ao paciente DEPOIS que ele responde ao lembrete de consulta.
Roda de poucos em poucos minutos na janela da tarde. Lê o manifesto do lote +
as respostas capturadas (lembrete_respostas.jsonl) e, para cada paciente do
lote que respondeu e ainda não foi respondido, envia UMA mensagem FIXA:
  • confirmou (SIM)  → agradece e reforça que é horário marcado
  • qualquer outra   → avisa que a secretaria entra em contato

Texto 100% fixo (nunca LLM). Dedup em lembrete_acked.json (um ack por paciente
por lote). Imprime {"wakeAgent": false} — não acorda o agente.
"""
import json
import os
import re
import time
import random
import string
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
MANIFEST_ULTIMO = Path(GROUP) / "lembrete_manifest_ultimo.json"
RESPOSTAS = Path(GROUP) / "lembrete_respostas.jsonl"
ACKED = Path(GROUP) / "lembrete_acked.json"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza

SIM = ("sim", "confirmo", "confirmado", "confirmar", "confirma", "ok", "okay",
       "isso", "pode", "podem", "claro", "positivo", "blz", "beleza", "vou",
       "estarei", "comparecer", "comparecerei", "certo", "perfeito", "👍", "✅")
NAO = ("nao", "remarcar", "remarca", "cancelar", "cancela", "desmarcar",
       "desmarca", "negativo", "impossivel", "outro dia", "outra data",
       "🔄", "❌", "❎")

MSG_SIM = (
    "Perfeito, obrigado por confirmar! Sua consulta está confirmada — é um "
    "horário reservado especialmente para você. Até lá!\n\n"
    "_Clínica Dra. Marina Costa_"
)
MSG_OUTRO = (
    "Obrigado pelo retorno! Nossa secretaria vai entrar em contato com você "
    "em breve.\n\n_Clínica Dra. Marina Costa_"
)


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


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


def send_message(jid, text):
    IPC_MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_MESSAGES_DIR / f"{int(time.time() * 1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps({
        "type": "message",
        "chatJid": jid,
        "text": text,
        "groupFolder": "whatsapp_atendimento-dra-marina",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }, ensure_ascii=False, indent=2))
    tmp.rename(fp)


def main():
    if not MANIFEST_ULTIMO.exists() or not RESPOSTAS.exists():
        print(json.dumps({"wakeAgent": False, "data": {"acked": 0}}))
        return
    manifest = json.loads(MANIFEST_ULTIMO.read_text())
    alvo = manifest.get("alvo")
    since = float(manifest.get("gerado_em_epoch") or 0)
    # índice paciente por match_key
    por_key = {}
    for p in manifest.get("pacientes", []):
        k = p.get("match_key") or match_key(p.get("telefone"))
        if k:
            por_key[k] = p

    # estado de dedup (reseta quando muda o lote/alvo)
    acked = {"alvo": alvo, "keys": []}
    if ACKED.exists():
        try:
            prev = json.loads(ACKED.read_text())
            if prev.get("alvo") == alvo:
                acked = prev
        except Exception:
            pass
    ja = set(acked["keys"])

    # primeira resposta (após o envio) de cada paciente do lote ainda não respondido
    primeira = {}
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
        if k not in por_key or k in ja:
            continue
        if k not in primeira or parse_ts(r.get("timestamp")) < parse_ts(primeira[k].get("timestamp")):
            primeira[k] = r

    enviados = 0
    for k, r in primeira.items():
        pac = por_key[k]
        jid = pac.get("telefone", "") + "@s.whatsapp.net"
        msg = MSG_SIM if classify(r.get("text")) == "sim" else MSG_OUTRO
        send_message(jid, msg)
        ja.add(k)
        enviados += 1

    acked["alvo"] = alvo
    acked["keys"] = sorted(ja)
    ACKED.write_text(json.dumps(acked, ensure_ascii=False))

    print(json.dumps({"wakeAgent": False, "data": {"acked": enviados}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"wakeAgent": False,
                          "data": {"error": str(e), "traceback": traceback.format_exc()}}))
