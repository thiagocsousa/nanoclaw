#!/usr/bin/env python3
"""
Agenda do PRÓXIMO DIA (informativo). Roda 20h de domingo a quinta e envia pra
Dra. Marina — só pra ela saber o que vem amanhã. Nenhuma ação, nenhuma aprovação.
Saída (última linha stdout): JSON { wakeAgent, data: { data, dia_semana, total, agendamentos } }
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza
EMAIL = "thiagocsousa@gmail.com"
SENHA = "Thiagofei1998#"
CLINIC_ID = "263255"
PHYSICIAN_ID = "284806"

DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
        "sexta-feira", "sábado", "domingo"]
# NÃO mostrar cancelado / faltou / bloqueio. Códigos observados no iClinic:
# na = não compareceu (faltou), hd = feriado/bloqueio. ca/fl/bl incluídos por
# segurança (cancelado/faltou/bloqueio). Os demais (sc/re/ow/cw/at/cp) são válidos.
STATUS_EXCLUIR = {"ca", "fl", "na", "bl", "hd"}


def run():
    amanha = datetime.now(TZ).date() + timedelta(days=1)
    d = amanha.strftime("%Y-%m-%d")
    d_disp = amanha.strftime("%d/%m/%Y")
    dia_semana = DIAS[amanha.weekday()]

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
        csrf = next((c["value"] for c in context.cookies() if c["name"] == "csrftoken"), "")
        headers = {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}
        r = page.request.get(
            f"https://app.iclinic.com.br/agenda/{PHYSICIAN_ID}/{d}/?clinic={CLINIC_ID}&slide=1",
            headers=headers,
        )
        events = r.json().get("events", []) if r.status == 200 else []
        browser.close()

    if "--debug" in sys.argv:
        print(f"[DEBUG] amanhã={d} ({dia_semana}), {len(events)} eventos na semana:")
        for e in sorted(events, key=lambda x: (x.get("date") or "", x.get("start_time") or "")):
            print(f"  date={e.get('date')} start={e.get('start_time')!r} status={e.get('status')!r} "
                  f"ins={e.get('insurance')!r} pac={(e.get('patient') or {}).get('name')} "
                  f"procs={[ (p.get('procedure') or {}).get('name') for p in (e.get('procedures') or []) ]}")
        return

    ags = []
    for ev in events:
        pac = ev.get("patient") or {}
        if ev.get("date") != d or not pac.get("name"):   # ignora slots bloqueados/sem paciente
            continue
        if ev.get("status") in STATUS_EXCLUIR:            # cancelado/faltou/bloqueio
            continue
        procs = ev.get("procedures") or []
        proc = (procs[0].get("procedure") or {}).get("name") if procs else "Consulta"
        ins = ev.get("insurance")
        convenio = (ins.get("name") if isinstance(ins, dict) else ins) or None
        ags.append({
            "hora": (ev.get("start_time") or "")[:5],
            "nome": ev["patient"].get("name"),
            "procedimento": proc,
            "convenio": convenio,
        })
    ags.sort(key=lambda x: x["hora"])

    if not ags:
        print(json.dumps({"wakeAgent": False,
                          "data": {"message": f"Sem agendamentos para {d_disp}."}},
                         ensure_ascii=False))
        return

    print(json.dumps({"wakeAgent": True,
                      "data": {"data": d_disp, "dia_semana": dia_semana,
                               "total": len(ags), "agendamentos": ags}},
                     ensure_ascii=False))


try:
    run()
except Exception as e:
    import traceback
    print(json.dumps({"wakeAgent": False,
                      "data": {"error": str(e), "traceback": traceback.format_exc()}}))
