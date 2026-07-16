#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Emite as NFS-e SELECIONADAS (aprovação do atendimento) e agenda a entrega do PDF
no WhatsApp de cada paciente.

Uso: python3 nfse_emitir_pipeline.py "1,3,5" | "todos"

Fluxo: lê pending_nfse.json → emite o subconjunto em lote (produção) → baixa o
DANFSE (PDF) → marca receita_id como emitida → avança o número do RPS → agenda
(escalonado) o envio do PDF pro paciente via send_nota.py.

Segredos via env: NFSE_CERT_B64 (certificado A1 em base64) + NFSE_CERT_PASSWORD.
"""
import base64
import json
import os
import random
import re
import string
import sys
import tempfile
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nfse_emitir as e  # noqa: E402

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
PENDING_FILE = Path(GROUP) / "pending_nfse.json"
EMITIDAS_FILE = Path(GROUP) / "nfse_emitidas.json"
RPS_STATE = Path(GROUP) / "nfse_rps_state.json"
ATTACH_DIR = Path(GROUP) / "attachments"
ENTREGAS_DIR = Path(GROUP) / "entregas"
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
TZ = timezone(timedelta(hours=-3))   # America/Fortaleza
AMBIENTE = os.environ.get("NFSE_AMBIENTE", "producao")


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def slug(nome):
    s = unicodedata.normalize("NFKD", nome or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")[:45] or "tomador"


def normalize_phone(tel):
    d = re.sub(r"\D", "", tel or "")
    if not d:
        return None
    if d.startswith("55") and len(d) >= 12:
        return d
    if len(d) in (10, 11):           # DDD + número
        return "55" + d
    return d


def cert_path():
    b64 = os.environ.get("NFSE_CERT_B64")
    if not b64:
        raise SystemExit("NFSE_CERT_B64 não definido (certificado A1 em base64).")
    fd, path = tempfile.mkstemp(suffix=".pfx")
    os.write(fd, base64.b64decode(b64))
    os.close(fd)
    return path


def parse_selecao(sel, itens):
    sel = (sel or "").strip().lower()
    if sel in ("todos", "tudo", "all", "aprovar", "aprovado"):
        return list(itens)
    idxs = set()
    for tok in re.split(r"[,\s]+", sel):
        if not tok:
            continue
        if "-" in tok:
            a, b = tok.split("-", 1)
            if a.isdigit() and b.isdigit():
                idxs.update(range(int(a), int(b) + 1))
        elif tok.isdigit():
            idxs.add(int(tok))
    return [x for x in itens if x["n"] in idxs]


def emitter_tomador(tom):
    """collector tomador {nome,doc,tipo,endereco} → emitter tomador {nome,cpf|cnpj,endereco}."""
    doc = tom.get("doc")
    pj = tom.get("tipo") == "PJ" or (doc and len(doc) == 14)
    out = {"nome": tom.get("nome"), "endereco": tom.get("endereco") or {}}
    out["cnpj" if pj else "cpf"] = doc
    return out


def load_next_rps():
    if RPS_STATE.exists():
        return int(json.loads(RPS_STATE.read_text()).get("next_rps", 1))
    return int(os.environ.get("NFSE_RPS_INICIAL", "1"))


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_TASKS_DIR / f"{int(time.time()*1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(fp)
    time.sleep(0.05)


def main():
    sel = sys.argv[1] if len(sys.argv) > 1 else "todos"
    if not PENDING_FILE.exists():
        print("Erro: pending_nfse.json não encontrado (rode a coleta primeiro).", file=sys.stderr)
        sys.exit(1)
    pending = json.loads(PENDING_FILE.read_text())
    escolhidos = parse_selecao(sel, pending["itens"])
    if not escolhidos:
        print("Seleção vazia — nada emitido. Responda com os números (ex: 1,3,5) ou 'todos'.")
        return

    pfx = cert_path()
    pwd = os.environ.get("NFSE_CERT_PASSWORD")
    next_rps = load_next_rps()
    itens = [{"servico": {"servico": x["servico"], "valor": str(x["valor"])},
              "tomador": emitter_tomador(x["tomador"]), "rps_numero": next_rps + i}
             for i, x in enumerate(escolhidos)]

    parsed, _ = e.emitir(itens, 1, AMBIENTE, pfx, pwd)
    RPS_STATE.write_text(json.dumps({"next_rps": next_rps + len(itens)}))

    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    ENTREGAS_DIR.mkdir(parents=True, exist_ok=True)
    emitidas = set(map(str, json.loads(EMITIDAS_FILE.read_text()))) if EMITIDAS_FILE.exists() else set()
    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "whatsapp_atendimento-dra-marina")

    ok, agendados, falhas = [], 0, []
    now = datetime.now(TZ)
    accum = timedelta(0)
    # mapeia cada item enviado → nota emitida PELO NÚMERO DO RPS (robusto a falha
    # parcial do lote). Fallback por ordem só se TODAS saíram (contagem bate).
    by_rps = {str(n["rps_numero"]): n for n in parsed["notas"] if n.get("rps_numero")}
    for i, x in enumerate(escolhidos):
        n = by_rps.get(str(next_rps + i))
        if n is None and len(parsed["notas"]) == len(escolhidos):
            n = parsed["notas"][i]
        if not n or not n.get("numero"):
            # falhou na prefeitura → NÃO marca emitida → reaparece amanhã
            falhas.append(x["paciente"])
            continue
        emitidas.add(str(x["receita_id"]))
        pdf_name = f"nota_{n['numero']}_{slug(x['tomador'].get('nome'))}.pdf"
        pdf_path = ATTACH_DIR / pdf_name
        try:
            e.baixar_danfse(n["numero"], n["codigo_verificacao"], AMBIENTE, destino=str(pdf_path))
        except Exception as ex:
            print(f"  aviso: PDF da nota {n['numero']} falhou: {ex}", file=sys.stderr)
            pdf_path = None
        tel = normalize_phone(x["tomador"].get("telefone"))
        if tel and pdf_path:
            # grava a entrega e agenda o envio escalonado (60-180s entre cada)
            eid = f"{n['numero']}-{rand_id()}"
            (ENTREGAS_DIR / f"{eid}.json").write_text(json.dumps({
                "telefone": tel, "paciente": x["paciente"],
                "pdf": f"/workspace/group/attachments/{pdf_name}",
                "chat_jid_paciente": f"{tel}@s.whatsapp.net",
                "group_folder": group_folder,
            }, ensure_ascii=False))
            accum += timedelta(seconds=random.randint(60, 180)) if agendados else timedelta(0)
            send_at = (now + accum).strftime("%Y-%m-%dT%H:%M:%S")
            write_ipc_task({
                "type": "schedule_task",
                "taskId": f"nfse-entrega-{int(time.time()*1000)}-{rand_id()}",
                "prompt": "<internal>Entrega de NFS-e agendada.</internal>",
                "script": f"python3 /workspace/group/scripts/send_nota.py {eid}",
                "schedule_type": "once",
                "schedule_value": send_at,
                "context_mode": "isolated",
                "targetJid": chat_jid,
                "createdBy": group_folder,
                "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            })
            agendados += 1
        ok.append((x["paciente"], x["servico"], n["numero"], bool(tel)))

    EMITIDAS_FILE.write_text(json.dumps(sorted(emitidas), ensure_ascii=False))

    lines = [f"✅ *{len(ok)}* nota(s) emitida(s) — protocolo {parsed.get('protocolo')}:"]
    for pac, serv, num, temtel in ok:
        entrega = "→ envio agendado" if temtel else "⚠️ sem telefone (não enviada)"
        lines.append(f"• NFSe *{num}* — {pac} ({serv}) {entrega}")
    if falhas:
        lines.append(f"\n❌ Falharam: {', '.join(falhas)}")
    if parsed.get("mensagens"):
        lines.append(f"\nMensagens do servidor: {parsed['mensagens']}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
