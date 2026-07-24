#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kane (oficial, Dr. Jack Kane) via iolformula.com — SEM navegador, SEM captcha,
SEM proxy. Só um POST /api/ com o cookie de aceite (token fixo). Substitui o
ESCRS/2captcha. ~1s por cálculo.

Entrada (drop-in do escrs_calc.py) — JSON no argv[1]:
  {"eye":"OD","patient":"NOME","gender":"Female",
   "k1":{"d":44.00,"mm":7.68,"axis":173},"k2":{"d":45.25,"mm":7.45,"axis":83},
   "cyl":-1.25,"al":22.57,"acd":3.30,"lt":4.17,"cct":498,"target":0,
   # A-CONSTANT **ou** LENTE (um ou outro):
   "aconstant":118.98,            # opção 1: constante direta (ioltype=0)
   "iol":"Alcon SN60WF",          # opção 2: nome EXATO da lente no iolformula
   "toric":true,"sia":0.15,"incision_axis":135,
   "kindex":1.3375}               # opcional (default 1.3375)

Saída: {"ok":true,"kane":{recomendado{power,refracao}, vizinhos{acima,abaixo},
        a_constant, toric{cilindro,eixo,residual}|null}}  — ou {"ok":false,"aviso":...}

Nota: o Kane do iolformula usa gênero (NÃO usa idade). Gênero é obrigatório.
Se o cookie de aceite mudar um dia, re-derive com o fluxo headful (aceitar o termo)
e atualize AGREEMENT_COOKIE.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from biometria_verify import verify  # noqa: E402

API = "https://www.iolformula.com/api/"
HOME = "https://www.iolformula.com/"
# Token de aceite do termo — fixo/universal (gateia o acesso; não é por sessão).
AGREEMENT_COOKIE = os.environ.get("IOLFORMULA_COOKIE", "6c19c21753a542fc14ec004f945aee56")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"


def _out(d):
    print(json.dumps(d, ensure_ascii=False))
    return d


def _num(x):
    """String/num -> float; vazio -> ''. O site exige tipos numéricos no JSON."""
    if x is None or x == "":
        return ""
    if isinstance(x, (int, float)):
        return x
    return float(str(x).strip().replace(",", "."))


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def _session():
    import requests
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "X-Requested-With": "XMLHttpRequest"})
    s.cookies.set("agreement", AGREEMENT_COOKIE, domain="www.iolformula.com")
    return s


def fetch_ioltypes(s):
    """Lê o mapa de lentes ao vivo: {'v1':['Alcon SN60WF',118.98,sifitype,toricflag],...}."""
    r = s.get(HOME, timeout=30)
    m = re.search(r"ioltypes\s*=\s*(\{.*?\})\s*;", r.text, re.S)
    if not m:
        return None
    return json.loads(m.group(1))


def resolve_lens(inp, ioltypes):
    """Regra 'um OU outro':
       - se vier `aconstant`  -> ioltype=0 (custom) + essa constante.
       - senão, se vier `iol` -> casa com a lista do site (nome exato/normalizado),
         usa o ioltype/sifitype dele e a A-constant default (ou o override de `aconstant`).
       Retorna (ioltype, ioltype_str, sifitype, aconstant) ou (None, aviso)."""
    acon = inp.get("aconstant")
    iol = inp.get("iol") or inp.get("lens")
    if acon not in (None, ""):
        try:
            a = _num(acon)
        except Exception:
            return None, f"A-constant inválida: {acon!r}"
        if not (100 <= a <= 130):
            return None, f"A-constant fora da faixa plausível (110–125): {a}"
        # se também veio lente, tenta pegar sifitype/ioltype dela mantendo a A custom
        if iol and ioltypes:
            for k, v in ioltypes.items():
                if k != "v0" and _norm(v[0]) == _norm(iol):
                    return (k[1:], v[0], v[2], a), None
        return ("0", "", 0, a), None
    if iol:
        if not ioltypes:
            return None, "iolformula: não consegui carregar a lista de lentes do site."
        for k, v in ioltypes.items():
            if k != "v0" and _norm(v[0]) == _norm(iol):
                return (k[1:], v[0], v[2], _num(v[1])), None
        nomes = [v[0] for k, v in ioltypes.items() if k != "v0"]
        return None, ("iolformula: lente '%s' não está na lista do site. "
                      "Passe a A-constant, ou o nome exato. Ex.: %s"
                      % (iol, ", ".join(nomes[:6]) + "…"))
    return None, "Informe a lente (`iol`) OU a A-constant (`aconstant`) — um dos dois."


def _empty_eye():
    return {"nontoric": 1, "toric": 0, "keratoconus": 0, "aconstant": "", "ioltype": "0",
            "ioltype_str": "", "sifitype": 0, "target_ref": 0.0, "al": "", "k1": "", "k2": "",
            "acd": "", "lt": "", "cct": "", "al_t": "", "k1_t": "", "k2_t": "", "acd_t": "",
            "lt_t": "", "cct_t": "", "k1_t_axis": "", "k2_t_axis": "", "sia": "", "inc": "",
            "is_set": False, "is_valid": True}


def build_eye(inp, ioltype, ioltype_str, sifitype, aconstant):
    toric = bool(inp.get("toric"))
    e = _empty_eye()
    e.update({"nontoric": 0 if toric else 1, "toric": 1 if toric else 0,
              "keratoconus": 1 if inp.get("keratoconus") else 0,
              "aconstant": _num(aconstant), "ioltype": str(ioltype),
              "ioltype_str": ioltype_str, "sifitype": sifitype,
              "target_ref": _num(inp.get("target", 0)), "is_set": True, "is_valid": True})
    k1, k2 = inp["k1"], inp["k2"]
    if toric:
        e.update({"al_t": _num(inp["al"]), "k1_t": _num(k1["d"]), "k2_t": _num(k2["d"]),
                  "acd_t": _num(inp["acd"]), "lt_t": _num(inp.get("lt", "")),
                  "cct_t": _num(inp.get("cct", "")), "k1_t_axis": _num(k1.get("axis", "")),
                  "k2_t_axis": _num(k2.get("axis", "")), "sia": _num(inp.get("sia", "")),
                  "inc": _num(inp.get("incision_axis", ""))})
    else:
        e.update({"al": _num(inp["al"]), "k1": _num(k1["d"]), "k2": _num(k2["d"]),
                  "acd": _num(inp["acd"]), "lt": _num(inp.get("lt", "")),
                  "cct": _num(inp.get("cct", ""))})
    return e


def parse_res(eye, target):
    """Do retorno do site: escada `data`=[[power,ref]...], `data_sh`=[[sugerida]];
       tórico: `data2`=[[cyl,resid,axis]...], `data_ch`=[[cyl_sug]], `data3`=[[eixo_sug]]."""
    data = eye.get("data") or []
    if not data:
        return None
    ladder = [(float(p), float(r)) for p, r in data]
    sug_pow = float(eye["data_sh"][0][0]) if eye.get("data_sh") else None
    rec = {"power": None, "refracao": None}
    viz = {"acima": None, "abaixo": None}
    if sug_pow is not None:
        idx = min(range(len(ladder)), key=lambda i: abs(ladder[i][0] - sug_pow))
        rec = {"power": ladder[idx][0], "refracao": round(ladder[idx][1], 2)}
        if idx > 0:  # potências vêm em ordem decrescente -> "acima" é o índice anterior
            viz["acima"] = {"power": ladder[idx - 1][0], "refracao": round(ladder[idx - 1][1], 2)}
        if idx < len(ladder) - 1:
            viz["abaixo"] = {"power": ladder[idx + 1][0], "refracao": round(ladder[idx + 1][1], 2)}
    toric = None
    if eye.get("data2"):
        cyl_sug = float(eye["data_ch"][0][0]) if eye.get("data_ch") else None
        axis_sug = round(float(eye["data3"][0][0]), 1) if eye.get("data3") else None
        row = None
        if cyl_sug is not None:
            for c, resid, ax in eye["data2"]:
                if abs(float(c) - cyl_sug) < 1e-6:
                    row = (float(c), round(float(resid), 2), round(float(ax), 1)); break
        if row:
            toric = {"cilindro": row[0], "residual": row[1], "eixo": axis_sug or row[2]}
        elif cyl_sug is not None:
            toric = {"cilindro": cyl_sug, "residual": None, "eixo": axis_sug}
    return {"recomendado": rec, "vizinhos": viz, "toric": toric}


def run(inp):
    erros = verify(inp)
    if erros:
        return {"ok": False, "aviso": "Não pude confirmar a leitura do exame (não vou calcular): "
                + "; ".join(erros)}
    gender = str(inp.get("gender", "")).strip().lower()
    if gender.startswith("m") or gender in ("masculino", "male"):
        is_male, is_female = 1, 0
    elif gender.startswith("f") or gender in ("feminino", "female"):
        is_male, is_female = 0, 1
    else:
        return {"ok": False, "aviso": "iolformula/Kane: falta o sexo (o Kane usa gênero)."}

    try:
        s = _session()
        ioltypes = fetch_ioltypes(s)
    except Exception as e:
        return {"ok": False, "aviso": f"iolformula: não abriu o site ({type(e).__name__}) — tentar de novo."}

    resolved, err = resolve_lens(inp, ioltypes)
    if err:
        return {"ok": False, "aviso": err}
    ioltype, ioltype_str, sifitype, aconstant = resolved

    kindex = _num(inp.get("kindex", 1.3375))
    eye1 = build_eye(inp, ioltype, ioltype_str, sifitype, aconstant)
    mx = {"surgeon_name": "", "patient_name": str(inp.get("patient", "")), "id": "",
          "kindex": kindex, "is_male": is_male, "is_female": is_female,
          "eye1": eye1, "eye2": _empty_eye()}
    z = {"mx": json.dumps(mx), "jx_action": "wh"}
    try:
        r = s.post(API, data={"action": "kfapi", "__xr": 1, "z": json.dumps(z)}, timeout=30)
        arr = json.loads(r.text)
    except Exception as e:
        return {"ok": False, "aviso": f"iolformula/Kane: o serviço falhou ({type(e).__name__}) — tentar de novo."}

    vars_ = {it[1]: it[2] for it in arr if isinstance(it, list) and it and it[0] == "vr"}
    res = vars_.get("res")
    if not res or "eye1" not in res:
        return {"ok": False, "aviso": "iolformula/Kane: o site não retornou resultado (confira lente/dados) — tentar de novo."}
    parsed = parse_res(res["eye1"], _num(inp.get("target", 0)))
    if not parsed:
        return {"ok": False, "aviso": "iolformula/Kane: sem tabela de potências no retorno — tentar de novo."}

    kane = {"recomendado": parsed["recomendado"], "vizinhos": parsed["vizinhos"],
            "a_constant": aconstant, "toric": parsed["toric"]}
    return {"ok": True, "kane": kane}


def main():
    if len(sys.argv) < 2:
        _out({"ok": False, "aviso": "uso: iolformula_kane.py '<json>'"}); return
    try:
        inp = json.loads(sys.argv[1])
    except Exception as e:
        _out({"ok": False, "aviso": f"JSON inválido: {e}"}); return
    _out(run(inp))


if __name__ == "__main__":
    main()
