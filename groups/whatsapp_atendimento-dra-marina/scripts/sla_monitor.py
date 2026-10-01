#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Monitor de tempo de resposta do atendimento (SLA).

Lê a linha do tempo das conversas 1:1 do número do atendimento
(atendimento_sla.jsonl, alimentada passivamente pelo core) e avisa o Thiago
quando um paciente está há mais de N minutos sem resposta humana.

Regras:
  • o relógio começa na PRIMEIRA mensagem não respondida do paciente
    (paciente falador não zera o cronômetro);
  • só mensagem enviada por HUMANO do número do atendimento para o relógio.
    Envio do bot (lembrete, auto-resposta, PDF de nota) está em
    atendimento_bot_sent.jsonl e é NEUTRO — não conta como atendimento;
  • exceção: paciente que só respondeu ao lembrete de consulta e já recebeu a
    auto-resposta (lembrete_acked.json) sai do radar — o resumo das 17h já cobre;
  • um único digest por execução, nunca um ping por conversa;
  • dedup em sla_alertado.json: cada pendência é avisada uma vez (e re-arma
    quando a conversa é respondida).

Horário de funcionamento é responsabilidade do CRON (a VM roda em UTC; o
script só faz aritmética de tempo em timestamps ISO-Z, que é TZ-safe).

Uso:
  sla_monitor.py                 # roda e avisa (cron)
  sla_monitor.py --dry-run       # não envia nada, não grava estado
  sla_monitor.py --report        # relatório de todas as conversas (inspeção)
  sla_monitor.py --minutos 10    # muda o limite (default 5)
"""
import json
import os
import random
import re
import string
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

GROUP = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
TIMELINE = GROUP / "atendimento_sla.jsonl"
BOT_SENT = GROUP / "atendimento_bot_sent.jsonl"
ACKED = GROUP / "lembrete_acked.json"
STATE = GROUP / "sla_alertado.json"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

# ATENÇÃO: este script roda DENTRO do container (usuário `node`, uid 1000) e os
# jsonl são escritos pelo processo do HOST (usuário nanoclaw-deploy). Reescrever
# esses arquivos aqui trocaria o dono e o host perderia o append — a captura
# morreria calada. Por isso a rotação dos jsonl é feita no host (whatsapp.ts);
# aqui só se LÊ. O único arquivo que este script escreve é o sla_alertado.json.

ALERT_JID = os.environ.get("SLA_ALERT_JID", "558681512111@s.whatsapp.net")
ALERT_FOLDER = os.environ.get("SLA_ALERT_FOLDER", "whatsapp_main")

LIMITE_MIN_DEFAULT = 5
# Válvula de segurança: se o número de pendências estourar isso, é mais provável
# que a CAPTURA esteja cega (ex.: as respostas da atendente deixaram de chegar
# como eco fromMe) do que a clínica ter abandonado 9 pacientes. Nesse caso manda
# UM aviso e cala a boca pelo cooldown, em vez de despejar uma lista enorme.
MAX_PENDENTES_PLAUSIVEL = 8
SOBRECARGA_COOLDOWN_H = 6
# Mensagem antiga demais não interessa (não alertar sobre backlog de ontem).
JANELA_HORAS = 12
TRUNC = 90


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def match_key(phone):
    """55+DDD+8 últimos dígitos — tolera presença/ausência do 9º dígito."""
    d = re.sub(r"\D", "", phone or "")
    if d.startswith("55"):
        d = d[2:]
    return d[:2] + d[-8:] if len(d) >= 10 else d


def parse_ts(s):
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def read_jsonl(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def acked_keys():
    """Pacientes que já receberam auto-resposta do lembrete no lote atual."""
    data = load_json(ACKED, {})
    keys = set()
    if isinstance(data, dict):
        for k, v in data.items():
            keys.add(match_key(k))
            if isinstance(v, dict) and v.get("phone"):
                keys.add(match_key(v["phone"]))
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                keys.add(match_key(item))
            elif isinstance(item, dict):
                keys.add(match_key(item.get("phone") or item.get("jid") or ""))
    return {k for k in keys if k}


def pendencias(limite_min, agora):
    bot_ids = {e.get("id") for e in read_jsonl(BOT_SENT) if e.get("id")}
    corte = agora - timedelta(hours=JANELA_HORAS)

    # Agrupa por match_key (55+DDD+8 últimos), não pelo telefone cru: o mesmo
    # paciente pode aparecer com e sem o 9º dígito (ou via LID) entre o inbound
    # e o outbound — ver resolveWaJid no core. Chavear pelo cru faria a resposta
    # da atendente cair em outro bucket e a pendência nunca fecharia.
    chats = {}
    for e in read_jsonl(TIMELINE):
        ts = parse_ts(e.get("timestamp"))
        if not ts:
            continue
        key = match_key(e.get("phone") or "")
        if not key:
            continue
        chats.setdefault(key, []).append((ts, e))

    acked = acked_keys()
    resultado = []
    for key, eventos in chats.items():
        eventos.sort(key=lambda x: x[0])
        # Última resposta HUMANA do número do atendimento nessa conversa.
        ultima_humana = None
        for ts, e in eventos:
            if e.get("direction") == "out" and e.get("id") not in bot_ids:
                ultima_humana = ts
        # Primeira mensagem do paciente ainda não respondida por humano.
        pendente = None
        for ts, e in eventos:
            if e.get("direction") != "in":
                continue
            if ultima_humana and ts <= ultima_humana:
                continue
            pendente = (ts, e)
            break
        if not pendente:
            continue
        ts, e = pendente
        if ts < corte:
            continue
        espera = int((agora - ts).total_seconds() // 60)
        phone = e.get("phone") or key
        nome = e.get("push_name") or phone
        resultado.append({
            "key": key,
            "phone": phone,
            "nome": nome,
            "msg_id": e.get("id") or "",
            "texto": e.get("text") or "",
            "desde": ts.isoformat(),
            "espera_min": espera,
            "acked_lembrete": key in acked,
            "estourou": espera >= limite_min,
        })
    resultado.sort(key=lambda r: -r["espera_min"])
    return resultado


def enviar(texto):
    IPC_MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_MESSAGES_DIR / f"{int(time.time() * 1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps({
        "type": "message",
        "chatJid": ALERT_JID,
        "text": texto,
        "groupFolder": ALERT_FOLDER,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.rename(fp)


def main():
    argv = sys.argv[1:]
    dry = "--dry-run" in argv
    report = "--report" in argv
    limite = LIMITE_MIN_DEFAULT
    if "--minutos" in argv:
        try:
            limite = int(argv[argv.index("--minutos") + 1])
        except (IndexError, ValueError):
            pass

    agora = datetime.now(timezone.utc)
    todas = pendencias(limite, agora)

    if report:
        print(json.dumps({
            "agora_utc": agora.isoformat(),
            "limite_min": limite,
            "timeline_eventos": len(read_jsonl(TIMELINE)),
            "bot_sent_ids": len(read_jsonl(BOT_SENT)),
            "pendentes": todas,
        }, ensure_ascii=False, indent=2))
        print(json.dumps({"wakeAgent": False}))
        return

    # Só alerta quem estourou o limite e não está coberto pelo lembrete.
    alvo = [p for p in todas if p["estourou"] and not p["acked_lembrete"]]

    estado = load_json(STATE, {})
    if not isinstance(estado, dict):
        estado = {}
    pendentes_agora = {p["key"] for p in todas}
    # Re-arma quem já foi respondido (saiu da lista de pendências).
    sobrecarga_em = parse_ts(estado.get("_sobrecarga_em"))
    estado = {k: v for k, v in estado.items() if k in pendentes_agora}
    if sobrecarga_em:
        estado["_sobrecarga_em"] = sobrecarga_em.isoformat()

    # Válvula: muita gente pendente de uma vez = suspeita de captura cega.
    if len(alvo) > MAX_PENDENTES_PLAUSIVEL:
        recente = sobrecarga_em and (
            agora - sobrecarga_em < timedelta(hours=SOBRECARGA_COOLDOWN_H)
        )
        if not recente:
            aviso = (
                f"⚠️ *Monitor de atendimento suspeito*\n\n"
                f"{len(alvo)} pacientes aparecem sem resposta há mais de "
                f"{limite} min — número alto demais pra ser real.\n\n"
                "Provável causa: a captura parou de ver as respostas da "
                "atendente (eco do número linkado). Não vou listar nem alertar "
                f"por paciente nas próximas {SOBRECARGA_COOLDOWN_H}h.\n\n"
                "Pra checar: `sla_monitor.py --report`"
            )
            if dry:
                print("[dry-run] enviaria AVISO DE SOBRECARGA:\n" + aviso)
            else:
                enviar(aviso)
                estado["_sobrecarga_em"] = agora.isoformat()
                STATE.write_text(
                    json.dumps(estado, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
        # Não alerta por paciente: quando a captura voltar, os alertas reais
        # voltam sozinhos (nada foi marcado como já avisado).
        print(json.dumps({"wakeAgent": False, "sobrecarga": len(alvo),
                          "pendentes": len(todas)}, ensure_ascii=False))
        return

    novos = [p for p in alvo if estado.get(p["key"]) != p["msg_id"]]

    if novos:
        linhas = []
        for p in novos:
            txt = p["texto"]
            if len(txt) > TRUNC:
                txt = txt[:TRUNC].rstrip() + "…"
            linhas.append(f'• *{p["nome"]}* ({p["phone"]}) — há {p["espera_min"]} min\n  _"{txt}"_')
        plural = "pacientes" if len(novos) > 1 else "paciente"
        texto = (
            f"⏱️ *Atendimento sem resposta* ({len(novos)} {plural} > {limite} min)\n\n"
            + "\n".join(linhas)
        )
        if dry:
            print("[dry-run] enviaria:\n" + texto)
        else:
            enviar(texto)
            for p in novos:
                estado[p["key"]] = p["msg_id"]

    if not dry:
        STATE.write_text(json.dumps(estado, ensure_ascii=False, indent=2),
                         encoding="utf-8")

    # wakeAgent:false — o alerta é mecânico, o agente não entra no fluxo.
    print(json.dumps({"wakeAgent": False, "alertados": len(novos),
                      "pendentes": len(todas)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
