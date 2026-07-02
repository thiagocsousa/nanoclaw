#!/usr/bin/env python3
"""
Busca consultas atendidas hoje no iClinic.
Saída (última linha stdout): JSON { wakeAgent, data: { consultas, data } }
Salva pending_avaliacao.json para a fase de seleção.
"""

import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

TZ_OFFSET = timezone(timedelta(hours=-3))  # America/Fortaleza

EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

PENDING_FILE = Path("/workspace/group/pending_avaliacao.json")
SEEN_FILE = Path("/workspace/group/avaliacao_seen.json")


def clean_phone(raw: str) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) >= 10 and not digits.startswith("55"):
        digits = "55" + digits
    if len(digits) < 12:
        return None
    # 9 dígitos locais: remove o primeiro 9 após DDI+DDD
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
    # Server-rendered form: <input name="mobile_phone" ... value="(86) 99999-9999">
    for field in ["mobile_phone", "home_phone"]:
        m = re.search(rf'name="{field}"[^>]+value="([^"]*)"', html)
        if m and m.group(1).strip():
            cleaned = clean_phone(m.group(1))
            if cleaned:
                return cleaned
    return None


def run():
    now_local = datetime.now(TZ_OFFSET)
    today = now_local.date().strftime("%Y-%m-%d")
    today_display = now_local.date().strftime("%d/%m/%Y")
    # Sem janela fixa: cada run apresenta as consultas atendidas (cp) de hoje que
    # ainda não foram apresentadas. Corrige o timing — a recepção marca "cp" aos
    # poucos, então quem era marcado depois do run da janela antiga ficava órfão.
    # Os patient_ids já apresentados hoje ficam em SEEN_FILE (resetado a cada dia).
    janela_display = f"até {now_local.strftime('%Hh%M')}"

    seen_data = {}
    if SEEN_FILE.exists():
        try:
            seen_data = json.loads(SEEN_FILE.read_text())
        except Exception:
            seen_data = {}
    if seen_data.get("date") != today:
        seen_data = {"date": today, "patient_ids": []}
    seen_ids = set(seen_data["patient_ids"])

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
            f"https://app.iclinic.com.br/agenda/{PHYSICIAN_ID}/{today}/?clinic={CLINIC_ID}&slide=1",
            headers=headers,
        )
        if r.status != 200:
            print(
                json.dumps(
                    {"wakeAgent": False, "data": {"error": f"Agenda HTTP {r.status}"}}
                )
            )
            browser.close()
            return

        events = r.json().get("events", [])

        if "--debug" in sys.argv:
            print(f"[DEBUG] {len(events)} eventos hoje ({today}), janela seria {janela_display}:")
            for e in sorted(events, key=lambda x: x.get("start_time", "")):
                if not e.get("patient"):
                    continue
                procs = e.get("procedures") or []
                proc_name = procs[0]["procedure"]["name"] if procs else ""
                print(
                    f"  {e.get('start_time','?')} | status={e.get('status')!r} | "
                    f"date={e.get('date')} | {e['patient'].get('name')} | {proc_name}"
                )
            browser.close()
            return

        attended = [
            e for e in events
            if e.get("status") == "cp"
            and e.get("patient")
            and e.get("date") == today
        ]

        if not attended:
            print(
                json.dumps(
                    {"wakeAgent": False,
                     "data": {"message": "Nenhuma consulta atendida hoje ainda."}}
                )
            )
            browser.close()
            return

        consultas = []
        for ev in attended:
            patient = ev["patient"]
            pid = patient["id"]
            if pid in seen_ids:
                continue  # já apresentado hoje num run anterior
            procedures = ev.get("procedures", [])
            proc_name = (
                procedures[0]["procedure"]["name"] if procedures else "Consulta"
            )
            pl = proc_name.lower()
            if "solicita" in pl or "exame" in pl:
                continue  # exclui solicitações e exames — só consultas
            phone = fetch_patient_phone(page, pid, headers)
            consultas.append(
                {
                    "nome": patient["name"],
                    "patient_id": pid,
                    "telefone": phone,
                    "procedimento": proc_name,
                }
            )
            time.sleep(0.3)

    # Deduplica por patient_id (paciente com mais de um procedimento no dia)
    seen = set()
    unique = []
    for c in consultas:
        if c["patient_id"] not in seen:
            seen.add(c["patient_id"])
            unique.append(c)
    consultas = unique

    if not consultas:
        print(
            json.dumps(
                {"wakeAgent": False,
                 "data": {"message": "Nenhuma consulta nova atendida para avaliação."}},
                ensure_ascii=False,
            )
        )
        return

    # Marca os apresentados agora como "vistos" hoje — não reaparecem no próximo run.
    seen_data["patient_ids"] = list(seen_ids | {c["patient_id"] for c in consultas})
    SEEN_FILE.write_text(json.dumps(seen_data, ensure_ascii=False, indent=2))

    pending = {
        "data": today_display,
        "timestamp": time.time(),
        "hour_captured": now_local.hour,        # hora da apresentação; gate em send_avaliacoes_batch
        "janela": janela_display,               # rótulo de hora, ex: "até 16h30"
        "expires_at": time.time() + 150 * 60,   # backup TTL — o gate primário é hour_captured
        "consultas": consultas,
    }
    PENDING_FILE.write_text(json.dumps(pending, ensure_ascii=False, indent=2))

    print(
        json.dumps(
            {"wakeAgent": True,
             "data": {"consultas": consultas, "data": today_display, "janela": janela_display}},
            ensure_ascii=False,
        )
    )


try:
    run()
except Exception as e:
    import traceback
    print(
        json.dumps(
            {"wakeAgent": False, "data": {"error": str(e), "traceback": traceback.format_exc()}}
        )
    )
