#!/usr/bin/env python3
"""
Busca pacientes particulares atendidos há ~1 ano que não retornaram e agenda
o envio da mensagem de retorno diretamente, sem aprovação da Marina.
Saída (stdout): resumo dos envios agendados.
"""

import json
import os
import random
import re
import string
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
TZ_OFFSET = timezone(timedelta(hours=-3))  # America/Fortaleza

# Feriados nacionais brasileiros — fixos + móveis (2026–2027)
FERIADOS = {
    # 2026 — Easter: Apr 5
    date(2026, 1, 1),
    date(2026, 2, 16),  # Carnaval Segunda
    date(2026, 2, 17),  # Carnaval Terça
    date(2026, 4, 3),   # Sexta-Feira Santa
    date(2026, 4, 21),  # Tiradentes
    date(2026, 5, 1),   # Dia do Trabalho
    date(2026, 6, 4),   # Corpus Christi
    date(2026, 9, 7),   # Independência
    date(2026, 10, 12), # Nossa Sra. Aparecida
    date(2026, 11, 2),  # Finados
    date(2026, 11, 15), # Proclamação da República
    date(2026, 11, 20), # Consciência Negra
    date(2026, 12, 25), # Natal
    # 2027 — Easter: Mar 28
    date(2027, 1, 1),
    date(2027, 2, 8),
    date(2027, 2, 9),
    date(2027, 3, 26),
    date(2027, 4, 21),
    date(2027, 5, 1),
    date(2027, 5, 27),  # Corpus Christi
    date(2027, 9, 7),
    date(2027, 10, 12),
    date(2027, 11, 2),
    date(2027, 11, 15),
    date(2027, 11, 20),
    date(2027, 12, 25),
}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in FERIADOS


def get_base_send_time(now_local: datetime) -> datetime:
    """Now if today is a business day; else 13:00 of next business day."""
    d = now_local.date()
    if is_business_day(d):
        return now_local
    d += timedelta(days=1)
    while not is_business_day(d):
        d += timedelta(days=1)
    return datetime(d.year, d.month, d.day, 13, 0, 0, tzinfo=now_local.tzinfo)


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time() * 1000)}-{rand_id()}.json"
    filepath = IPC_TASKS_DIR / filename
    tmp = Path(str(filepath) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(filepath)
    time.sleep(0.05)


def clean_phone(raw: str) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) >= 10 and not digits.startswith("55"):
        digits = "55" + digits
    if len(digits) < 12:
        return None
    if len(digits) == 13 and digits[4] == "9":
        digits = digits[:4] + digits[5:]
    return digits


def fetch_patient_phone(page, pid: int, headers: dict) -> str | None:
    r = page.request.get(
        f"https://app.iclinic.com.br/pacientes/{pid}/",
        headers=headers,
    )
    if r.status != 200:
        return None
    html = r.text()
    for field in ["mobile_phone", "home_phone"]:
        m = re.search(rf'name="{field}"[^>]+value="([^"]*)"', html)
        if m and m.group(1).strip():
            cleaned = clean_phone(m.group(1))
            if cleaned:
                return cleaned
    return None


def check_patient_history(page, pid: int, headers: dict, since_date_str: str):
    """Returns (has_returned, has_particular) from patient event history."""
    r = page.request.get(
        f"https://app.iclinic.com.br/pacientes/{pid}/events/?offset=0",
        headers=headers,
    )
    if r.status != 200:
        return False, False
    events = r.json().get("events", [])
    returned = any(
        e.get("status") == "cp" and e.get("date", "") > since_date_str
        for e in events
    )
    has_particular = any(
        "particular" in (e.get("insurance_name") or "").lower()
        for e in events
    )
    return returned, has_particular


def run():
    today = date.today()
    target_date = today - timedelta(days=366)
    target_str = target_date.strftime("%Y-%m-%d")
    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")

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

        csrf = next(
            (c["value"] for c in context.cookies() if c["name"] == "csrftoken"), ""
        )
        headers = {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}

        r = page.request.get(
            f"https://app.iclinic.com.br/agenda/{PHYSICIAN_ID}/{target_str}/"
            f"?clinic={CLINIC_ID}&slide=1",
            headers=headers,
        )
        if r.status != 200:
            print(json.dumps({"wakeAgent": False, "data": {"error": f"Agenda HTTP {r.status}"}}))
            browser.close()
            return

        events = r.json().get("events", [])
        attended_year_ago = [
            e for e in events
            if e.get("status") == "cp"
            and e.get("patient")
            and e.get("date") == target_str
        ]

        if not attended_year_ago:
            print(json.dumps({
                "wakeAgent": False,
                "data": {"message": f"Nenhuma consulta atendida em {target_str}"},
            }))
            browser.close()
            return

        # Deduplicate by patient_id
        seen_pids: set = set()
        unique_events = []
        for e in attended_year_ago:
            pid = e["patient"]["id"]
            if pid not in seen_pids:
                seen_pids.add(pid)
                unique_events.append(e)

        candidatos = []
        for ev in unique_events:
            patient = ev["patient"]
            pid = patient["id"]

            returned, has_particular = check_patient_history(page, pid, headers, target_str)
            if returned or not has_particular:
                continue

            phone = fetch_patient_phone(page, pid, headers)
            if not phone:
                continue

            procedures = ev.get("procedures", [])
            proc_name = procedures[0]["procedure"]["name"] if procedures else "Consulta"

            candidatos.append({
                "nome": patient["name"],
                "patient_id": pid,
                "telefone": phone,
                "procedimento": proc_name,
            })
            time.sleep(0.3)

        browser.close()

    if not candidatos:
        print(json.dumps({
            "wakeAgent": False,
            "data": {"message": "Nenhum paciente elegível para retorno"},
        }))
        return

    now_local = datetime.now(TZ_OFFSET)
    base_time = get_base_send_time(now_local)
    accumulated = timedelta(0)
    agendados = []

    for i, paciente in enumerate(candidatos):
        if i > 0:
            accumulated += timedelta(seconds=random.randint(60, 180))

        send_at = base_time + accumulated
        send_at_str = send_at.strftime("%Y-%m-%dT%H:%M:%S")

        script = (
            f'python3 /workspace/group/scripts/send_retorno.py '
            f'"{paciente["nome"]}" "{paciente["telefone"]}"'
        )

        write_ipc_task({
            "type": "schedule_task",
            "taskId": f"retorno-{int(time.time() * 1000)}-{rand_id()}",
            "prompt": "<internal>Retorno anual agendado enviado.</internal>",
            "script": script,
            "schedule_type": "once",
            "schedule_value": send_at_str,
            "context_mode": "isolated",
            "targetJid": chat_jid,
            "createdBy": "whatsapp_marina",
            "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        })

        agendados.append((paciente["nome"], send_at.strftime("%d/%m %H:%M")))

    lines = [f"✅ *{len(agendados)}* mensagem(ns) de retorno agendada(s) — {today.strftime('%d/%m/%Y')}:"]
    for nome, quando in agendados:
        lines.append(f"• {nome} — {quando}")

    print(json.dumps(
        {"wakeAgent": True, "data": {"message": "\n".join(lines)}},
        ensure_ascii=False,
    ))


try:
    run()
except Exception as e:
    import traceback
    print(
        json.dumps(
            {"wakeAgent": False, "data": {"error": str(e), "traceback": traceback.format_exc()}}
        )
    )
