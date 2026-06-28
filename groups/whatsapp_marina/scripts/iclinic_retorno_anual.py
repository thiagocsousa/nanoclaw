#!/usr/bin/env python3
"""
Busca pacientes particulares atendidos há ~1 ano que não retornaram e escreve
pending_retorno.json para a fase de seleção (Marina aprova quais enviar).
Saída (stdout): JSON { wakeAgent, data: { message, date_captured } }.
"""

import json
import os
import re
import time
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

PENDING_FILE = Path("/workspace/group/pending_retorno.json")


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
    """Returns (has_returned, anniversary_particular) from patient event history.

    - has_returned: existe qualquer atendimento (cp) DEPOIS da data-aniversário.
      O RETORNO no iClinic é só "RETORNO", sem tipo (particular/convênio), então
      qualquer volta à clínica conta como retorno.
    - anniversary_particular: a consulta da própria data-aniversário (since_date_str)
      foi particular. O filtro de "particular" se aplica só a esse atendimento, não
      ao histórico inteiro.
    """
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
    anniversary_particular = any(
        e.get("status") == "cp"
        and e.get("date", "") == since_date_str
        and "particular" in (e.get("insurance_name") or "").lower()
        for e in events
    )
    return returned, anniversary_particular


def run():
    today = date.today()
    target_date = today - timedelta(days=366)
    target_str = target_date.strftime("%Y-%m-%d")

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

            returned, anniversary_particular = check_patient_history(page, pid, headers, target_str)
            if returned or not anniversary_particular:
                continue

            phone = fetch_patient_phone(page, pid, headers)
            if not phone:
                continue

            procedures = ev.get("procedures", [])
            proc_name = procedures[0]["procedure"]["name"] if procedures else "Consulta"
            if "solicita" in proc_name.lower():
                continue

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

    today_display = today.strftime("%d/%m/%Y")
    pending = {
        "date_captured": today.strftime("%Y-%m-%d"),
        "data": today_display,
        "timestamp": time.time(),
        "candidatos": candidatos,
    }
    PENDING_FILE.write_text(json.dumps(pending, ensure_ascii=False, indent=2))

    lines = [f"*Pacientes para retorno anual ({today_display}):*"]
    for i, c in enumerate(candidatos, start=1):
        lines.append(f"{i}. {c['nome']} — {c['procedimento']}")
    lines.append("")
    lines.append(
        "Quais devem receber a mensagem de retorno? "
        "Responda com os números (ex: *1, 3*), *todos* ou *nenhum*."
    )

    print(json.dumps(
        {"wakeAgent": True, "data": {
            "message": "\n".join(lines),
            "date_captured": pending["date_captured"],
            "total": len(candidatos),
        }},
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
