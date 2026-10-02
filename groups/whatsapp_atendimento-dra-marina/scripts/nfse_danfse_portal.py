#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Coletor do CÓDIGO DE VERIFICAÇÃO das NFS-e emitidas por DPS. **Fase 5** de
docs/NFSE-DPS-MIGRACAO.md.

## Por que isto existe

O DANFSE (PDF) tem um endpoint PÚBLICO, mas ele exige `codigoVerificacao`, que
a API de DPS **não devolve** (confirmado pela SEMF em 2026-10-02) e que só
aparece dentro do QR do próprio PDF — circular.

Tentamos primeiro interceptar esse código nas requisições do portal. **Não
funciona:** o visualizador do portal não usa o endpoint público. Ele carrega o
PDF de um recurso dinâmico do PrimeFaces, dentro da sessão:

    /notafiscal/jakarta.faces.resource/dynamiccontent.properties.jsf
        ?ln=primefaces&pfdrid=<id gerado no servidor>&pfdrt=sc&...

O `pfdrid` nasce quando a visualização é acionada, então não dá para montar a
URL — tem que capturá-la. Mas aí o código de verificação fica **desnecessário**:
capturada a URL, o PDF vem direto.

    navegador (1x por lote) → captura a URL do recurso → baixa o PDF → paciente

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
DEBUG_DIR = GROUP / "tmp"

PORTAIS = {
    "homologacao": "https://nfse2-the.dsfweb.com.br",
    "producao": "https://notafiscal.teresina.pi.gov.br",
}
AMBIENTE = os.environ.get("NFSE_AMBIENTE", "producao")

TIMEOUT = int(os.environ.get("NFSE_PORTAL_TIMEOUT_MS", "30000"))


# URL do recurso dinâmico que serve o PDF dentro da sessão.
RE_PDF = re.compile(r"dynamiccontent\.properties\.jsf\?[^\"'\s]+")


def _url_pdf(url):
    """Extrai a URL do PDF de uma requisição do portal.

    O visualizador é carregado como `pdfviewer.html.jsf?...&file=<URL do PDF>`,
    então o endereço real vem no parâmetro `file`. Também aceitamos a URL do
    recurso direto, caso ela apareça sozinha.
    """
    if not url:
        return None
    if "pdfviewer.html.jsf" in url and "file=" in url:
        return url.split("file=", 1)[1]
    if "dynamiccontent.properties.jsf" in url and "pfdrid=" in url:
        return url
    return None


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
    """True se saímos da tela de login.

    ⚠️ Não testar `"login" not in url`: o portal, quando o login dá CERTO, vai
    para /paginas/**login**/bemVindo.jsf — a palavra "login" está no caminho do
    diretório. Essa heurística preguiçosa reportava falha num login que
    funcionou. Testamos o arquivo específico.
    """
    return "login.jsf" not in (pg.url or "").lower()


def _tenta_login(pg, base, usuario, senha):
    pg.goto(base + "/notafiscal/paginas/login/login.jsf",
            wait_until="domcontentloaded", timeout=TIMEOUT)
    # Seletores conferidos na página real (2026-10-02). NÃO use genéricos como
    # input[type=text]: a página tem DOIS campos de texto (o segundo é o
    # inputLogin2 do diálogo "Esqueci minha senha") e o Playwright recusa
    # seletor ambíguo em modo estrito.
    # O portal tem 3 formas de entrar; usamos "Acesso Via Senha" (CPF/CNPJ) —
    # certificado digital exige Java com drivers e não serve para automação.
    pg.fill("#inputLogin", usuario, timeout=TIMEOUT)
    pg.fill("#inputPassword", senha, timeout=TIMEOUT)
    # O "botão" é um <a> do PrimeFaces (ui-commandlink), NÃO um <button> — por
    # isso button:has-text(...) dava timeout. O id tem dois-pontos, que quebra
    # seletor CSS, então usamos seletor por atributo.
    pg.click('[id="formLogin:buttonLogin"]', timeout=TIMEOUT)
    pg.wait_for_load_state("domcontentloaded", timeout=TIMEOUT)
    # O login é um commandlink do PrimeFaces: faz POST e só depois redireciona.
    # Em vez de dormir um tempo fixo (3s não bastava), espera a URL mudar.
    try:
        pg.wait_for_url(lambda u: "login.jsf" not in (u or "").lower(), timeout=15000)
    except Exception:
        pass        # se não mudou, _logado() decide
    pg.wait_for_timeout(1500)
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


def baixa(numeros, destino_dir, debug=False):
    """Baixa o DANFSE de cada nota e devolve {numero: caminho_do_pdf}.

    Nota que não render PDF fica FORA do dicionário — o chamador trata como
    pendente e avisa no resumo. Nunca devolve arquivo pela metade: só grava
    depois de confirmar que os bytes começam com %PDF.
    """
    from playwright.sync_api import sync_playwright

    base = PORTAIS[AMBIENTE]
    destino = Path(destino_dir)
    destino.mkdir(parents=True, exist_ok=True)
    achados = {}

    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
        )
        ctx = b.new_context()
        pg = ctx.new_page()

        capturadas = []
        pg.on("request", lambda r: capturadas.append(r.url))
        pg.on("response", lambda r: capturadas.append(r.url))

        try:
            _login(pg, base)
            for numero in numeros:
                numero = str(numero)
                capturadas.clear()
                try:
                    _abrir_nota(pg, base, numero)
                except Exception as exc:
                    # "TimeoutError" não diz nada a quem lê o log. A causa
                    # quase sempre é a nota não estar na listagem ATIVA —
                    # cancelada, substituída, ou fora da primeira página.
                    print("  nota %s: não encontrada na listagem — cancelada, "
                          "substituída ou fora da 1ª página? (%s)"
                          % (numero, type(exc).__name__), file=sys.stderr)
                if debug:
                    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
                    pg.screenshot(path=str(DEBUG_DIR / ("portal_%s.png" % numero)),
                                  full_page=True)
                    (DEBUG_DIR / ("portal_%s.html" % numero)).write_text(
                        pg.content(), encoding="utf-8")

                alvo = next((u for u in (_url_pdf(x) for x in reversed(capturadas)) if u), None)
                if not alvo:
                    print("  nota %s: não achei a URL do PDF" % numero, file=sys.stderr)
                    continue
                try:
                    # mesma sessão do navegador => os cookies vão junto
                    resp = ctx.request.get(alvo, timeout=TIMEOUT)
                    corpo = resp.body()
                except Exception as exc:
                    # Mensagem completa, não só o tipo: "(Error)" não diz nada a
                    # quem for investigar por que um paciente ficou sem PDF.
                    print("  nota %s: download falhou — %s: %s"
                          % (numero, type(exc).__name__,
                             str(exc).split("\n")[0][:160]), file=sys.stderr)
                    continue
                if not corpo.startswith(b"%PDF"):
                    print("  nota %s: resposta não é PDF (%d bytes)" % (numero, len(corpo)),
                          file=sys.stderr)
                    continue
                caminho = destino / ("nota_%s.pdf" % numero)
                caminho.write_bytes(corpo)
                achados[numero] = str(caminho)
                print("  nota %s: PDF salvo (%d KB)" % (numero, len(corpo) // 1024))
        finally:
            b.close()
    return achados


def _abrir_nota(pg, base, numero):
    """Abre a nota na listagem e dispara a visualização do DANFSE.

    ⚠️ Parte FRÁGIL: depende do layout do portal. Falha ruidosamente (sem PDF),
    nunca em silêncio. Use --debug para screenshot + HTML.

    NÃO usamos o campo de busca: o botão "Pesquisar" não é alcançável por
    texto (é ícone/commandlink do PrimeFaces) e os ids do JSF são gerados
    (frmNotaFiscalList:j_idt97), mudando a cada ajuste de layout deles. Como a
    listagem já traz as notas recentes — que é o caso de uma nota recém-emitida
    — localizamos a LINHA pelo número e agimos nela.
    """
    pg.goto(base + "/notafiscal/paginas/notafiscal/notaFiscalList.jsf",
            wait_until="domcontentloaded", timeout=TIMEOUT)
    pg.wait_for_timeout(2500)

    linha = pg.locator("tr", has_text=numero).first
    linha.wait_for(state="visible", timeout=TIMEOUT)
    linha.get_by_text("Ações", exact=True).first.click(timeout=TIMEOUT)

    # O menu da linha renderiza por AJAX: com 1,2s ele ainda não existia e o
    # clique caía fora. Em vez de dormir mais, ESPERAMOS o item aparecer.
    # Nada de fallback para "Imprimir": aquele é o menu de exportação da LISTA
    # (CSV/PDF/XLS) no topo da tela, e clicar nele abre a caixa errada.
    # ⚠️ Existe um span "Visualizar" POR LINHA da tabela, quase todos ocultos.
    # get_by_text(...).first pega o primeiro do DOM, que é oculto, e o clique
    # nunca acontece ("locator resolved to hidden span"). Filtramos por :visible
    # para pegar o item do menu que acabou de abrir.
    item = pg.locator("span.ui-menuitem-text:visible", has_text="Visualizar").first
    item.wait_for(state="visible", timeout=TIMEOUT)
    item.click(timeout=TIMEOUT)

    # o PDF é pedido por XHR/iframe; é essa requisição que carrega o pfdrid
    pg.wait_for_timeout(7000)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    debug = "--debug" in sys.argv
    if not args:
        print("uso: nfse_danfse_portal.py <numero> [...] [--debug]", file=sys.stderr)
        return 2
    destino = os.environ.get("NFSE_DANFSE_DIR", str(GROUP / "attachments"))
    print("baixando DANFSE de %d nota(s) em %s" % (len(args), AMBIENTE))
    achados = baixa(args, destino, debug=debug)
    print("baixados: %d de %d" % (len(achados), len(args)))
    faltaram = [n for n in args if str(n) not in achados]
    if faltaram:
        print("SEM PDF (fica pendente): %s" % ", ".join(faltaram), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
