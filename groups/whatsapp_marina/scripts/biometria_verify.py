#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Harness de verificação da biometria extraída do exame (anti-invenção / anti-erro).

A extração dos números é feita pelo agente (visão) — que pode ler errado. Este
módulo é um PORTÃO DETERMINÍSTICO: confere os valores contra a REDUNDÂNCIA interna
do próprio exame. Se algo não fecha, os calculadores se RECUSAM a computar e o
agente deve informar quais campos não puderam ser confirmados (nunca chutar).

Checagens:
  1. Checksum D↔raio de cada K: raio(mm) = (n-1)*1000 / D  (n=1.3375 → 337.5/D).
     É o mais forte — o exame imprime as duas unidades; um dígito inventado não bate.
  2. Cilindro corneano ≈ |K1 - K2| (D).
  3. Eixos de K1/K2 ~ortogonais (~90° de diferença).
  4. Faixas fisiológicas de todos os campos.

verify(inp) -> lista de erros (vazia = ok).
"""


def verify(inp):
    erros = []
    n = float(inp.get("keratometric_index", 1.3375))
    kconst = (n - 1.0) * 1000.0  # 1.3375 -> 337.5

    def rng(name, v, lo, hi, unit=""):
        if v is None or v == "":
            return
        try:
            f = float(v)
        except Exception:
            erros.append(f"{name}: valor não numérico ('{v}')")
            return
        if not (lo <= f <= hi):
            erros.append(f"{name}={f}{unit} fora da faixa fisiológica [{lo}–{hi}{unit}]")

    # 1) K1/K2: faixa + checksum D↔mm (exige o raio em mm — a redundância)
    for tag in ("k1", "k2"):
        k = inp.get(tag) or {}
        d, mm = k.get("d"), k.get("mm")
        if d is None:
            erros.append(f"{tag.upper()}: falta a dioptria (D)")
            continue
        rng(f"{tag.upper()} (D)", d, 38.0, 50.0, " D")
        if mm is None:
            erros.append(f"{tag.upper()}: falta o raio em mm (necessário p/ conferência D↔mm)")
            continue
        try:
            d_f, mm_f = float(d), float(mm)
            esperado = kconst / d_f
            if abs(esperado - mm_f) > 0.05:
                erros.append(f"{tag.upper()} não confere: {d_f} D ⇒ {esperado:.2f} mm, "
                             f"mas leu {mm_f} mm (dif {abs(esperado - mm_f):.2f})")
        except Exception:
            erros.append(f"{tag.upper()}: D/mm não numéricos")

    d1 = (inp.get("k1") or {}).get("d")
    d2 = (inp.get("k2") or {}).get("d")

    # 2) cilindro ≈ |K1 - K2|
    cyl = inp.get("cyl")
    if cyl not in (None, "") and d1 is not None and d2 is not None:
        try:
            dcyl = abs(float(d1) - float(d2))
            if abs(abs(float(cyl)) - dcyl) > 0.15:
                erros.append(f"Cyl não confere: |K1−K2|={dcyl:.2f} D, mas leu Cyl={cyl} D")
        except Exception:
            pass

    # 3) eixos ~ortogonais
    a1 = (inp.get("k1") or {}).get("axis")
    a2 = (inp.get("k2") or {}).get("axis")
    if a1 is not None and a2 is not None:
        try:
            a1f, a2f = float(a1) % 180, float(a2) % 180
            for nm, a in (("K1", a1f), ("K2", a2f)):
                if not (0 <= a <= 180):
                    erros.append(f"eixo {nm}={a}° fora de [0–180]")
            dd = abs(a1f - a2f) % 180
            dd = min(dd, 180 - dd)
            if abs(dd - 90) > 15:
                erros.append(f"eixos não ortogonais: K1@{a1f:.0f}° e K2@{a2f:.0f}° "
                             f"(diferença {dd:.0f}°, esperado ~90°) — confira a leitura")
        except Exception:
            pass

    # 4) faixas dos demais
    rng("AL", inp.get("al"), 18.0, 30.0, " mm")
    rng("ACD", inp.get("acd"), 2.0, 5.0, " mm")
    rng("LT", inp.get("lt"), 3.0, 6.5, " mm")
    rng("WTW", inp.get("wtw"), 10.0, 14.0, " mm")
    rng("CCT", inp.get("cct"), 400.0, 650.0, " µm")
    rng("alvo", inp.get("target"), -6.0, 3.0, " D")
    return erros
