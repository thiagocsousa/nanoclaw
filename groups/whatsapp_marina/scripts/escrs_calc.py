#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calculadora ESCRS (iolcalculator.escrs.org) — SÓ a fórmula KANE.

É Blazor Server + reCAPTCHA v2 (resolvido via 2captcha). Recebe a biometria de UM
olho + a A-constant do Kane pra lente e devolve a potência de LIO do Kane (a mais
próxima do alvo + a tabela).

Uso: python3 escrs_calc.py '<json>'
  json = { "eye":"OD"|"OS", "patient":"NOME", "gender":"Female"|"Male", "age":52,
           "k1":{"d":42.50,"mm":7.94}, "k2":{"d":42.75,"mm":7.89}, "cyl":-0.25,
           "al":23.96, "acd":3.60, "lt":5.05, "cct":520, "wtw":12.65,
           "target":0.0, "a_constant":119.0 }
  (gender e age influenciam o Kane — extrair do exame; a A-constant vem do Barrett.
   mm/cyl são a redundância que o harness [biometria_verify] confere antes de calcular.)
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
# JS: acha o callback do reCAPTCHA e chama com o token (site faz invokeMethodAsync CallbackOnSuccess)
INJECT = ('(token)=>{const cfg=window.___grecaptcha_cfg; if(!cfg||!cfg.clients)return 0;'
          'let n=0;const seen=new Set();function s(o,d){if(!o||d>6||seen.has(o))return;'
          'if(typeof o==="object")seen.add(o);for(const k in o){try{const v=o[k];'
          'if(k==="callback"&&typeof v==="function"){v(token);n++;}else if(v&&typeof v==="object")s(v,d+1);}'
          'catch(e){}}}s(cfg.clients,0);return n;}')


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
        pg.wait_for_timeout(5000)
        try:
            pg.click('button:has-text("I AGREE")', timeout=8000)
        except Exception:
            pass
        pg.wait_for_timeout(5000)

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

        # NÃO desmarcar fórmulas (isso quebra o gatilho do captcha). Mantém todas
        # marcadas, preenche a constante de todas (Kane com a real), e no fim
        # PARSEIA SÓ o Kane. As outras podem dar "service call failed" — ignoradas.
        occ = 0 if inp["eye"].upper() == "OD" else 1
        ac = inp.get("a_constant", 119.0)
        gender = 'Female' if str(inp.get("gender", "")).strip().lower().startswith('f') else 'Male'

        def click_option(text):
            # clica no item de lista (MudSelect) com texto EXATO (has-text casaria substring)
            for it in pg.query_selector_all('.mud-list-item'):
                if (it.inner_text() or '').strip() == text:
                    it.click(); return True
            return False

        fill('Surgeon', 'Marina')
        fill('Patient Initials', (inp.get("patient") or "PX")[:6])
        fill('Age', inp.get("age", 65))
        pg.query_selector('#' + idf('Gender')).click(); pg.wait_for_timeout(500)
        if not click_option(gender):
            return {"ok": False, "aviso": f"ESCRS: não achei a opção de gênero '{gender}'."}

        campos = [('AL', inp["al"]), ('ACD', inp["acd"]), ('K1', inp["k1"]["d"]),
                  ('K2', inp["k2"]["d"]), ('Target Refraction', inp.get("target", 0)),
                  ('Kane A-Constant', ac),
                  ('Barrett A-Constant', ac), ('Cooke A-Constant', ac), ('EVO A-Constant', ac),
                  ('Hill-RBF A-Constant', ac), ('Hoffer® pACD', 5.4), ('Pearl DGS A-Constant', ac)]
        for lbl, v in campos:
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

        pg.click('button:has-text("CALCULATE")'); pg.wait_for_timeout(2500)
        # resolve e injeta o captcha
        token = solve_captcha(key)
        called = pg.evaluate(INJECT, token)
        if not called:
            return {"ok": False, "aviso": "ESCRS: não consegui injetar o token do captcha (site mudou o reCAPTCHA)."}
        pg.wait_for_timeout(9000)
        body = pg.inner_text('body')
        # extrai a tabela de resultado como MATRIZ (células preservam posição/blanks)
        matrix = pg.evaluate('''() => {
          for (const t of document.querySelectorAll('table')) {
            if (t.innerText.includes('Kane') && /[+-]?\\d\\d\\.\\d0/.test(t.innerText)) {
              return [...t.querySelectorAll('tr')].map(tr =>
                [...tr.querySelectorAll('th,td')].map(c => c.innerText.replace(/\\s+/g,' ').trim()));
            }
          }
          return null;
        }''')
        if os.environ.get("ESCRS_DEBUG"):
            open('/tmp/escrs_kane_dbg.txt', 'w').write(body + "\n\n=== MATRIX ===\n" + json.dumps(matrix, ensure_ascii=False))
        b.close()

    if re.search(r'Kane.{0,60}(service call failed|could not be completed)', body, re.I | re.S):
        return {"ok": False, "aviso": "ESCRS/Kane: o serviço de cálculo falhou — tentar de novo."}
    if not matrix:
        return {"ok": False, "aviso": "ESCRS/Kane: rodou mas não achei a tabela (layout pode ter mudado)."}

    # acha a coluna do Kane pelo cabeçalho e lê só ela
    kcol = None
    for row in matrix:
        for j, cell in enumerate(row):
            if re.search(r'\bKane\b', cell):
                kcol = j
    if kcol is None:
        return {"ok": False, "aviso": "ESCRS/Kane: coluna Kane não encontrada."}
    tabela = []
    for row in matrix:
        if row and re.match(r'[+-]?\d{2}\.\d0$', row[0]) and kcol < len(row):
            val = row[kcol].strip()
            if re.match(r'[+-]?\d\.\d\d$', val):
                tabela.append({"power": row[0].lstrip('+'), "refracao": val})
    if not tabela:
        return {"ok": False, "aviso": "ESCRS/Kane: sem valores na coluna Kane (pode ter falhado)."}
    alvo = float(inp.get("target", 0))
    rec = min(tabela, key=lambda r: abs(float(r["refracao"]) - alvo))
    return {"ok": True, "kane": {"recomendado": rec, "tabela": tabela}}


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
