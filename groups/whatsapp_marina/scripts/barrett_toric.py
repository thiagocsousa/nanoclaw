#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calculadora Barrett Toric (ASCRS / calc.apacrs.org) — automatizada.

Recebe a biometria de UM olho + a lente + o alvo e devolve a recomendação de LIO
tórica (SEQ, modelo tórico, astigmatismo residual). SIA/incisão default 0.15@135.

Uso:
  python3 barrett_toric.py '<json>'
  json = {
    "eye": "OD"|"OS", "patient": "NOME",
    "k1": {"d": 42.50, "axis": 103}, "k2": {"d": 42.75, "axis": 13},
    "al": 23.96, "acd": 3.60, "lt": 5.05, "wtw": 12.65,
    "target": 0.0, "lens": "Alcon SN6ATx",   # rótulo do dropdown (ou parcial)
    "a_constant": 119.0,                       # opcional, se a lente não estiver na lista
    "sia": 0.15, "incision_axis": 135
  }
Saída (stdout): JSON { ok, recomendacao, tabela_seq, tabela_toric, constantes, aviso }
Se o site mudar/quebrar → { ok:false, aviso:"..." } (não inventa resultado).
"""
import json
import os
import re
import sys

URL = 'https://calc.apacrs.org/toric_calculator20/Toric%20Calculator.aspx'
N = 'ctl00$MainContent$'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


def _out(d):
    print(json.dumps(d, ensure_ascii=False))
    sys.exit(0 if d.get("ok") else 1)


def run(inp):
    from playwright.sync_api import sync_playwright

    def wait(pg):
        try:
            pg.wait_for_load_state('networkidle', timeout=9000)
        except Exception:
            pass

    def fill(pg, name, val):
        pg.fill(f'[name="{N}{name}"]', str(val), timeout=9000)

    # flat = menor K (dioptrias); steep = maior
    k1, k2 = inp["k1"], inp["k2"]
    flat, steep = (k1, k2) if float(k1["d"]) <= float(k2["d"]) else (k2, k1)

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True,
                              executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
                              args=['--disable-blink-features=AutomationControlled'])
        pg = b.new_context(user_agent=UA, viewport={'width': 1280, 'height': 1200}).new_page()
        pg.goto(URL, wait_until='domcontentloaded', timeout=60000)
        pg.wait_for_timeout(6000)   # Cloudflare
        if 'moment' in pg.title().lower() or 'Toric' not in pg.title():
            _out({"ok": False, "aviso": "Barrett: bloqueio do Cloudflare não resolveu (site pode ter mudado a proteção)."})

        if not pg.query_selector(f'[name="{N}MeasuredK"]'):
            _out({"ok": False, "aviso": "Barrett: campos não encontrados — o site provavelmente mudou. Confira manualmente."})

        # olho + índice K padrão (1.3375) + cilindro negativo
        eye_val = 'Rad1' if inp["eye"].upper() == 'OD' else 'Rad2'
        pg.check(f'[name="{N}Eye Select"][value="{eye_val}"]'); wait(pg)
        pg.check(f'[name="{N}RadioButtonList1"][value="337.5"]'); wait(pg)
        pg.check(f'[name="{N}RadioButtonList2"][value="-1"]'); wait(pg)

        fill(pg, 'DoctorName', 'Dra. Marina Costa')
        fill(pg, 'PatientName', inp.get("patient") or "PACIENTE")   # obrigatório
        fill(pg, 'PatientNo', str(inp.get("patient_id") or "1"))
        fill(pg, 'MeasuredK', flat["d"]); fill(pg, 'MeasuredAxis', flat["axis"])
        fill(pg, 'MeasuredK0', steep["d"]); fill(pg, 'MeasuredAxis0', steep["axis"])
        fill(pg, 'AxLength', inp["al"]); fill(pg, 'OpticalACD', inp["acd"])
        if inp.get("lt"):
            fill(pg, 'LensThickness', inp["lt"])
        if inp.get("wtw"):
            fill(pg, 'WTW', inp["wtw"])
        fill(pg, 'Refraction', inp.get("target", 0))
        fill(pg, 'InducedCyl', inp.get("sia", 0.15))
        fill(pg, 'IncisionAxis', inp.get("incision_axis", 135))

        # lente: casa com uma opção do dropdown (exata ou parcial, sem acento/caixa)
        sel = pg.query_selector(f'select[name="{N}IOLModel"]')
        opts = [o.inner_text().strip() for o in sel.query_selector_all('option')]
        want = (inp.get("lens") or "").strip().lower()
        match = None
        for o in opts:
            if o.lower() == want:
                match = o; break
        if not match:
            for o in opts:
                if want and want in o.lower():
                    match = o; break
        constantes = {}
        if match:
            pg.select_option(f'select[name="{N}IOLModel"]', label=match); wait(pg); pg.wait_for_timeout(800)
            constantes = {"modelo": match,
                          "lens_factor": pg.query_selector(f'[name="{N}LensFactor"]').get_attribute("value"),
                          "a_constant": pg.query_selector(f'[name="{N}Aconstant"]').get_attribute("value")}
        elif inp.get("a_constant"):
            pg.select_option(f'select[name="{N}IOLModel"]', label='Personal Constant'); wait(pg)
            fill(pg, 'Aconstant', inp["a_constant"]); wait(pg); pg.wait_for_timeout(500)
            constantes = {"modelo": "Personal Constant", "a_constant": str(inp["a_constant"])}
        else:
            _out({"ok": False,
                  "aviso": f"Barrett: lente '{inp.get('lens')}' não está na lista e sem A-constant. "
                           f"Opções: {', '.join(opts[1:])}"})

        pg.click(f'[name="{N}Button1"]', force=True); wait(pg); pg.wait_for_timeout(2500)
        try:
            pg.click('a:has-text("Toric IOL")'); wait(pg); pg.wait_for_timeout(2500)
        except Exception:
            pass

        txt = pg.inner_text('body')
        if os.environ.get("BARRETT_DEBUG"):
            open('/tmp/barrett_dbg.txt', 'w').write(txt)
        b.close()

    # parse da aba Toric IOL
    seq = re.findall(r'([\d.]+)\s*S\.E[^\n]*?([A-Z0-9]+)\s+(-?[\d.]+)\s*S\.E', txt)
    toric = re.findall(r'(Non Toric|[A-Z]{2}\d[A-Z0-9]*)\s+([\d.]+)\s+(-?[\d.]+)\s*Cyl\s*Axis\s*(\d+)', txt)
    if not toric:
        return {"ok": False, "aviso": "Barrett: rodou mas não achei a tabela de resultado (layout pode ter mudado)."}

    tabela_toric = [{"toric_power": t[0], "iol_cyl": t[1], "astig_residual": t[2], "eixo": t[3]} for t in toric]
    tabela_seq = [{"iol_power": s[0], "toric_model": s[1], "refracao_seq": s[2]} for s in seq]
    # recomendado = menor astigmatismo residual (em módulo) entre as opções tóricas
    toricas = [t for t in tabela_toric if t["toric_power"].lower() != "non toric"]
    rec = min(toricas, key=lambda t: abs(float(t["astig_residual"]))) if toricas else None
    return {"ok": True, "recomendacao": rec, "tabela_toric": tabela_toric,
            "tabela_seq": tabela_seq, "constantes": constantes}


def main():
    if len(sys.argv) < 2:
        _out({"ok": False, "aviso": "uso: barrett_toric.py '<json>'"})
    try:
        inp = json.loads(sys.argv[1])
    except Exception as e:
        _out({"ok": False, "aviso": f"JSON inválido: {e}"})
    try:
        _out(run(inp))
    except Exception as e:
        import traceback
        _out({"ok": False, "aviso": f"Barrett: erro inesperado — {e}",
              "traceback": traceback.format_exc()[-500:]})


if __name__ == "__main__":
    main()
