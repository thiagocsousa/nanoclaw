#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Quem é o dono deste telefone no iClinic? Somente leitura.

Existe para a triagem parar de pedir quatro dados a quem a clínica já conhece.
Pedir de novo o que a pessoa já deu é o jeito mais rápido de parecer máquina
(Thiago, 04/10/2026), e com o telefone na mão dá para trocar o formulário por
UMA pergunta de confirmação.

## O telefone identifica uma CASA, não uma pessoa

Medido contra o iClinic real em 07/10/2026: `(86) 98151-2111` devolve DOIS
cadastros, o Thiago e a filha. Por isso este script nunca decide quem é — ele
devolve os candidatos e quem confirma é o paciente, na conversa. Preencher
sozinho a partir do telefone escolheria a pessoa errada e, pior, alimentaria a
conferência de identidade da marcação com um nascimento que não é o dela.

## A máscara não é detalhe

`busca.json?q=` acha por telefone **só com máscara**. Medido no mesmo dia:

    8681512111      -> 0 achados
    86981512111     -> 0 achados
    558681512111    -> 0 achados
    (86) 98151-2111 -> 2 achados

Então o host manda dígitos e quem formata é aqui, num lugar só.

Uso:  iclinic_paciente_por_telefone.py --telefone 558681512111
Saída: JSON com {ok, candidatos: [{id, nome, nascimento, telefone}]}.
"""
import argparse
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = "https://app.iclinic.com.br"
CLINIC_ID = os.environ.get("ICLINIC_CLINIC_ID", "263255")
EMAIL = os.environ.get("ICLINIC_EMAIL")
SENHA = os.environ.get("ICLINIC_PASSWORD")


def so_digitos(s):
    return re.sub(r"\D", "", s or "")


def mascaras(telefone):
    """As formas com máscara que podem achar este número. Lista, nunca uma só.

    ⚠️ O 9º DÍGITO. O JID do WhatsApp do Thiago é `558681512111` — DDI + DDD +
    oito dígitos, sem o 9. O cadastro dele no iClinic é `(86) 98151-2111`, COM
    o 9. Formatando só o que veio, a busca não acha ninguém e o host conclui
    "não é paciente" sobre alguém que é. Meu primeiro rascunho tinha esse bug,
    e um teste de unidade o pegou antes de rodar contra o iClinic.

    Então tentamos as duas: como veio, e com o 9 inserido (ou removido). O
    filtro por sufixo de 8 dígitos depois cuida de não aceitar lixo.

    Ver [[project_jid_resolver_9digito]]: o mesmo dígito já causou mensagem
    enviada e não entregue.
    """
    d = so_digitos(telefone)
    if len(d) >= 12 and d.startswith("55"):
        d = d[2:]
    if len(d) not in (10, 11):
        return []

    ddd, resto = d[:2], d[2:]
    formas = []
    if len(resto) == 9:                       # já tem o 9
        formas.append(resto)
        if resto.startswith("9"):
            formas.append(resto[1:])          # e sem ele
    else:                                     # oito dígitos
        formas.append("9" + resto)            # celular moderno, mais provável
        formas.append(resto)                  # fixo ou cadastro antigo

    saida = []
    for f in formas:
        if len(f) == 9:
            saida.append("(%s) %s-%s" % (ddd, f[:5], f[5:]))
        else:
            saida.append("(%s) %s-%s" % (ddd, f[:4], f[4:]))
    return saida


def responde(ok, **extra):
    print(json.dumps({"wakeAgent": False, "ok": ok, **extra}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--telefone", required=True)
    a = ap.parse_args()

    buscas = mascaras(a.telefone)
    if not buscas:
        responde(False, erro="telefone_invalido", detalhe=a.telefone[:20])
        return 2
    if not EMAIL or not SENHA:
        responde(False, erro="sem_credencial")
        return 2

    with sync_playwright() as p:
        br = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
        )
        try:
            ctx = br.new_context()
            pg = ctx.new_page()
            pg.goto(BASE + "/", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', EMAIL)
            pg.fill('input[name="password"]', SENHA)
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=25000):
                pg.click('button[type="submit"]')
            pg.wait_for_timeout(3000)
            csrf = next(
                (c["value"] for c in ctx.cookies() if c["name"] == "csrftoken"), ""
            )
            achados, h = [], {
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRFToken": csrf,
            }
            for q in buscas:
                r = pg.request.get(
                    "%s/pacientes/busca.json?clinic=%s&q=%s&get_picture=0&limit=20"
                    % (BASE, CLINIC_ID, q),
                    headers=h,
                    timeout=25000,
                )
                if r.status != 200:
                    responde(False, erro="busca_falhou", http=r.status, q=q)
                    return 1
                achados += (r.json() or {}).get("objects") or []
        finally:
            br.close()

    # Só quem tem ESTE telefone. A busca é textual e pode trazer parecido.
    # Sufixo de 8 porque o 9º dígito e o DDI variam, o final não — mesma regra
    # do `busca_paciente` em `iclinic_marcar.py`.
    alvo = so_digitos(a.telefone)[-8:]
    candidatos = [
        {
            "id": o.get("id"),
            "nome": o.get("name") or "",
            "nascimento": o.get("birth_date") or "",
            "telefone": o.get("mobile_phone") or "",
            "falecido": bool(o.get("died")),
        }
        for o in achados
        if so_digitos(o.get("mobile_phone")).endswith(alvo)
    ]
    candidatos = [c for c in candidatos if not c["falecido"]]
    # Duas buscas podem trazer o mesmo cadastro; o id desempata.
    vistos, unicos = set(), []
    for c in candidatos:
        if c["id"] in vistos:
            continue
        vistos.add(c["id"])
        unicos.append(c)
    candidatos = unicos

    # Mais velho primeiro: quem escreve para a clínica tende a ser o adulto
    # titular do telefone, e menor de idade escala de qualquer jeito. É palpite
    # de ORDEM, não de identidade — quem confirma é a pessoa.
    candidatos.sort(key=lambda c: c["nascimento"] or "9999-99-99")
    responde(True, candidatos=candidatos, total=len(candidatos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
