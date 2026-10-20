#!/usr/bin/env python3
"""Dry-run: lista pacientes elegíveis para retorno anual SEM agendar envios.

Uso:
  python3 iclinic_retorno_anual_dryrun.py             # checa só hoje (target = hoje - 366)
  python3 iclinic_retorno_anual_dryrun.py --days 7    # simula as últimas 7 execuções do cron
"""

import argparse
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
    anniversary_particular = any(
        e.get("status") == "cp"
        and e.get("date", "") == since_date_str
        and "particular" in (e.get("insurance_name") or "").lower()
        for e in events
    )
    return returned, anniversary_particular


def check_target_date(page, headers, target_str, cron_day):
    """Verifica um target_str (data 366 dias antes do cron-day) e imprime o resultado."""
    print()
    print("=" * 64)
    print(f"Cron simulado de {cron_day} → alvo iClinic {target_str}")
    print("=" * 64)

    r = page.request.get(
        f"https://app.iclinic.com.br/agenda/{PHYSICIAN_ID}/{target_str}/"
        f"?clinic={CLINIC_ID}&slide=1",
        headers=headers,
    )
    if r.status != 200:
        print(f"  [erro] Agenda HTTP {r.status}")
        return

    events = r.json().get("events", [])
    attended = [
        e for e in events
        if e.get("status") == "cp" and e.get("patient") and e.get("date") == target_str
    ]
    print(f"  Atendimentos 'cp': {len(attended)}")

    if not attended:
        return

    seen_pids = set()
    unique_events = []
    for e in attended:
        pid = e["patient"]["id"]
        if pid not in seen_pids:
            seen_pids.add(pid)
            unique_events.append(e)
    print(f"  Pacientes únicos: {len(unique_events)}")

    candidatos = []
    descartados = []
    for ev in unique_events:
        patient = ev["patient"]
        pid = patient["id"]
        nome = patient["name"]

        returned, anniversary_particular = check_patient_history(page, pid, headers, target_str)
        if returned:
            descartados.append((nome, pid, "já retornou"))
            continue
        if not anniversary_particular:
            descartados.append((nome, pid, "consulta de 1 ano atrás não foi particular"))
            continue
        phone = fetch_patient_phone(page, pid, headers)
        if not phone:
            descartados.append((nome, pid, "sem telefone"))
            continue
        procedures = ev.get("procedures", [])
        proc_name = procedures[0]["procedure"]["name"] if procedures else "Consulta"
        candidatos.append({"nome": nome, "telefone": phone, "procedimento": proc_name})
        time.sleep(0.3)

    print(f"  ✅ Elegíveis: {len(candidatos)}")
    for c in candidatos:
        print(f"     • {c['nome']:<38} {c['telefone']}  [{c['procedimento']}]")
    if descartados:
        print(f"  ✗ Descartados: {len(descartados)}")
        for nome, _pid, motivo in descartados:
            print(f"     • {nome:<38} ({motivo})")


def run(days):
    today = date.today()
    print(f"[dry-run] Simulando {days} execução(ões) do cron retorno anual…", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            # ⚠️ Sem isto o chromium usa /dev/shm para a memória compartilhada
            # entre seus processos, e o Docker dá 64 MB por padrão — com 64 MB ele
            # não falha com erro, PENDURA. Este script não passa pelos spawns do
            # host que levam `--shm-size`, então o conserto viaja com o script.
            args=["--disable-dev-shm-usage"],
        )
        context = browser.new_context()
        page = context.new_page()

        page.goto("https://app.iclinic.com.br/", wait_until="domcontentloaded")
        # ⚠️ Esperar o campo HABILITAR antes de digitar.
        #
        # O `fill` do Playwright já espera por "enabled", mas com orçamento FIXO
        # de 30 s — e 30 s não bastam. Medido na VM em 19/10/2026: o campo leva
        # ~2,5 s numa máquina folgada e passa de 30 s sob carga, porque a tela de
        # login soma um tracker cujo DNS não resolve (event.getblue.io,
        # ERR_NAME_NOT_RESOLVED) e uma geolocalização que vai até o timeout no
        # headless. Quando estoura, o erro é '<input disabled ... "Email de
        # acesso">' com "element is not enabled", que se lê como "o iClinic
        # bloqueou a conta" — e não é: é corrida perdida. A medição completa está
        # em groups/whatsapp_atendimento-teste/scripts/iclinic_vagas.py.
        page.wait_for_selector(
            'input[name="email"]:not([disabled])', timeout=45000)
        page.fill('input[name="email"]', EMAIL)
        page.fill('input[name="password"]', SENHA)
        with page.expect_navigation(wait_until="domcontentloaded", timeout=20000):
            page.click('button[type="submit"]')
        page.wait_for_timeout(3000)

        csrf = next(
            (c["value"] for c in context.cookies() if c["name"] == "csrftoken"), ""
        )
        headers = {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}

        # do mais antigo pro mais recente
        for i in reversed(range(days)):
            cron_day = today - timedelta(days=i)
            target = cron_day - timedelta(days=366)
            check_target_date(
                page, headers,
                target.strftime("%Y-%m-%d"),
                cron_day.strftime("%Y-%m-%d (%a)"),
            )

        browser.close()


parser = argparse.ArgumentParser()
parser.add_argument("--days", type=int, default=1, help="Quantos dias retroceder (default 1)")
args = parser.parse_args()

try:
    run(args.days)
except Exception as e:
    import traceback
    print(f"ERRO: {e}")
    print(traceback.format_exc())
