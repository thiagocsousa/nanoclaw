#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Coletor do CÓDIGO DE VERIFICAÇÃO das NFS-e emitidas por DPS. **Fase 5** de
docs/NFSE-DPS-MIGRACAO.md.

## Por que isto existe

O DANFSE (PDF) é baixado por um endpoint PÚBLICO que exige
`numeroNota` + `codigoVerificacao`. A API de DPS **não devolve** esse código
(confirmado pela SEMF em 2026-10-02) — ele só aparece dentro do QR do próprio
PDF, o que é circular. Este script quebra a circularidade uma única vez por
nota: abre o portal com Playwright, manda exibir o DANFSE e **intercepta a
requisição** que o portal faz, lendo o código direto da URL.

Depois disso o download volta a ser HTTP puro, pelo `baixar_danfse` que já roda
em produção — o navegador NÃO participa do envio ao paciente.

    navegador (1x por nota)        →  código de verificação  →  arquivo JSON
    nfse_emitir.baixar_danfse(...) →  PDF                    →  paciente

## Isto é dívida técnica, de propósito

É um contorno para uma limitação da API deles. Se a SEMF expuser o código (ou
um endpoint de DANFSE por chave), **apague este arquivo** e nada mais muda: o
resto do pipeline não sabe que ele existe.

## Falha RUIDOSA

Nunca "dá um jeito". Se não achar o código, devolve vazio e quem chamou marca
o PDF como pendente no resumo do WhatsApp — nota emitida, PDF à mão. É melhor
a recepção enviar um PDF manualmente do que o paciente receber nada, ou pior,
receber errado.

Uso:
  python3 nfse_danfse_portal.py 2898 2897          # coleta e grava no JSON
  python3 nfse_danfse_portal.py 2898 --debug       # salva screenshot + HTML
  python3 nfse_danfse_portal.py --listar           # mostra o que já foi coletado

Env: NFSE_PORTAL_SENHA (obrigatória) e NFSE_AMBIENTE (homologacao|producao).
     NFSE_PORTAL_USUARIO é opcional — o padrão é o CNPJ da clínica.
"""
import json
import os
import re
import sys
from pathlib import Path

GROUP = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
CODIGOS_FILE = GROUP / "nfse_codigos_verificacao.json"
DEBUG_DIR = GROUP / "tmp"

PORTAIS = {
    "homologacao": "https://nfse2-the.dsfweb.com.br",
    "producao": "https://notafiscal.teresina.pi.gov.br",
}
AMBIENTE = os.environ.get("NFSE_AMBIENTE", "producao")

# A URL que interessa é a do DANFSE; o código é o último segmento.
RE_CODIGO = re.compile(r"/codigoVerificacao/([A-Za-z0-9]{1,9})")

TIMEOUT = int(os.environ.get("NFSE_PORTAL_TIMEOUT_MS", "30000"))


def carrega():
    try:
        return json.loads(CODIGOS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def grava(mapa):
    CODIGOS_FILE.write_text(json.dumps(mapa, ensure_ascii=False, indent=2),
                            encoding="utf-8")


def codigo_de(numero):
    """Código já coletado para uma nota, ou None. É o que o pipeline consome."""
    return carrega().get(str(numero))


def _usuario_padrao():
    """O login do portal é o CNPJ da clínica — dado público de cadastro, já
    versionado. Só a senha precisa vir do .env."""
    try:
        from nfse_dps import PRESTADOR
        return PRESTADOR["CNPJ"]
    except Exception:
        return "63521918000104"


def _formata_cnpj(d):
    d = re.sub(r"\D", "", d or "")
    if len(d) != 14:
        return d
    return "%s.%s.%s/%s-%s" % (d[:2], d[2:5], d[5:8], d[8:12], d[12:])


def _logado(pg):
    """Se ainda estamos na tela de login, o login falhou."""
    return "login" not in (pg.url or "").lower()


def _tenta_login(pg, base, usuario, senha):
    pg.goto(base + "/notafiscal/paginas/login/login.jsf",
            wait_until="domcontentloaded", timeout=TIMEOUT)
    # O portal tem 3 formas de entrar; usamos "Acesso via senha" (CPF/CNPJ).
    # Certificado digital exige Java com drivers — não serve para automação.
    pg.fill("input[id*='cpfCnpj'], input[name*='cpfCnpj'], input[type='text']", usuario)
    pg.fill("input[type='password']", senha)
    pg.click("button[type='submit'], input[type='submit']")
    pg.wait_for_load_state("domcontentloaded", timeout=TIMEOUT)
    pg.wait_for_timeout(2000)
    return _logado(pg)


def _login(pg, base):
    """Entra no portal. O campo de CNPJ pode ter máscara, então tenta SÓ
    DÍGITOS e, se não entrar, tenta FORMATADO. Evita depender de adivinhação
    sobre o comportamento da máscara."""
    usuario = os.environ.get("NFSE_PORTAL_USUARIO") or _usuario_padrao()
    senha = os.environ.get("NFSE_PORTAL_SENHA", "")
    if not senha:
        raise SystemExit(
            "defina NFSE_PORTAL_SENHA no .env (o usuário é o CNPJ, já tem padrão)")

    digitos = re.sub(r"\D", "", usuario)
    for rotulo, valor in (("só dígitos", digitos), ("formatado", _formata_cnpj(digitos))):
        if valor == digitos and rotulo == "formatado":
            break      # CNPJ inválido; não adianta repetir
        try:
            if _tenta_login(pg, base, valor, senha):
                print("  login OK (CNPJ %s)" % rotulo)
                return
            print("  login falhou com CNPJ %s, tentando outro formato" % rotulo,
                  file=sys.stderr)
        except Exception as exc:
            print("  login (%s) deu erro: %s" % (rotulo, type(exc).__name__),
                  file=sys.stderr)
    raise SystemExit("não consegui entrar no portal — confira NFSE_PORTAL_SENHA "
                     "e se o usuário é mesmo o CNPJ")


def coleta(numeros, debug=False):
    """Abre o portal e devolve {numero: codigo} para as notas pedidas.

    Qualquer nota que não render código fica FORA do dicionário — o chamador
    trata como pendente. Nunca inventa valor.
    """
    from playwright.sync_api import sync_playwright

    base = PORTAIS[AMBIENTE]
    achados = {}

    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
        )
        pg = b.new_context().new_page()

        # A interceptação é o coração do script: o portal, ao exibir o DANFSE,
        # chama o endpoint público com o código na URL. Escutamos requests E
        # responses porque dependendo do caso o PDF vem por iframe/XHR.
        capturados = []

        def ver(url):
            m = RE_CODIGO.search(url or "")
            if m:
                capturados.append((url, m.group(1)))

        pg.on("request", lambda r: ver(r.url))
        pg.on("response", lambda r: ver(r.url))

        try:
            _login(pg, base)
            for numero in numeros:
                capturados.clear()
                try:
                    _abrir_nota(pg, base, str(numero))
                except Exception as exc:
                    print("  nota %s: falhou ao abrir (%s)" % (numero, type(exc).__name__),
                          file=sys.stderr)
                if debug:
                    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
                    pg.screenshot(path=str(DEBUG_DIR / ("portal_%s.png" % numero)),
                                  full_page=True)
                    (DEBUG_DIR / ("portal_%s.html" % numero)).write_text(
                        pg.content(), encoding="utf-8")
                    print("  debug salvo em %s" % DEBUG_DIR, file=sys.stderr)
                if capturados:
                    url, cod = capturados[-1]
                    # confere que a URL é mesmo da nota pedida, e não de outra
                    if ("/numeroNota/%s/" % numero) in url:
                        achados[str(numero)] = cod
                        print("  nota %s: código %s" % (numero, cod))
                    else:
                        print("  nota %s: código capturado é de OUTRA nota — descartado"
                              % numero, file=sys.stderr)
                else:
                    print("  nota %s: nenhum código capturado" % numero, file=sys.stderr)
        finally:
            b.close()
    return achados


def _abrir_nota(pg, base, numero):
    """Navega até a nota e dispara a visualização do DANFSE.

    ⚠️ Esta é a parte FRÁGIL: depende do layout do portal. Se eles mudarem a
    tela, só esta função quebra — e quebra ruidosamente, sem código capturado.
    Use --debug para ver screenshot e HTML e reajustar os seletores.
    """
    pg.goto(base + "/notafiscal/paginas/notafiscal/notaFiscalList.jsf",
            wait_until="domcontentloaded", timeout=TIMEOUT)
    # filtra pelo número da nota
    for sel in ("input[id*='numeroNota']", "input[id*='numero']", "input[type='text']"):
        try:
            pg.fill(sel, numero, timeout=4000)
            break
        except Exception:
            continue
    for sel in ("button:has-text('Pesquisar')", "button:has-text('Consultar')",
                "input[value*='Pesquisar']"):
        try:
            pg.click(sel, timeout=4000)
            break
        except Exception:
            continue
    pg.wait_for_timeout(2500)
    # abre o menu Ações da linha e pede a visualização
    for sel in ("button:has-text('Ações')", "a:has-text('Ações')"):
        try:
            pg.click(sel, timeout=4000)
            break
        except Exception:
            continue
    pg.wait_for_timeout(800)
    for sel in ("a:has-text('Visualizar')", "a:has-text('Imprimir')",
                "button:has-text('Visualizar')", "button:has-text('Imprimir')"):
        try:
            pg.click(sel, timeout=4000)
            break
        except Exception:
            continue
    pg.wait_for_timeout(4000)   # dá tempo do PDF ser requisitado


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    debug = "--debug" in sys.argv

    if "--listar" in sys.argv:
        mapa = carrega()
        print(json.dumps(mapa, ensure_ascii=False, indent=2) if mapa
              else "nenhum código coletado ainda")
        return 0

    if not args:
        print(__doc__.split("Uso:")[1], file=sys.stderr)
        return 2

    print("coletando códigos de %d nota(s) em %s" % (len(args), AMBIENTE))
    achados = coleta(args, debug=debug)
    if achados:
        mapa = carrega()
        mapa.update(achados)
        grava(mapa)
    faltaram = [n for n in args if str(n) not in achados]
    print("coletados: %d de %d" % (len(achados), len(args)))
    if faltaram:
        print("SEM CÓDIGO (PDF fica pendente): %s" % ", ".join(faltaram), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
