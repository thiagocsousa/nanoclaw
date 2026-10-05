#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Marca uma consulta na agenda da Dra. Marina (iClinic). ESCREVE.

## O que este script NÃO faz, e por quê

Não remarca e não cancela. Decisão do Thiago em 04/10/2026, pelo critério do que
o erro causa: marcar é **aditivo** — errar cria um horário a mais, que se apaga.
Remarcar e cancelar são destrutivos, e erram apagando ou movendo a consulta de
alguém que vai aparecer na clínica no dia. Esses dois escalam para a recepção.

## Como foi descoberto o formato

Observando o formulário real em 05/10/2026, com o Thiago presente. O modal de
"Novo Agendamento" é um form Django **sem atributo `action`**, e form sem action
envia para a URL do documento. Mas a aplicação **intercepta o submit** e faz um
XHR para `POST /agenda/criar-evento/{PHYSICIAN_ID}/`: eu inferi `/agenda/` pela
regra do HTML e tomei 405 duas vezes. Os nomes dos campos e os ids vieram do DOM.

⚠️ **Verificado só para paciente JÁ CADASTRADO.** O POST que funcionou levava
`patient` com id, escolhido no autocomplete. Que `patient` vazio mais
`update_patient=true` cadastre pelo `patient_name` é plausível pelos nomes dos
campos e **não foi medido**.

## A trava que substitui a confirmação humana

`--verificar` relê a agenda **antes** (a vaga está livre?) e **depois** (ficou
ocupada?). É isso que fecha a janela entre oferecer e marcar, onde mora a
colisão de dois pacientes no mesmo horário. Uma pessoa confirmando minutos
depois não fecharia essa janela.

Uso:
  iclinic_marcar.py --nome "Fulano de Tal" --data 2026-10-05 --inicio 11:30 \
      --fim 12:00 --perfil particular [--telefone 86999999999] [--dry-run]

Saída: texto legível + última linha JSON {"wakeAgent": false, "ok": bool, ...}.
"""
import argparse
import json
import os
import sys
from datetime import date, datetime

BASE = "https://app.iclinic.com.br"
EMAIL = os.environ.get("ICLINIC_EMAIL")
SENHA = os.environ.get("ICLINIC_PASSWORD")
CLINIC_ID = os.environ.get("ICLINIC_CLINIC_ID", "263255")
PHYSICIAN_ID = os.environ.get("ICLINIC_PHYSICIAN_ID", "284806")

# Ids lidos do próprio formulário em 05/10/2026. Mudaram? O script avisa, porque
# o POST volta com erro e a verificação pega — não marca errado em silêncio.
CONVENIOS = {
    "particular": "520537",
    "unimed": "523032",
    "ipmt": "807564",
    "plamta": "701362",
}

# perfil do iclinic_vagas.py -> procedimento no iClinic. Fonte única: mexeu num,
# confira o outro.
PROCEDIMENTOS = {
    "particular": "1468375",            # CONSULTA PARTICULAR
    "particular-cirurgia": "1468371",   # CONSULTA PARTICULAR CIRURGIA
    "particular-desconto": "1526839",   # CONSULTA PARTICULAR COM DESCONTO
    "unimed": "1157702",                # CONSULTA UNIMED
    "unimed-cirurgia": "1468369",       # CONSULTA UNIMED CIRURGIA
}

# Qual convênio cada perfil usa. Separado do procedimento de propósito: são dois
# campos distintos no formulário e errar a correspondência é errar a cobrança.
CONVENIO_DO_PERFIL = {
    "particular": "particular",
    "particular-cirurgia": "particular",
    "particular-desconto": "particular",
    "unimed": "unimed",
    "unimed-cirurgia": "unimed",
}


def responder(linhas, **extra):
    for l in linhas:
        print(l)
    print(json.dumps({"wakeAgent": False, **extra}, ensure_ascii=False))


def eventos_do_dia(pg, headers, ds):
    """Eventos da agenda num dia. Usado para verificar antes e depois."""
    r = pg.request.get(f"{BASE}/agenda/{PHYSICIAN_ID}/{ds}/?clinic={CLINIC_ID}&slide=1",
                       headers=headers, timeout=25000)
    if r.status != 200:
        raise RuntimeError(f"agenda respondeu HTTP {r.status}")
    return [e for e in r.json().get("events", []) if (e.get("date") or "")[:10] == ds]


def ocupa(ev, ds, hhmm):
    """O evento cobre exatamente este começo? Comparação por string do horário."""
    d = (ev.get("date") or "")
    return d[:10] == ds and d[11:16] == hhmm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nome", required=True)
    ap.add_argument("--paciente-id", required=True,
                    help="id do paciente no iClinic. Cadastrar paciente novo por "
                         "este script ainda NÃO foi verificado.")
    ap.add_argument("--data", required=True, help="ISO: 2026-10-05")
    ap.add_argument("--inicio", required=True, help="HH:MM")
    ap.add_argument("--fim", required=True, help="HH:MM")
    ap.add_argument("--perfil", required=True, choices=sorted(PROCEDIMENTOS))
    ap.add_argument("--telefone", default="")
    ap.add_argument("--email", default="")
    ap.add_argument("--observacao", default="")
    ap.add_argument("--dry-run", action="store_true",
                    help="valida e mostra o que enviaria, sem escrever")
    a = ap.parse_args()

    try:
        d = date.fromisoformat(a.data)
        datetime.strptime(a.inicio, "%H:%M")
        datetime.strptime(a.fim, "%H:%M")
    except ValueError as exc:
        responder([f"Entrada inválida: {exc}"], ok=False, erro="entrada_invalida")
        return 2

    convenio = CONVENIOS[CONVENIO_DO_PERFIL[a.perfil]]
    campos = {
        "locked_procedure": "false",
        "procedures[0][id]": PROCEDIMENTOS[a.perfil],
        "procedures[0][quantity]": "1",
        "patient_name": a.nome,
        "patient": a.paciente_id,          # id existente; ver aviso no cabeçalho
        "patient_mobile_phone": a.telefone,
        "patient_home_phone": "",
        "patient_email": a.email,
        "insurance": convenio,
        "date": d.strftime("%d/%m/%Y"),    # o formulário usa DD/MM/AAAA
        "start_time": a.inicio,
        "end_time": a.fim,
        "recurrence": "",
        "end_recurrence": "",
        "description": a.observacao,
        "status": "sc",
        "physician": PHYSICIAN_ID,
        "clinic": CLINIC_ID,
        "is_telemedicine": "false",
        "update_patient": "true",
    }

    if a.dry_run:
        mostrar = dict(campos)
        mostrar["patient_name"] = "<nome>"
        mostrar["patient_mobile_phone"] = "<telefone>" if a.telefone else ""
        responder(["Dry-run: nada foi escrito.", "",
                   f"Enviaria para POST /agenda/criar-evento/{PHYSICIAN_ID}/:"] +
                  [f"   {k} = {v}" for k, v in mostrar.items()],
                  ok=None, dry_run=True)
        return 0

    # Credencial só é exigida na hora de ir à rede: o dry-run roda em qualquer
    # lugar, inclusive na máquina de quem está escrevendo o código.
    if not EMAIL or not SENHA:
        responder(["Sem credenciais do iClinic no ambiente."], ok=False, erro="sem_credenciais")
        return 2

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"))
        try:
            ctx = br.new_context()
            pg = ctx.new_page()
            pg.goto(f"{BASE}/", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', EMAIL)
            pg.fill('input[name="password"]', SENHA)
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=25000):
                pg.click('button[type="submit"]')
            pg.wait_for_timeout(3000)
            csrf = next((c["value"] for c in ctx.cookies() if c["name"] == "csrftoken"), "")
            if not csrf:
                responder(["Não achei o cookie csrftoken: login provavelmente falhou."],
                          ok=False, erro="sem_csrf")
                return 1
            leitura = {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}

            # ANTES: a vaga tem que estar livre. Sem isso não escrevo.
            try:
                antes = eventos_do_dia(pg, leitura, a.data)
            except RuntimeError as exc:
                responder([f"Não consegui ler a agenda antes de marcar: {exc}",
                           "NÃO escrevi nada."], ok=False, erro="agenda_ilegivel")
                return 1
            if any(ocupa(e, a.data, a.inicio) for e in antes):
                responder([f"{a.inicio} de {a.data} JÁ está ocupado. Não marquei."],
                          ok=False, erro="vaga_tomada")
                return 1

            campos["csrfmiddlewaretoken"] = csrf
            r = pg.request.post(
                f"{BASE}/agenda/criar-evento/{PHYSICIAN_ID}/",
                form=campos,
                # A rota de criação é XHR: foi assim que o navegador a chamou
                # (medido em 05/10/2026). Sem este cabeçalho, outra rota.
                headers={"X-Requested-With": "XMLHttpRequest",
                         "X-CSRFToken": csrf,
                         "Referer": f"{BASE}/agenda/",
                         "Origin": BASE},
                timeout=30000)
            corpo = ""
            try:
                corpo = r.text()[:400]
            except Exception:
                pass

            # DEPOIS: a verdade é a agenda, não o status HTTP. Um 200 com erro de
            # validação no corpo seria indistinguível de sucesso sem isto.
            pg.wait_for_timeout(1500)
            try:
                depois = eventos_do_dia(pg, leitura, a.data)
            except RuntimeError as exc:
                responder([f"POST devolveu HTTP {r.status}, mas não consegui reler a agenda: {exc}",
                           "ESTADO INCERTO: confira à mão antes de tentar de novo."],
                          ok=None, erro="verificacao_falhou", http=r.status)
                return 1

            criado = [e for e in depois if ocupa(e, a.data, a.inicio)]
            if criado:
                responder([f"Marcado: {a.data} {a.inicio}–{a.fim}, perfil {a.perfil}."],
                          ok=True, http=r.status, evento_id=criado[0].get("id"),
                          eventos_no_horario=len(criado))
                return 0
            responder([f"POST devolveu HTTP {r.status} e a vaga continua livre: NÃO marcou.",
                       f"Trecho da resposta: {corpo[:200]}"],
                      ok=False, erro="nao_criou", http=r.status)
            return 1
        finally:
            br.close()


if __name__ == "__main__":
    sys.exit(main())
