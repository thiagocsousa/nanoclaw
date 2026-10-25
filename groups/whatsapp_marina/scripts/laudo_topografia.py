#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Monta o texto do LAUDO DE TOPOGRAFIA DE CÓRNEA para a Marina colar no prontuário.

⛔ NÃO escreve em sistema nenhum. Desde 25/10/2026 este script só formata e
confere — quem cola no prontuário é a Marina.

## Por que deixou de escrever

Até 25/10 ele digitava o laudo no prontuário do iClinic via Playwright
(`keyboard.type`, porque preencher por JS não funciona naquele editor). Na
virada para a Clínica nas Nuvens isso ficou sem destino: **a API da CNN não tem
endpoint de prontuário** — é a única das seis capacidades levantadas sem
equivalente (`docs/CNN-MAPEAMENTO.md`, lacuna 3). Continuar escrevendo no
iClinic seria pior que não escrever: a partir de 26/10 ninguém abre aquele
sistema, então o rascunho ficaria num lugar onde a Marina não o encontra, sem
erro e sem aviso.

Reescrever contra a tela da CNN é trabalho novo, e a decisão do Thiago em
25/10/2026 foi a opção 2: **manter o cálculo e a formatação, que é a parte com
valor, e entregar o texto no grupo para copiar e colar.** De passagem isso tira
o Playwright, o Chromium, o login de ~20 s e a navegação de seis telas do
caminho — e com eles toda a chance de o script errar o prontuário.

ℹ️ Com este script, o laudo deixou de ser o último usuário do Chromium no
container? **Não.** `barrett_toric.py`, `escrs_calc.py` e `nfse_danfse_portal.py`
continuam usando. A imagem não encolhe por causa desta mudança.

## O que ele confere, e o que deliberadamente NÃO confere

A rede saiu do caminho, e com ela a única conferência que existia: antes o
script relia o editor e recusava se as linhas KT não tivessem entrado. Agora o
que resta é conferir os NÚMEROS, e isso pega um erro que a versão antiga não
pegava — leitura errada do PDF pela visão, que é por onde os dados entram.

- **Recusa** (o laudo não sai): número que não é número, ceratometria fora de
  30–60 D, eixo fora de 0–180, cilindro negativo ou acima de 15 D, e K plano
  maior que o K curvo. Nada disso é córnea; é leitura trocada.
- **Avisa, sem recusar**: o cilindro tem de ser a diferença entre os dois
  meridianos, e o aparelho calcula os três. Se `cyl` não casar com `ks - kf`
  dentro de 0,5 D, um dos três foi lido errado — mas qual, não dá para saber
  daqui, então o laudo sai COM o aviso em vez de ficar preso.
- ⛔ **NÃO confere se os eixos são perpendiculares**, e isso é de propósito. Em
  córnea regular eles ficam a ~90°, mas em ceratocone e córnea irregular não
  ficam — e esse é justamente o caso em que o laudo mais importa. O exemplo real
  do cabeçalho antigo (OS: 173 e 63, 110° de diferença) já reprovaria. Guarda que
  acusa o achado clínico é guarda que alguém desliga.

Entrada (argv[1] JSON) — o AGENTE extrai da topografia por visão:
  {"paciente":"Patricia Imamura",
   "od":{"kf":43.22,"kf_axis":11,"ks":44.22,"ks_axis":101,"cyl":1.00},
   "os":{"kf":43.11,"kf_axis":173,"ks":46.07,"ks_axis":63,"cyl":2.97}}
  (kf=K plano, ks=K curvo; eixos em graus; cyl=cilindro)

Saída:
  {"ok":true, "paciente":..., "laudo":"<texto puro>", "mensagem":"<nota>",
   "conferir":["..."]}   — `laudo` é o que vai para o prontuário, e NADA mais;
                           `conferir` costuma vir vazia.
  {"ok":false,"aviso":...}
"""
import json
import sys

# Faixas do fisicamente possível, não do normal. Ceratocone passa de 50 D e
# córnea operada fica abaixo de 38 — apertar isso recusaria exame de verdade.
K_MIN, K_MAX = 30.0, 60.0
CIL_MAX = 15.0

# Tolerância do cruzamento cyl × (ks - kf). O aparelho arredonda em 0,01, então
# 0,5 D é folga larga de propósito: aqui um falso alarme atrasa um laudo real.
TOL_CIL = 0.5

OLHOS = (("od", "OLHO DIREITO"), ("os", "OLHO ESQUERDO"))


def _out(d):
    print(json.dumps(d, ensure_ascii=False))
    return d


def _fmt_k(v):
    return f"{float(v):.2f}"


def _fmt_axis(v):
    return str(int(round(float(v))))


def _kt_line(eye):
    """KT: {kf} ({kf_axis}) x {ks} ({ks_axis}) Cil {cyl} — K plano primeiro."""
    return (f"KT: {_fmt_k(eye['kf'])} ({_fmt_axis(eye['kf_axis'])}) x "
            f"{_fmt_k(eye['ks'])} ({_fmt_axis(eye['ks_axis'])}) Cil {_fmt_k(eye['cyl'])}")


def _laudo_lines(inp):
    linhas = ["LAUDO DE TOPOGRAFIA DE CÓRNEA", ""]
    for i, (chave, titulo) in enumerate(OLHOS):
        if i > 0:
            linhas.append("")
        linhas += [titulo + ":", _kt_line(inp[chave])]
    return linhas


def _confere_olho(chave, titulo, eye):
    """(erros, avisos) daquele olho. Erro recusa; aviso acompanha o laudo."""
    erros, avisos = [], []
    valores = {}
    for campo in ("kf", "kf_axis", "ks", "ks_axis", "cyl"):
        if eye.get(campo) is None:
            erros.append(f"{titulo}: falta '{campo}'.")
            continue
        try:
            valores[campo] = float(eye[campo])
        except (TypeError, ValueError):
            erros.append(f"{titulo}: '{campo}' não é número ({eye[campo]!r}).")
    if erros:
        return erros, avisos

    for campo in ("kf", "ks"):
        if not K_MIN <= valores[campo] <= K_MAX:
            erros.append(
                f"{titulo}: {campo} = {valores[campo]:.2f} D está fora de "
                f"{K_MIN:.0f}–{K_MAX:.0f} D. Confira a leitura do exame."
            )
    for campo in ("kf_axis", "ks_axis"):
        if not 0 <= valores[campo] <= 180:
            erros.append(
                f"{titulo}: {campo} = {valores[campo]:.0f}° está fora de 0–180°."
            )
    if not 0 <= valores["cyl"] <= CIL_MAX:
        erros.append(
            f"{titulo}: cilindro = {valores['cyl']:.2f} D está fora de "
            f"0–{CIL_MAX:.0f} D."
        )
    if erros:
        return erros, avisos

    # K plano é o MENOR por definição. Invertido quer dizer que a leitura trocou
    # os dois — e aí os eixos vieram trocados também, então corrigir aqui faria
    # um laudo errado com cara de certo.
    if valores["kf"] > valores["ks"]:
        erros.append(
            f"{titulo}: o K plano ({valores['kf']:.2f}) está MAIOR que o curvo "
            f"({valores['ks']:.2f}) — a leitura trocou os dois (e provavelmente "
            "os eixos). Reenvie."
        )
        return erros, avisos

    delta = valores["ks"] - valores["kf"]
    if abs(valores["cyl"] - delta) > TOL_CIL:
        avisos.append(
            f"{titulo}: o cilindro lido ({valores['cyl']:.2f} D) não casa com a "
            f"diferença dos meridianos ({delta:.2f} D). Um dos três números "
            "pode ter sido lido errado."
        )
    return erros, avisos


def run(inp):
    paciente = (inp.get("paciente") or "").strip()
    if not paciente:
        return {"ok": False, "aviso": "Falta 'paciente' na entrada do laudo."}
    for chave, titulo in OLHOS:
        if not inp.get(chave):
            return {"ok": False,
                    "aviso": f"Falta '{chave}' ({titulo}) na entrada do laudo."}

    erros, avisos = [], []
    for chave, titulo in OLHOS:
        e, a = _confere_olho(chave, titulo, inp[chave])
        erros += e
        avisos += a
    if erros:
        return {"ok": False, "aviso": "Não montei o laudo: " + " ".join(erros)}

    laudo = "\n".join(_laudo_lines(inp))
    return {
        "ok": True,
        "paciente": paciente,
        "laudo": laudo,
        "mensagem": (
            f"*Laudo de topografia — {paciente}*\n"
            "Só as linhas KT (dados medidos), sem interpretação. "
            "Copie a próxima mensagem e cole no prontuário."
        ),
        "conferir": avisos,
    }


def main():
    if len(sys.argv) < 2:
        _out({"ok": False, "aviso": "uso: laudo_topografia.py '<json>'"})
        return
    try:
        inp = json.loads(sys.argv[1])
    except (ValueError, TypeError) as e:
        _out({"ok": False, "aviso": f"JSON inválido: {e}"})
        return
    _out(run(inp))


if __name__ == "__main__":
    main()
