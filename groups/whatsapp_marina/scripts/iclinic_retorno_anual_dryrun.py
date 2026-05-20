#!/usr/bin/env python3
"""Dry-run: lista pacientes elegíveis para retorno anual SEM agendar envios."""

import json
import re
import time
from datetime import date, timedelta
from playwright.sync_api import sync_playwright

EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"


def clean_phone(raw):
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


def fetch_patient_phone(page, pid, headers):
    r = page.request.get(f"https://app.iclinic.com.br/pacientes/{pid}/", headers=headers)
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


def check_patient_history(page, pid, headers, since_date_str):
    r = page.request.get(
        f"https://app.iclinic.com.br/pacientes/{pid}/events/?offset=0",
        headers=headers,
    )
    if r.status != 200:
        return False, False
    events = r.json().get("events", [])
    returned = any(
        e.get("status") == "cp" and e.get("date", "") > since_date_str for e in events
    )
    has_particular = any(
        "particular" in (e.get("insurance_name") or "").lower() for e in events
    )
    return returned, has_particular


def run():
    today = date.today()
    target_date = today - timedelta(days=366)
    target_str = target_date.strftime("%Y-%m-%d")
    print(f"[dry-run] Buscando atendimentos de {target_str} (366 dias atrás)…", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
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
            print(f"[dry-run] Agenda HTTP {r.status}")
            browser.close()
            return

        events = r.json().get("events", [])
        attended_year_ago = [
            e for e in events
            if e.get("status") == "cp"
            and e.get("patient")
            and e.get("date") == target_str
        ]

        print(f"[dry-run] Atendimentos 'cp' em {target_str}: {len(attended_year_ago)}", flush=True)

        if not attended_year_ago:
            browser.close()
            return

        seen_pids = set()
        unique_events = []
        for e in attended_year_ago:
            pid = e["patient"]["id"]
            if pid not in seen_pids:
                seen_pids.add(pid)
                unique_events.append(e)

        print(f"[dry-run] Pacientes únicos: {len(unique_events)}", flush=True)
        print(f"[dry-run] Analisando histórico de cada um…\n", flush=True)

        candidatos = []
        descartados = []
        for ev in unique_events:
            patient = ev["patient"]
            pid = patient["id"]
            nome = patient["name"]

            returned, has_particular = check_patient_history(page, pid, headers, target_str)

            if returned:
                descartados.append((nome, pid, "já retornou"))
                continue
            if not has_particular:
                descartados.append((nome, pid, "sem consulta particular no histórico"))
                continue

            phone = fetch_patient_phone(page, pid, headers)
            if not phone:
                descartados.append((nome, pid, "sem telefone"))
                continue

            procedures = ev.get("procedures", [])
            proc_name = procedures[0]["procedure"]["name"] if procedures else "Consulta"

            candidatos.append({
                "nome": nome,
                "patient_id": pid,
                "telefone": phone,
                "procedimento": proc_name,
            })
            time.sleep(0.3)

        browser.close()

    print("=" * 60)
    print(f"✅ ELEGÍVEIS PARA RETORNO ({len(candidatos)}):")
    print("=" * 60)
    for c in candidatos:
        print(f"  • {c['nome']:<40} {c['telefone']}  [{c['procedimento']}]")

    if descartados:
        print()
        print("=" * 60)
        print(f"✗ DESCARTADOS ({len(descartados)}):")
        print("=" * 60)
        for nome, pid, motivo in descartados:
            print(f"  • {nome:<40} ({motivo})")


try:
    run()
except Exception as e:
    import traceback
    print(f"ERRO: {e}")
    print(traceback.format_exc())
