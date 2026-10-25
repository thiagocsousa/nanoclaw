#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cria um LAUDO DE TOPOGRAFIA como RASCUNHO no iClinic (consultório da Dra. Marina),
a partir dos dados extraídos de um PDF de topografia. Só preenche as linhas KT
(dados objetivos) — SEM frases de interpretação (a Marina escreve/assina depois).

Fluxo (Playwright): login → busca o paciente pelo nome → abre o prontuário →
inicia atendimento (se não houver um aberto) → Documentos e atestados → Novo
documento → modelo "LAUDO TOPO" → substitui o conteúdo pelas linhas KT → SALVAR
(sem assinar = rascunho). NÃO finaliza o atendimento (a Marina revisa/assina).

Segurança: se a busca do paciente retornar 0 ou >1 resultado, NÃO cria nada e
devolve aviso pedindo pra desambiguar (não chuta paciente).

Entrada (argv[1] JSON) — o AGENTE extrai da topografia por visão:
  {"paciente":"Patricia Imamura",
   "od":{"kf":43.22,"kf_axis":11,"ks":44.22,"ks_axis":101,"cyl":1.00},
   "os":{"kf":43.11,"kf_axis":173,"ks":46.07,"ks_axis":63,"cyl":2.97}}
  (kf=K plano, ks=K curvo; eixos em graus; cyl=cilindro)

Saída: {"ok":true,"mensagem":...} ou {"ok":false,"aviso":...}
Credenciais: env ICLINIC_CONSULTORIO_EMAIL / ICLINIC_CONSULTORIO_PASSWORD.
"""
import json
import os
import sys

BASE = "https://app.iclinic.com.br"
EMAIL = os.environ.get("ICLINIC_CONSULTORIO_EMAIL", "dramarinacostaconsultorio@gmail.com")
MODELO = os.environ.get("LAUDO_TOPO_MODELO", "LAUDO TOPO")

# ⛔ SEM valor padrão. Até 25/10/2026 a senha do consultório estava literal
# aqui, como segundo argumento do `os.environ.get` — e sobreviveu à limpeza de
# 24/10 (commit d2a9d8d8, "tira a senha do iClinic dos scripts") porque o
# `sem-segredo-no-repo.test.ts` procurava `SENHA = "..."` e dizia, por escrito,
# que `os.environ.get("X", "default")` NÃO casava. Era exatamente a forma em
# que a senha estava se escondendo: o guarda tinha o critério estreito, não o
# arquivo tinha sorte.
#
# ⚠️ Estar fora daqui não é estar segura: ela está no histórico do git e TEM de
# ser rotacionada.
PASSWORD = os.environ.get("ICLINIC_CONSULTORIO_PASSWORD", "")


def _out(d):
    print(json.dumps(d, ensure_ascii=False))
    return d


def _fmt_k(v):
    return f"{float(v):.2f}"


def _fmt_axis(v):
    return str(int(round(float(v))))


def _kt_line(eye):
    """KT: {kf} ({kf_axis}) x {ks} ({ks_axis}) Cil {cyl} — K plano primeiro, depois o curvo."""
    return (f"KT: {_fmt_k(eye['kf'])} ({_fmt_axis(eye['kf_axis'])}) x "
            f"{_fmt_k(eye['ks'])} ({_fmt_axis(eye['ks_axis'])}) Cil {_fmt_k(eye['cyl'])}")


def _laudo_lines(inp):
    return ["LAUDO DE TOPOGRAFIA DE CÓRNEA", "",
            "OLHO DIREITO:", _kt_line(inp["od"]), "",
            "OLHO ESQUERDO:", _kt_line(inp["os"])]


def _login(ctx):
    # Falha explícita em vez de digitar senha vazia e levar "login inválido" do
    # iClinic, que manda a recepção procurar problema de conta.
    if not PASSWORD:
        raise RuntimeError(
            "falta ICLINIC_CONSULTORIO_PASSWORD no ambiente "
            "(FORWARDED_ENV_VARS em container-runner.ts)"
        )
    pg = ctx.new_page()
    pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=45000)
    pg.fill("input[type=email]", EMAIL, timeout=15000)
    pg.fill("input[type=password]", PASSWORD, timeout=8000)
    pg.click("button[type=submit]")
    try:
        pg.wait_for_url("**/dashboard/**", timeout=30000)
    except Exception:
        pg.wait_for_timeout(8000)
    return pg


def _buscar_paciente(pg, nome):
    """Retorna lista de {nome, href} que casam com a busca."""
    pg.goto(BASE + "/pacientes/", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(3000)
    pg.fill("input[name=patient_name]", nome)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(3500)
    return pg.evaluate(
        """()=>[...document.querySelectorAll("a[href*='prontuario']")]
             .map(a=>({nome:(a.innerText||'').trim(),href:a.getAttribute('href')}))
             .filter(x=>x.nome && x.href)""")


def run(inp):
    for k in ("paciente", "od", "os"):
        if not inp.get(k):
            return {"ok": False, "aviso": f"Falta '{k}' na entrada do laudo."}
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        # ⛔ `executable_path` NÃO é opcional aqui, e a falta dele vivia como
        # remendo não commitado na VM — descoberto em 25/10/2026, quando o
        # `git pull --ff-only` do deploy abortou por causa dele. O container
        # usa o Chromium do sistema (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, no
        # Dockerfile) e NÃO baixa o do Playwright; sem isto o launch morre
        # procurando um navegador que não existe.
        #
        # É a mesma linha de `barrett_toric.py`, `escrs_calc.py` e
        # `nfse_danfse_portal.py` — este era o único dos quatro sem ela.
        # Sem valor padrão de propósito: `None` deixa o Playwright decidir, que
        # é o certo fora do container.
        b = pw.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
        )
        ctx = b.new_context(viewport={"width": 1440, "height": 950})
        ctx.add_cookies([{"name": "cookie_consent", "value": "1",
                          "domain": ".iclinic.com.br", "path": "/"}])
        try:
            pg = _login(ctx)
            matches = _buscar_paciente(pg, inp["paciente"])
            uniq = {m["href"]: m for m in matches}.values()
            uniq = list(uniq)
            if len(uniq) == 0:
                return {"ok": False, "aviso": f"Não achei paciente '{inp['paciente']}' no iClinic. "
                        "Confira o nome (ou cadastre) e tente de novo."}
            if len(uniq) > 1:
                nomes = ", ".join(m["nome"] for m in uniq[:6])
                return {"ok": False, "aviso": f"Mais de um paciente com '{inp['paciente']}': {nomes}. "
                        "Diga o nome exato pra eu não errar o prontuário."}
            alvo = uniq[0]

            pg.goto(BASE + alvo["href"], wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_timeout(5000)
            # inicia atendimento só se não houver um aberto
            st = pg.evaluate("()=>({i:!!document.body.innerText.match(/Iniciar atendimento/),"
                             "f:!!document.body.innerText.match(/Finalizar atendimento/)})")
            if st["i"] and not st["f"]:
                pg.get_by_text("Iniciar atendimento").first.click()
                pg.wait_for_timeout(7000)
            # Documentos e atestados → Novo documento
            pg.evaluate("""()=>{const a=[...document.querySelectorAll('a')]
                .find(x=>/Documentos e atestados/.test(x.innerText||''));a&&a.click();}""")
            pg.wait_for_timeout(2500)
            pg.evaluate("""()=>{const b=[...document.querySelectorAll('button')]
                .find(x=>/^Novo documento$/i.test((x.innerText||'').trim()));b&&b.click();}""")
            pg.wait_for_timeout(2000)
            # abre o seletor de modelo e filtra
            pg.evaluate("""()=>{const el=[...document.querySelectorAll('*')].find(e=>e.offsetParent!==null
                &&(e.innerText||'').trim()==='Selecione'&&e.children.length<=1);el&&el.click();}""")
            pg.wait_for_timeout(1800)
            pg.evaluate("""(m)=>{const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent!==null
                &&/pesquis/i.test(e.placeholder||''));if(i){i.focus();i.value=m;
                i.dispatchEvent(new Event('input',{bubbles:true}));}}""", MODELO)
            pg.wait_for_timeout(1500)
            try:
                pg.get_by_text(MODELO, exact=True).last.click(timeout=8000)
            except Exception:
                return {"ok": False, "aviso": f"iClinic: não achei o modelo '{MODELO}' na lista de documentos."}
            pg.wait_for_timeout(3000)
            # localiza o editor que carregou o template e substitui o conteúdo
            idx = pg.evaluate("""()=>{const eds=[...document.querySelectorAll('[contenteditable=true]')];
                for(let i=0;i<eds.length;i++){if(/TOPOGRAFIA/i.test(eds[i].innerText||''))return i;}return -1;}""")
            if idx < 0:
                return {"ok": False, "aviso": "iClinic: o modelo LAUDO TOPO não carregou no editor — tentar de novo."}
            ed = pg.locator("[contenteditable=true]").nth(idx)
            ed.click()
            pg.wait_for_timeout(300)
            pg.keyboard.press("Meta+A")
            pg.keyboard.press("Delete")
            pg.wait_for_timeout(200)
            for i, line in enumerate(_laudo_lines(inp)):
                if i > 0:
                    pg.keyboard.press("Enter")
                if line:
                    pg.keyboard.type(line, delay=4)
            pg.wait_for_timeout(500)
            # confere que os KT entraram
            body = pg.evaluate("()=>document.querySelectorAll('[contenteditable=true]')[%d].innerText" % idx)
            if _kt_line(inp["od"]) not in body or _kt_line(inp["os"]) not in body:
                return {"ok": False, "aviso": "iClinic: o conteúdo do laudo não ficou como esperado — não salvei. Tentar de novo."}
            # SALVA (sem assinar = rascunho)
            ed.click()
            salvar = pg.get_by_role("button", name="SALVAR").first
            salvar.scroll_into_view_if_needed()
            salvar.click(force=True)
            pg.wait_for_timeout(5000)
            return {"ok": True, "mensagem": f"Laudo de topografia criado como *rascunho* no prontuário de "
                    f"*{alvo['nome']}* — revisar e assinar no iClinic."}
        except Exception as e:
            return {"ok": False, "aviso": f"iClinic/laudo: falhou ({type(e).__name__}: {str(e)[:150]}) — tentar de novo."}
        finally:
            b.close()


def main():
    if len(sys.argv) < 2:
        _out({"ok": False, "aviso": "uso: iclinic_laudo_topografia.py '<json>'"})
        return
    try:
        inp = json.loads(sys.argv[1])
    except Exception as e:
        _out({"ok": False, "aviso": f"JSON inválido: {e}"})
        return
    _out(run(inp))


if __name__ == "__main__":
    main()
