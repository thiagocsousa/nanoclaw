#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Coletor de lembretes de consulta (véspera útil).

Roda às 15h (seg-sex). Regra exactly-once: se HOJE não é dia útil, sai; senão
ALVO = próximo dia útil (pula fim de semana + feriado). Busca a agenda do ALVO
no iClinic (só CONSULTAS e RETORNOS — exclui solicitações, honorários, exames),
puxa o telefone de cada paciente (SEM adivinhar o 9º dígito — o resolver de JID
do core resolve), grava o manifesto e AGENDA os envios escalonados chamando
send_reminder.py (uma task 'once' por paciente, com jitter entre elas).

Imprime {"wakeAgent": false} — o agente NÃO deve ser acordado (envio mecânico).
Flag --dry-run: imprime o alvo + lista + telefones, sem manifesto e sem agendar.
"""
import json
import os
import random
import re
import string
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza
EMAIL = os.environ.get("ICLINIC_EMAIL")       # forwarded — nunca hardcodar
SENHA = os.environ.get("ICLINIC_PASSWORD")    # forwarded — nunca hardcodar
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
MANIFEST_ULTIMO = Path(GROUP) / "lembrete_manifest_ultimo.json"

DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
        "sexta-feira", "sábado", "domingo"]

# status a excluir (cancelado/faltou/bloqueio/feriado). Ver iclinic_agenda_amanha.py
STATUS_EXCLUIR = {"ca", "fl", "na", "bl", "hd"}

# Só consulta e retorno. Exclui solicitações, honorários, exames etc. (blocklist).
PROC_EXCLUIR = ("solicita", "exame", "honorár", "honorar", "bloqueio", "atestado")

# Feriados nacionais — fixos + móveis (2026–2027). NÃO cobre feriado municipal
# de Teresina (tratado como dia útil; agenda provavelmente vazia → no-op).
FERIADOS = {
    date(2026, 1, 1), date(2026, 2, 16), date(2026, 2, 17), date(2026, 4, 3),
    date(2026, 4, 21), date(2026, 5, 1), date(2026, 6, 4), date(2026, 9, 7),
    date(2026, 10, 12), date(2026, 11, 2), date(2026, 11, 15), date(2026, 11, 20),
    date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 2, 8), date(2027, 2, 9), date(2027, 3, 26),
    date(2027, 4, 21), date(2027, 5, 1), date(2027, 5, 27), date(2027, 9, 7),
    date(2027, 10, 12), date(2027, 11, 2), date(2027, 11, 15), date(2027, 11, 20),
    date(2027, 12, 25),
}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in FERIADOS


def next_business_day(d: date) -> date:
    d += timedelta(days=1)
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def normalize_phone(raw):
    """Normaliza sem ADIVINHAR o 9º dígito: só garante prefixo 55 e tira lixo.
    O resolver de JID (onWhatsApp) no core decide 13 vs 12 dígitos / LID."""
    if not raw:
        return None
    d = re.sub(r"\D", "", raw)
    if not d:
        return None
    if not d.startswith("55"):
        d = "55" + d
    if len(d) < 12:  # 55 + DDD(2) + 8 mínimos
        return None
    return d


def match_key(phone):
    """Chave de correlação estável entre 13 e 12 dígitos: 55 + DDD + últimos 8."""
    d = re.sub(r"\D", "", phone or "")
    if len(d) < 12:
        return d
    return "55" + d[2:4] + d[-8:]


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def fetch_patient_phone(page, pid, headers):
    r = page.request.get(
        f"https://app.iclinic.com.br/pacientes/{pid}/", headers=headers
    )
    if r.status != 200:
        return None
    html = r.text()
    for field in ["mobile_phone", "home_phone"]:
        m = re.search(rf'name="{field}"[^>]+value="([^"]*)"', html)
        if m and m.group(1).strip():
            cleaned = normalize_phone(m.group(1))
            if cleaned:
                return cleaned
    return None


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_TASKS_DIR / f"{int(time.time() * 1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(fp)
    time.sleep(0.05)


def coletar_agenda(alvo_str):
    if not EMAIL or not SENHA:
        raise RuntimeError("ICLINIC_EMAIL/ICLINIC_PASSWORD não definidos no ambiente.")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
        )
        context = browser.new_context()
        page = context.new_page()
        page.goto("https://app.iclinic.com.br/", wait_until="domcontentloaded")
        page.fill('input[name="email"]', EMAIL)
        page.fill('input[name="password"]', SENHA)
        with page.expect_navigation(wait_until="domcontentloaded", timeout=20000):
            page.click('button[type="submit"]')
        page.wait_for_timeout(3000)
        csrf = next((c["value"] for c in context.cookies()
                     if c["name"] == "csrftoken"), "")
        headers = {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}
        r = page.request.get(
            f"https://app.iclinic.com.br/agenda/{PHYSICIAN_ID}/{alvo_str}/"
            f"?clinic={CLINIC_ID}&slide=1",
            headers=headers,
        )
        events = r.json().get("events", []) if r.status == 200 else []

        pacientes = []
        for ev in events:
            pac = ev.get("patient") or {}
            if ev.get("date") != alvo_str or not pac.get("name"):
                continue
            if ev.get("status") in STATUS_EXCLUIR:
                continue
            procs = ev.get("procedures") or []
            proc = (procs[0].get("procedure") or {}).get("name") if procs else "Consulta"
            if any(t in (proc or "").lower() for t in PROC_EXCLUIR):
                continue  # solicitação/honorário/exame etc.
            pid = pac.get("id")
            phone = fetch_patient_phone(page, pid, headers) if pid else None
            nome = pac.get("name")
            pacientes.append({
                "nome": nome,
                "primeiro_nome": (nome.strip().split() or ["paciente"])[0].capitalize(),
                "telefone": phone,
                "hora": (ev.get("start_time") or "")[:5],
                "procedimento": proc,
                "patient_id": pid,
                "match_key": match_key(phone) if phone else None,
            })
            time.sleep(0.3)

        browser.close()

    pacientes.sort(key=lambda x: x["hora"])
    # dedup por patient_id (mesmo paciente com mais de um agendamento no dia)
    seen, uniq = set(), []
    for p in pacientes:
        if p["patient_id"] in seen:
            continue
        seen.add(p["patient_id"])
        uniq.append(p)
    return uniq


def main():
    dry = "--dry-run" in sys.argv
    hoje = datetime.now(TZ).date()

    if not is_business_day(hoje):
        print(json.dumps({"wakeAgent": False,
                          "data": {"message": f"{hoje} não é dia útil — sem lembretes."}},
                         ensure_ascii=False))
        return

    alvo = next_business_day(hoje)
    alvo_str = alvo.strftime("%Y-%m-%d")
    alvo_disp = alvo.strftime("%d/%m/%Y")
    dia_semana = DIAS[alvo.weekday()]

    pacientes = coletar_agenda(alvo_str)
    com_tel = [p for p in pacientes if p.get("telefone")]
    sem_tel = [p for p in pacientes if not p.get("telefone")]

    if dry:
        print(f"[DRY-RUN] hoje={hoje} → ALVO={alvo_str} ({dia_semana}), "
              f"{len(pacientes)} consultas/retornos:")
        for p in pacientes:
            print(f"  {p['hora']} | {p['nome']:<38} | {p['telefone'] or 'SEM TEL'} "
                  f"| {p['procedimento']}")
        if sem_tel:
            print(f"  ⚠️ sem telefone: {', '.join(p['nome'] for p in sem_tel)}")
        return

    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "whatsapp_atendimento-dra-marina")
    gerado_em = datetime.now(TZ)

    # Agenda envios escalonados (jitter 90-240s entre cada) a partir de agora.
    base = gerado_em
    accum = timedelta(0)
    for i, p in enumerate(com_tel):
        if i > 0:
            accum += timedelta(seconds=random.randint(90, 240))
        send_at = (base + accum).strftime("%Y-%m-%dT%H:%M:%S")
        nome_safe = p["nome"].replace('"', "").replace("\\", "")
        script = (
            f'python3 /workspace/group/scripts/send_reminder.py '
            f'"{nome_safe}" "{p["telefone"]}" "{dia_semana}" "{alvo_disp}" "{p["hora"]}"'
        )
        write_ipc_task({
            "type": "schedule_task",
            "taskId": f"lembrete-{int(time.time() * 1000)}-{rand_id()}",
            "prompt": "<internal>Lembrete de consulta agendado.</internal>",
            "script": script,
            "schedule_type": "once",
            "schedule_value": send_at,
            "context_mode": "isolated",
            "targetJid": chat_jid,
            "createdBy": group_folder,
            "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        })

    manifest = {
        "alvo": alvo_str,
        "alvo_disp": alvo_disp,
        "dia_semana": dia_semana,
        "gerado_em": gerado_em.strftime("%Y-%m-%dT%H:%M:%S"),
        "gerado_em_epoch": gerado_em.timestamp(),
        "gerado_em_data": hoje.strftime("%Y-%m-%d"),
        "pacientes": com_tel,
        "sem_telefone": [p["nome"] for p in sem_tel],
    }
    Path(GROUP).mkdir(parents=True, exist_ok=True)
    (Path(GROUP) / f"lembrete_manifest_{alvo_str}.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2))
    MANIFEST_ULTIMO.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    print(json.dumps({"wakeAgent": False, "data": {
        "alvo": alvo_disp, "agendados": len(com_tel),
        "sem_telefone": len(sem_tel)}}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"wakeAgent": False,
                          "data": {"error": str(e), "traceback": traceback.format_exc()}},
                         ensure_ascii=False))
