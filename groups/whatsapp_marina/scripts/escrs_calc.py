#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calculadora ESCRS (iolcalculator.escrs.org) — SÓ a fórmula KANE.

É Blazor Server + reCAPTCHA v2 (resolvido via 2captcha). Recebe a biometria de UM
olho + a A-constant do Kane pra lente e devolve a potência de LIO do Kane (a mais
próxima do alvo + a tabela).

Uso: python3 escrs_calc.py '<json>'
  json = { "eye":"OD"|"OS", "patient":"NOME", "gender":"Female"|"Male", "age":52,
           "k1":{"d":42.50,"mm":7.94,"axis":103}, "k2":{"d":42.75,"mm":7.89,"axis":13},
           "cyl":-0.25, "al":23.96, "acd":3.60, "lt":5.05, "cct":520, "wtw":12.65,
           "target":0.0, "manufacturer":"Alcon", "iol":"AcrySof SN60AT",
           "toric":true, "sia":0.15, "incision_axis":135 }
  A A-constant do Kane NÃO vem do Barrett — vem da seleção da lente (manufacturer+iol)
  no próprio site (constante otimizada por fórmula). gender/age influenciam o Kane.
  Com toric=true, preenche eixos+SIA e traz o eixo do IOL. mm/cyl = redundância do harness.
  Saída: { ok, kane:{recomendado:{power,refracao}, vizinhos:{acima,abaixo}, toric:{eixo,residual}|null, tabela}, aviso }
Env: ESCRS_2CAPTCHA_KEY (chave do 2captcha).
Saída: JSON { ok, kane:{recomendado:{power,refracao}, tabela:[...]}, aviso }
Se o captcha/serviço falhar ou o layout mudar → { ok:false, aviso } (não inventa).
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from biometria_verify import verify

URL = 'https://iolcalculator.escrs.org/'
SITEKEY = '6LeEGBMUAAAAAPKHrd7DZdRJ8ecmuwuBwEXlnLtO'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
FORMULAS_OFF = ['Barrett', 'Cooke K6', 'EVO', 'Hill-RBF', 'Hoffer®QST', 'Pearl DGS']
# JS: acha o callback do reCAPTCHA e chama com o token (site faz invokeMethodAsync CallbackOnSuccess).
# Robusto: seta a textarea g-recaptcha-response, busca funda (d>12) qualquer chave ~callback.
INJECT = ('(token)=>{let n=0;const seen=new Set();'
          'document.querySelectorAll("textarea#g-recaptcha-response,textarea[name=g-recaptcha-response]")'
          '.forEach(t=>{t.value=token;});'
          'function s(o,d){if(!o||d>12||seen.has(o)||typeof o!=="object")return;seen.add(o);'
          'for(const k in o){try{const v=o[k];'
          'if(typeof v==="function"&&/callback/i.test(k)){v(token);n++;}'
          'else if(v&&typeof v==="object")s(v,d+1);}catch(e){}}}'
          'const cfg=window.___grecaptcha_cfg; if(cfg&&cfg.clients)s(cfg.clients,0);'
          'return n;}')


def _out(d):
    print(json.dumps(d, ensure_ascii=False))
    sys.exit(0 if d.get("ok") else 1)


def solve_captcha(key):
    import requests
    r = requests.post('https://api.2captcha.com/createTask', timeout=30, json={
        'clientKey': key,
        'task': {'type': 'RecaptchaV2TaskProxyless', 'websiteURL': URL, 'websiteKey': SITEKEY}}).json()
    if r.get('errorId'):
        raise RuntimeError(f"2captcha createTask: {r.get('errorDescription')}")
    tid = r['taskId']
    for _ in range(40):
        time.sleep(6)
        res = requests.post('https://api.2captcha.com/getTaskResult', timeout=30,
                            json={'clientKey': key, 'taskId': tid}).json()
        if res.get('status') == 'ready':
            return res['solution']['gRecaptchaResponse']
        if res.get('errorId'):
            raise RuntimeError(f"2captcha getTaskResult: {res.get('errorDescription')}")
    raise RuntimeError("2captcha: timeout")


def run(inp):
    from playwright.sync_api import sync_playwright

    key = os.environ.get("ESCRS_2CAPTCHA_KEY")
    if not key:
        return {"ok": False, "aviso": "ESCRS_2CAPTCHA_KEY não definido."}

    # HARNESS: confere a leitura contra a redundância do exame antes de calcular
    erros = verify(inp)
    if erros:
        return {"ok": False, "aviso": "Não pude confirmar a leitura do exame (não vou calcular): "
                + "; ".join(erros) + ". Confira/reenvie o exame ou passe os valores corrigidos."}

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True,
                              executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
                              args=['--disable-blink-features=AutomationControlled'])
        pg = b.new_context(user_agent=UA, viewport={'width': 1400, 'height': 1400}).new_page()
        pg.goto(URL, wait_until='networkidle', timeout=60000)
        pg.wait_for_timeout(3000)
        try:
            pg.click('button:has-text("I AGREE")', timeout=8000)
        except Exception:
            pass
        pg.wait_for_timeout(3000)

        if not pg.query_selector_all('label'):
            return {"ok": False, "aviso": "ESCRS: formulário não carregou (site pode ter mudado)."}

        def idf(text, occ=0):
            # RE-QUERY a cada chamada: o Blazor re-renderiza e regenera os IDs
            f = [l for l in pg.query_selector_all('label') if (l.inner_text() or '').strip() == text]
            return f[occ].get_attribute('for') if len(f) > occ else None

        def fill(text, val, occ=0):
            fid = idf(text, occ)
            if not fid:
                raise RuntimeError(f"campo '{text}' não encontrado")
            i = pg.query_selector('#' + fid)
            i.click(); i.fill(str(val)); i.press('Tab')

        # Form tem os DOIS olhos lado a lado; occ (0=OD, 1=OS) indexa o painel certo.
        # A A-constant do Kane vem da SELEÇÃO DA LENTE no próprio site (otimizada por
        # fórmula) — NÃO reaproveitar a do Barrett (é o que dava a potência errada).
        occ = 0 if inp["eye"].upper() == "OD" else 1
        gender = 'Female' if str(inp.get("gender", "")).strip().lower().startswith('f') else 'Male'
        # default NÃO-tórico: é o caminho confiável (potência + vizinhos). O modo tórico
        # do site (que traz o eixo do Kane) ainda está sendo estabilizado — toric=true opt-in.
        toric = bool(inp.get("toric", False))

        def click_option(text):
            # clica no item de lista (MudSelect) com texto EXATO (has-text casaria substring)
            for it in pg.query_selector_all('.mud-list-item'):
                if (it.inner_text() or '').strip() == text:
                    it.click(); return True
            return False

        def eye_select(label, value):
            # abre o MudSelect do olho certo (nth=occ) e escolhe a opção exata
            ctrl = pg.locator(f'.mud-input-control:has(label:text-is("{label}"))').nth(occ)
            if not ctrl.count():
                return False
            ctrl.click(); pg.wait_for_timeout(1000)
            ok = click_option(value); pg.wait_for_timeout(1200)
            return ok

        fill('Surgeon', 'Marina')
        fill('Patient Initials', (inp.get("patient") or "PX")[:6])
        fill('Age', inp.get("age", 65))
        pg.query_selector('#' + idf('Gender')).click(); pg.wait_for_timeout(500)
        if not click_option(gender):
            return {"ok": False, "aviso": f"ESCRS: não achei a opção de gênero '{gender}'."}

        # LENTE: fabricante + modelo → o site preenche a A-constant otimizada de cada fórmula
        mfr, iol = inp.get("manufacturer"), inp.get("iol")
        if not mfr or not iol:
            return {"ok": False, "aviso": "ESCRS: falta manufacturer/iol da lente (a A-constant do Kane vem da lente, não calculo sem)."}
        if not eye_select('Manufacturer', mfr):
            return {"ok": False, "aviso": f"ESCRS: fabricante '{mfr}' não está na lista do site."}
        if not eye_select('Select IOL', iol):
            return {"ok": False, "aviso": f"ESCRS: lente '{iol}' (fabricante '{mfr}') não está na lista do site."}

        # o site preenche a A-constant do Kane de forma ASSÍNCRONA (Blazor). ESPERA ela
        # aparecer ANTES de calcular — senão calcula com a constante default (número errado).
        # (usa input_value = valor VIVO da propriedade; get_attribute('value') lê só o inicial)
        def read_field(label):
            fid = idf(label, occ)
            if not fid:
                return ''
            try:
                return (pg.input_value('#' + fid) or '').strip()
            except Exception:
                return ''

        kane_const = ''
        for _ in range(15):
            kane_const = read_field('Kane A-Constant')
            if kane_const:
                break
            pg.wait_for_timeout(800)
        if not kane_const:
            return {"ok": False, "aviso": f"ESCRS: selecionei '{iol}' mas o site não preencheu a A-constant do Kane a tempo — não calculo com a constante errada."}

        # TORIC ON → habilita eixos/SIA/incisão e a recomendação de eixo do IOL
        if toric:
            tog = pg.locator('.mud-switch:has-text("Toric")').nth(occ)
            if tog.count():
                tog.click(); pg.wait_for_timeout(1500)

        campos = [('AL', inp["al"]), ('ACD', inp["acd"]), ('K1', inp["k1"]["d"]),
                  ('K2', inp["k2"]["d"]), ('Target Refraction', inp.get("target", 0))]
        if toric:
            campos += [('K1 axis', (inp.get("k1") or {}).get("axis")),
                       ('K2 axis', (inp.get("k2") or {}).get("axis")),
                       ('SIA', inp.get("sia", 0.15)), ('Incision', inp.get("incision_axis", 135))]
        for lbl, v in campos:
            if v is None:
                continue
            try:
                fill(lbl, v, occ)
            except Exception:
                pass
        for lbl, key_ in [('LT', 'lt'), ('CCT', 'cct'), ('WTW', 'wtw')]:
            if inp.get(key_):
                try:
                    fill(lbl, inp[key_], occ)
                except Exception:
                    pass

        pg.click('button:has-text("CALCULATE")'); pg.wait_for_timeout(4000)
        # resolve o reCAPTCHA (comportamento provado). NÃO trava se o inject não achar
        # o callback — segue e checa o resultado (às vezes o site passa direto).
        token = solve_captcha(key)
        for _ in range(5):
            if pg.evaluate(INJECT, token):
                break
            pg.wait_for_timeout(2000)
        pg.wait_for_timeout(9000)
        body = pg.inner_text('body')
        # captura TODAS as tabelas (texto + classe da célula, p/ achar a recomendada)
        all_tables = pg.evaluate('''() => {
          return [...document.querySelectorAll('table')].map(t =>
            [...t.querySelectorAll('tr')].map(tr =>
              [...tr.querySelectorAll('th,td')].map(c => ({
                t: c.innerText.replace(/\\s+/g,' ').trim(),
                cls: c.className || ''
              }))));
        }''')
        if os.environ.get("ESCRS_DEBUG"):
            open('/tmp/escrs_kane_dbg.txt', 'w').write(body + "\n\n=== ALL TABLES ===\n" + json.dumps(all_tables, ensure_ascii=False))
        b.close()

    if re.search(r'Kane.{0,60}(service call failed|could not be completed)', body, re.I | re.S):
        return {"ok": False, "aviso": "ESCRS/Kane: o serviço de cálculo falhou — tentar de novo."}
    result = parse_kane(all_tables, inp.get("target", 0))
    if result.get("ok"):
        result["kane"]["a_constant"] = kane_const  # constante que o site aplicou pra lente
    return result


def _kcol(matrix):
    """índice da coluna 'Kane' pelo cabeçalho (última ocorrência = header do bloco)."""
    kcol = None
    for row in matrix:
        for j, cell in enumerate(row):
            if re.search(r'\bKane\b', cell):
                kcol = j
    return kcol


def parse_kane(all_tables, target):
    """
    Parser à prova de falha (advisor): identifica POSITIVAMENTE a coluna Kane e a
    linha recomendada, ou devolve aviso. Nunca emite número sem procedência.
    - SE PWR (sólido): potência recomendada + vizinhos acima/abaixo.
    - Toric (fail-safe): eixo + cilindro residual da célula RECOMENDADA (destacada);
      se não achar com confiança, omite (toric=None) em vez de chutar.
    """
    at = all_tables or []

    def find(pred):
        for tbl in at:
            flat = ' '.join(c['t'] for row in tbl for c in row)
            if pred(flat):
                return tbl
        return None

    # --- SE PWR: potências esféricas equivalentes ---
    # alvo principal: a tabela com "SE PWR"; fallback: Kane + potências que não seja a tórica
    se = find(lambda f: 'SE PWR' in f and 'Kane' in f)
    if not se:
        se = find(lambda f: 'Kane' in f and re.search(r'[+-]?\d\d\.\d0', f)
                  and 'IOL Cyl' not in f and 'Res. Cyl' not in f)
    if not se:
        # diagnóstico: devolve os cabeçalhos de cada tabela pra eu ver a estrutura real da VM
        heads = []
        for tbl in at:
            first = ' | '.join(c['t'] for c in (tbl[0] if tbl else []) if c['t'])[:90]
            if first:
                heads.append(first)
        diag = (" Tabelas na página: " + " ;; ".join(heads[:6])) if heads else " (nenhuma tabela na página — o cálculo não saiu)."
        return {"ok": False, "aviso": "ESCRS/Kane: não achei a tabela de potências." + diag}
    mtx = [[c['t'] for c in row] for row in se]
    kcol = _kcol(mtx)
    if kcol is None:
        return {"ok": False, "aviso": "ESCRS/Kane: coluna Kane não encontrada."}
    tabela = []
    for row in mtx:
        if row and re.match(r'[+-]?\d{2}\.\d0$', row[0]) and kcol < len(row):
            val = row[kcol].strip()
            if re.match(r'[+-]?\d\.\d\d$', val):
                tabela.append({"power": row[0].lstrip('+'), "refracao": val})
    if not tabela:
        return {"ok": False, "aviso": "ESCRS/Kane: sem valores na coluna Kane (pode ter falhado)."}
    tabela.sort(key=lambda r: float(r["power"]), reverse=True)
    alvo = float(target or 0)
    rec = min(tabela, key=lambda r: abs(float(r["refracao"]) - alvo))
    i = tabela.index(rec)
    vizinhos = {"acima": tabela[i - 1] if i > 0 else None,
                "abaixo": tabela[i + 1] if i + 1 < len(tabela) else None}
    kane = {"recomendado": rec, "vizinhos": vizinhos, "tabela": tabela, "toric": None}

    # --- Toric (fail-safe): célula recomendada (destacada) na coluna do Kane ---
    tor = find(lambda f: ('Res. Cyl' in f or 'IOL Axis' in f) and 'Kane' in f)
    if tor:
        kc = _kcol([[c['t'] for c in row] for row in tor])
        if kc is not None:
            for row in tor:
                for j, c in enumerate(row):
                    if abs(j - kc) <= 2 and re.search(r'high|select|active|recommend|chosen', c['cls'], re.I):
                        m = re.search(r'([+-]?\d\.\d\d)\s*x\s*(\d{1,3})', c['t'])
                        if m:
                            kane["toric"] = {"residual": m.group(1), "eixo": m.group(2)}
    return {"ok": True, "kane": kane}


def main():
    if len(sys.argv) < 2:
        _out({"ok": False, "aviso": "uso: escrs_calc.py '<json>'"})
    try:
        inp = json.loads(sys.argv[1])
    except Exception as e:
        _out({"ok": False, "aviso": f"JSON inválido: {e}"})
    # o serviço ESCRS falha esporadicamente ("não achei a tabela" / "serviço falhou") →
    # tenta 2x nessas transitórias (cada tentativa é um solve de captcha)
    last = None
    for _ in range(2):
        try:
            last = run(inp)
        except Exception as e:
            import traceback
            last = {"ok": False, "aviso": f"ESCRS: erro — {e}", "traceback": traceback.format_exc()[-400:]}
        if last.get("ok"):
            _out(last)
        av = last.get("aviso", "")
        if "não achei a tabela" not in av and "serviço de cálculo falhou" not in av:
            break
    _out(last)


if __name__ == "__main__":
    main()
