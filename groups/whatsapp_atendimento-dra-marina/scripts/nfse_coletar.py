#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Puller de NFs a emitir (particulares do iClinic) — consulta/exame/yag + cirurgias.

Duas origens:
  - DIRETO (consulta/exame/yag): receita particular PAGA na janela.
  - CIRURGIA: 1 receita de honorário = 1 NF (NÃO soma), pareada por tipo, e só se a
    cirurgia foi REALIZADA na agenda (status sc/cp) na janela. Honorário de cirurgia
    NÃO filtra por insurance (às vezes herda o convênio do paciente).

Tomador: `payer_cpf_cnpj` preenchido → o pagador (PF/PJ); vazio → o paciente (CPF do
cadastro). Sem CPF → item vai em `sem_cpf` (não emitir até preencher).

Dedup CUMULATIVO: receita_id em NFSE_EMITIDAS_FILE é ignorado (o run diário só traz o novo).

Saída: JSON {janela, pendentes, sem_cpf}. Credenciais via env ICLINIC_EMAIL/PASSWORD.
Dep: playwright.
"""
import argparse
import json
import os
import re
import time
import unicodedata
from datetime import date, timedelta
from pathlib import Path

CLINIC_ID = "263255"
PHYS = "284806"
PARTICULAR_INSURANCE_ID = 520537

# Credenciais iClinic: env por padrão; fallback pras mesmas usadas pelos pipelines
# de avaliação/retorno (hardcoded neles) — assim o atendimento não precisa setar env.
ICLINIC_EMAIL = os.environ.get("ICLINIC_EMAIL", "thiagocsousa@gmail.com")
ICLINIC_PASSWORD = os.environ.get("ICLINIC_PASSWORD", "Thiagofei1998#")
EMITIDAS_FILE = Path(os.environ.get("NFSE_EMITIDAS_FILE", "nfse_emitidas.json"))
REALIZADA = {"sc", "cp"}   # status de cirurgia realizada na agenda

MESES = ["january", "february", "march", "april", "may", "june",
         "july", "august", "september", "october", "november", "december"]

# tipo de cirurgia (nome do procedimento) → serviço do emissor
SURG_TYPE = {"CATARATA": "lente_faco", "LASIK": "refrativa",
             "PRK": "refrativa", "PTERIGIO": "pterigio"}


# ─────────────────────────────── helpers ─────────────────────────────────────
def normalize(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().upper()


def only_digits(s):
    return "".join(c for c in (s or "") if c.isdigit())


def _headers(csrf):
    return {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}


def login(pw):
    b = pw.chromium.launch(
        headless=True,
        executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
    )
    ctx = b.new_context()
    pg = ctx.new_page()
    pg.goto("https://app.iclinic.com.br/", wait_until="domcontentloaded")
    pg.fill('input[name="email"]', ICLINIC_EMAIL)
    pg.fill('input[name="password"]', ICLINIC_PASSWORD)
    with pg.expect_navigation(wait_until="domcontentloaded", timeout=20000):
        pg.click('button[type="submit"]')
    pg.wait_for_timeout(3000)
    csrf = next((c["value"] for c in ctx.cookies() if c["name"] == "csrftoken"), "")
    return b, pg, csrf


def fetch_receitas(pg, csrf, month, year, cap=120):
    h = _headers(csrf)
    items, p = [], 1
    while p <= cap:
        url = (f"https://app.iclinic.com.br/financas/busca/"
               f"?clinic={CLINIC_ID}&d={month}&year={year}&kind=r&page={p}")
        r = pg.request.get(url, headers=h)
        try:
            d = r.json()
        except Exception:
            time.sleep(1.0)
            try:
                d = pg.request.get(url, headers=h).json()
            except Exception:
                break
        items += d.get("items", [])
        if not d.get("next_page"):
            break
        p += 1
        time.sleep(0.2)
    return items


# Tomador precisa de CodigoMunicipio (senão L999 "Tomador Não Identificado").
# Só o município já basta; rua/número/CEP são opcionais (melhoram o DANFSE).
TERESINA_IBGE = "2211001"
_IBGE_CACHE = {}   # uf -> {nome_normalizado: codigo_ibge}


def municipio_ibge(pg, csrf, city, uf):
    """Resolve o código IBGE (7 díg) por cidade+UF. Default Teresina (maioria)."""
    city_n = normalize(city)
    uf = (uf or "").strip().upper()
    if not city_n or city_n == "TERESINA":
        return TERESINA_IBGE
    if uf and uf not in _IBGE_CACHE:
        try:
            r = pg.request.get(
                f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios")
            _IBGE_CACHE[uf] = {normalize(m["nome"]): str(m["id"]) for m in r.json()}
        except Exception:
            _IBGE_CACHE[uf] = {}
    return _IBGE_CACHE.get(uf, {}).get(city_n, TERESINA_IBGE)


def _input_val(html, name):
    # O iClinic às vezes emite DOIS value= no mesmo input (o 2º vazio). Pega a tag
    # inteira e o PRIMEIRO value (o real).
    tag = re.search(rf'<(?:input|textarea)[^>]*\bname="{name}"[^>]*>', html)
    if not tag:
        return ""
    v = re.search(r'value="([^"]*)"', tag.group(0))
    return v.group(1).strip() if v else ""


def _select_val(html, name):
    sm = re.search(rf'<select[^>]*name="{name}".*?</select>', html, re.S)
    if not sm:
        return ""
    opt = (re.search(r'<option[^>]*selected[^>]*value="([^"]*)"', sm.group(0))
           or re.search(r'value="([^"]*)"[^>]*selected', sm.group(0)))
    return opt.group(1).strip() if opt else ""


def fetch_patient(pg, csrf, pid):
    """CPF + endereço do cadastro do paciente. Retorna {doc, endereco}
    (endereco sempre com codigo_municipio, default Teresina)."""
    default = {"doc": None, "endereco": {"codigo_municipio": TERESINA_IBGE}}
    if not pid:
        return default
    r = pg.request.get(f"https://app.iclinic.com.br/pacientes/{pid}/", headers=_headers(csrf))
    if r.status != 200:
        return default
    html = r.text()
    doc = None
    for field in ("cpf", "civil_id", "document"):
        v = only_digits(_input_val(html, field))
        if v:
            doc = v
            break
    uf = _select_val(html, "state")
    city = _input_val(html, "city")
    end = {"logradouro": _input_val(html, "address"), "numero": _input_val(html, "number"),
           "complemento": _input_val(html, "complement"), "bairro": _input_val(html, "neighborhood"),
           "uf": uf, "cep": only_digits(_input_val(html, "zip_code")),
           "codigo_municipio": municipio_ibge(pg, csrf, city, uf)}
    tel = only_digits(_input_val(html, "mobile_phone") or _input_val(html, "home_phone")
                      or _input_val(html, "office_phone"))
    return {"doc": doc, "endereco": end, "telefone": tel}


def resolve_tomador(pg, csrf, receita):
    """Pagador (payer_cpf_cnpj) quando presente; senão o próprio paciente.
    O ENDEREÇO é SEMPRE o do paciente (o iClinic não tem o do pagador terceiro)
    — e o município é obrigatório p/ emitir (senão L999)."""
    pat = receita.get("patient") or {}
    info = fetch_patient(pg, csrf, pat.get("id"))   # CPF + endereço + telefone do PACIENTE
    tel = info.get("telefone")   # entrega é SEMPRE no WhatsApp do paciente
    payer_doc = only_digits(receita.get("payer_cpf_cnpj"))
    if payer_doc:
        # terceiro pagou → tomador = pagador (nome/doc dele), endereço do paciente
        return {"origem": "pagador", "nome": receita.get("payer_name"),
                "doc": payer_doc, "tipo": "PJ" if len(payer_doc) == 14 else "PF",
                "endereco": info["endereco"], "telefone": tel}
    return {"origem": "paciente", "nome": pat.get("name"),
            "doc": info["doc"], "tipo": "PF", "endereco": info["endereco"], "telefone": tel}


def categorize_direto(receita):
    """Consulta/exame/yag por nome normalizado. None se não casa (cirurgia/outros)."""
    for pr in receita.get("procedures") or []:
        n = normalize(pr.get("name"))
        if not n:
            continue
        if "MAPEAMENTO" in n:
            return "mapeamento"
        if "TOPOGRAFIA" in n:
            return "topografia"
        if "YAG" in n or "CAPSULOTOMIA" in n:
            return "yag"
        if n.startswith("CONSULTA"):
            return "consulta"
    return None


def surgery_service(procname):
    n = normalize(procname)
    for k, v in SURG_TYPE.items():
        if k in n:
            return v
    return None


def is_honor_receita(r):
    """Receita de honorário/cirurgia (qualquer insurance)."""
    for pr in r.get("procedures") or []:
        n = normalize(pr.get("name"))
        if "HONORARIO" in n or (n.startswith("CIRURGIA") and "CONSULTA" not in n):
            return True
    return False


def semanas(d0, d1):
    out, d, end = [], date.fromisoformat(d0), date.fromisoformat(d1)
    while d <= end:
        out.append(d.isoformat())
        d += timedelta(days=7)
    if out and date.fromisoformat(out[-1]) < end:
        out.append(d1)
    return out


# ─────────────────────────────── coleta ──────────────────────────────────────
def coletar(pg, csrf, d0, d1, emitidas=frozenset()):
    """Retorna {diretos, cirurgias, sem_cpf}. Não emite nada."""
    receitas = fetch_receitas(pg, csrf, MESES[int(d1[5:7]) - 1], int(d1[:4]))
    part = [r for r in receitas if r.get("paid")
            and (r.get("insurance") or {}).get("id") == PARTICULAR_INSURANCE_ID]
    pagas = [r for r in receitas if r.get("paid")]

    diretos, cirurgias, sem_cpf = [], [], []

    # DIRETO — consulta/exame/yag, receita paga na janela
    for r in part:
        pay = (r.get("pay_date") or "")[:10]
        if not (d0 <= pay <= d1) or str(r["id"]) in emitidas:
            continue
        servico = categorize_direto(r)
        if not servico:
            continue
        tom = resolve_tomador(pg, csrf, r)
        item = {"origem": "direto", "receita_id": r["id"], "servico": servico,
                "valor": r.get("value"), "pay_date": pay,
                "paciente": (r.get("patient") or {}).get("name"),
                "patient_id": (r.get("patient") or {}).get("id"), "tomador": tom}
        (sem_cpf if not tom.get("doc") else diretos).append(item)

    # CIRURGIA — índice de realizadas (agenda sc/cp) na janela
    eventos = {}
    for wk in semanas(d0, d1):
        rr = pg.request.get(
            f"https://app.iclinic.com.br/agenda/{PHYS}/{wk}/?clinic={CLINIC_ID}&slide=1",
            headers=_headers(csrf))
        if rr.status == 200:
            for ev in rr.json().get("events", []):
                eventos[ev["id"]] = ev
    realized = {}
    for ev in eventos.values():
        if ev.get("status") not in REALIZADA or not (d0 <= (ev.get("date") or "")[:10] <= d1):
            continue
        pid = (ev.get("patient") or {}).get("id")
        for pr in ev.get("procedures") or []:
            n = normalize((pr.get("procedure") or {}).get("name"))
            if "RETORNO" in n or "CONSULTA" in n:
                continue
            if "HONORARIO" in n or n.startswith("CIRURGIA"):
                realized.setdefault(pid, set()).add(surgery_service(n) or "ANY")

    # 1 receita de honorário = 1 NF (valor>0), gated em cirurgia realizada
    for r in pagas:
        if not is_honor_receita(r) or str(r["id"]) in emitidas:
            continue
        val = float(r.get("value") or 0)
        if val <= 0:
            continue
        pid = (r.get("patient") or {}).get("id")
        rset = realized.get(pid)
        if not rset:
            continue
        tipo = next((surgery_service(pr.get("name")) for pr in (r.get("procedures") or [])
                     if surgery_service(pr.get("name"))), None)
        if not (tipo in rset or tipo is None or "ANY" in rset):
            continue
        tipo_final = tipo or next((t for t in rset if t != "ANY"), None) or "?"
        tom = resolve_tomador(pg, csrf, r)
        item = {"origem": "cirurgia", "receita_id": r["id"], "servico": tipo_final,
                "valor": f"{val:.2f}", "pay_date": (r.get("pay_date") or "")[:10],
                "paciente": (r.get("patient") or {}).get("name"),
                "patient_id": pid, "tomador": tom}
        (sem_cpf if not tom.get("doc") else cirurgias).append(item)

    diretos.sort(key=lambda x: (x["pay_date"], x["paciente"] or ""))
    cirurgias.sort(key=lambda x: (x["pay_date"], x["paciente"] or ""))
    return {"diretos": diretos, "cirurgias": cirurgias, "sem_cpf": sem_cpf}


def main():
    ap = argparse.ArgumentParser(description="Coleta NFs a emitir (iClinic)")
    hoje = date.today().isoformat()
    ap.add_argument("--desde", default=hoje)
    ap.add_argument("--ate", default=hoje)
    args = ap.parse_args()

    emitidas = set(map(str, json.loads(EMITIDAS_FILE.read_text()))) if EMITIDAS_FILE.exists() else set()

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b, pg, csrf = login(pw)
        out = coletar(pg, csrf, args.desde, args.ate, emitidas)
        b.close()
    out["janela"] = [args.desde, args.ate]
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
