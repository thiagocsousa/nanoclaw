#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mede a acurácia do classificador contra o gabarito, SEM falar com o WhatsApp.

## Por que isto é barato e a suíte de conversa é cara

A suíte manda mensagem de verdade e espera a Lara responder: 120 turnos levam
mais de uma hora, gastam container por turno e produzem tráfego no WhatsApp. O
avaliador só classifica. Mesma cobertura, minutos em vez de hora, e dá para
rodar a cada mudança de prompt.

A diferença existe porque a arquitetura mudou: com templates, o que precisa ser
medido é **o rótulo**, não a redação. O texto já está aprovado.

## O que ele mede

1. acurácia por intenção e matriz de confusão;
2. os dois erros que importam, que NÃO são simétricos:
   - **perigoso**: classificar como `responder` o que deveria escalar. Manda
     texto a quem precisava de humano.
   - **caro, mas seguro**: escalar o que tinha resposta. Gasta atendente.
3. varredura de limiar, para escolher o corte com dado em vez de chute.

Roda dentro do container (precisa do CLI `claude` e do proxy de credencial).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

GRUPO = Path(os.environ.get("GRUPO_DIR", "/workspace/group"))
SUITE = Path(os.environ.get("SUITE", "/workspace/tests/conversas-lara.json"))
MODELO = os.environ.get("CLASSIFICADOR_MODELO", "claude-haiku-4-5-20251001")
TIMEOUT = int(os.environ.get("CLASSIFICADOR_TIMEOUT", "90"))


# Valores de exemplo para as chaves que a agenda e a tabela de preços preenchem
# em produção. Aqui eles só precisam ser plausíveis: o que importa é o
# classificador ver que um horário FOI oferecido, não qual.
EXEMPLO_SLOT = {
    "valor_consulta": "430,00", "valor_desconto": "300,00",
    "dia": "segunda", "data": "06/10", "hora": "09:20", "dia_pedido": "sábado",
}


def fala_da_lara(tabela, intencao):
    """O texto que a Lara teria mandado, reconstruído da tabela.

    Em produção isto é o renderizador em templates.ts. Aqui basta o texto, e
    ele vem da MESMA tabela, então o histórico que o classificador lê é o
    histórico que ele veria de verdade.
    """
    d = tabela["intencoes"].get(intencao) or {}
    textos = d.get("textos") or []
    if not textos:
        return None
    t = textos[0]
    for k, v in EXEMPLO_SLOT.items():
        t = t.replace("{%s}" % k, v)
    return re.sub(r"\{\w+\}", "...", t)


def monta_prompt(instrucoes, tabela_resumo, historico, mensagem):
    partes = [instrucoes, "\n## Intenções disponíveis\n", tabela_resumo]
    if historico:
        partes.append("\n## Conversa até agora\n")
        for quem, txt in historico:
            partes.append("%s: %s" % (quem, txt))
    partes.append("\n## Mensagem a classificar\n")
    partes.append("paciente: %s" % mensagem)
    partes.append("\nResponda só o JSON.")
    return "\n".join(partes)


def chama(prompt):
    try:
        r = subprocess.run(
            ["claude", "-p", prompt, "--model", MODELO],
            capture_output=True, text=True, timeout=TIMEOUT,
        )
        return r.stdout.strip()
    except subprocess.TimeoutExpired:
        return '{"intencao":"__TIMEOUT__","confianca":0}'
    except Exception as exc:  # noqa: BLE001
        return '{"intencao":"__ERRO__","confianca":0,"observacao":"%s"}' % type(exc).__name__


def le_json(saida):
    limpo = re.sub(r"```(?:json)?", "", saida)
    for linha in reversed(limpo.strip().splitlines()):
        t = linha.strip()
        if t.startswith("{"):
            try:
                return json.loads(t)
            except json.JSONDecodeError:
                continue
    i, j = limpo.find("{"), limpo.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(limpo[i:j + 1])
        except json.JSONDecodeError:
            return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limite", type=int, default=0, help="só os N primeiros turnos")
    ap.add_argument("--saida", default="/tmp/avaliacao.json")
    args = ap.parse_args()

    # O prompt do classificador é o CLAUDE.md da pasta desde 04/10/2026: é o
    # único arquivo que o container carrega sozinho, então ele TEM que ser o
    # prompt, senão o agente nunca lê a instrução.
    instrucoes = (GRUPO / "CLAUDE.md").read_text(encoding="utf-8")
    tabela = json.loads((GRUPO / "templates.json").read_text(encoding="utf-8"))
    suite = json.loads(SUITE.read_text(encoding="utf-8"))

    resumo = "\n".join(
        "- **%s**: %s" % (nome, d.get("quando", ""))
        for nome, d in tabela["intencoes"].items()
    )
    escalam = {n for n, d in tabela["intencoes"].items() if d.get("acao") == "escalar"}

    def acao(nome):
        if nome in escalam or nome == "DESCONHECIDO":
            return "escalar"
        return (tabela["intencoes"].get(nome) or {}).get("acao", "?")

    # O histórico usa a intenção DO GABARITO, não a prevista. É teacher forcing
    # de propósito: medindo a classificação de um turno, não quero o erro do
    # turno anterior contaminando o input deste. Erro em cascata é problema de
    # produção, e se misturar aqui eu não sei mais qual dos dois estou medindo.
    casos = []
    for c in suite["cenarios"]:
        hist = []
        for t in c["turnos"]:
            esperada = t.get("intencao_esperada")
            if esperada:
                casos.append({
                    "cenario": c["id"], "categoria": c["categoria"],
                    "mensagem": t["paciente"], "esperado": esperada,
                    "historico": list(hist),
                })
            hist.append(("paciente", t["paciente"]))
            if esperada:
                fala = fala_da_lara(tabela, esperada)
                if fala:
                    hist.append(("atendente", fala))
    if args.limite:
        casos = casos[: args.limite]

    print("avaliando %d turnos com %s" % (len(casos), MODELO), flush=True)
    t0 = time.time()
    for i, caso in enumerate(casos, 1):
        p = monta_prompt(instrucoes, resumo, caso["historico"], caso["mensagem"])
        obj = le_json(chama(p)) or {}
        caso["previsto"] = str(obj.get("intencao", "__SEM_JSON__"))
        try:
            caso["confianca"] = float(obj.get("confianca", 0))
        except (TypeError, ValueError):
            caso["confianca"] = 0.0
        caso["slots"] = obj.get("slots", {}) if isinstance(obj.get("slots"), dict) else {}
        caso["observacao"] = str(obj.get("observacao", ""))[:200]
        caso["acertou"] = caso["previsto"] == caso["esperado"]
        if i % 10 == 0 or i == len(casos):
            ok = sum(1 for c in casos[:i] if c.get("acertou"))
            print("  %d/%d  acertos %d (%.0f%%)  %.0fs"
                  % (i, len(casos), ok, 100 * ok / i, time.time() - t0), flush=True)

    Path(args.saida).write_text(json.dumps(casos, ensure_ascii=False, indent=2),
                                encoding="utf-8")

    ok = sum(1 for c in casos if c["acertou"])
    print("\nacurácia: %d/%d = %.1f%%" % (ok, len(casos), 100 * ok / len(casos)))

    # Os dois erros, que não são simétricos
    perigosos, caros = [], []
    for c in casos:
        if c["acertou"]:
            continue
        dev_escalar = c["esperado"] in escalam or c["esperado"] == "DESCONHECIDO"
        vai_escalar = c["previsto"] in escalam or c["previsto"] == "DESCONHECIDO"
        if dev_escalar and not vai_escalar:
            perigosos.append(c)
        elif not dev_escalar and vai_escalar:
            caros.append(c)
    print("\nPERIGOSO (devia escalar e responde): %d" % len(perigosos))
    for c in perigosos:
        print("  %-5s %-22s -> %-22s %s" % (c["cenario"], c["esperado"],
                                            c["previsto"], c["mensagem"][:44]))
    print("\ncaro mas seguro (devia responder e escala): %d" % len(caros))
    for c in caros:
        print("  %-5s %-22s -> %-22s %s" % (c["cenario"], c["esperado"],
                                            c["previsto"], c["mensagem"][:44]))

    # Quarto balde, que faltava: quando gabarito e previsão escalam os dois, o
    # paciente recebe exatamente a mesma coisa. Contar isso junto com troca de
    # resposta inflava o erro aparente sem nenhum efeito real.
    inocuos, outros = [], []
    for c in casos:
        if c["acertou"] or c in perigosos or c in caros:
            continue
        ea = acao(c["esperado"])
        if ea == acao(c["previsto"]) and ea == "escalar":
            inocuos.append(c)
        else:
            outros.append(c)
    print("\nmesma ação, rótulo diferente (inócuo): %d" % len(inocuos))
    for c in inocuos:
        print("  %-5s %-22s -> %-22s %s" % (c["cenario"], c["esperado"],
                                            c["previsto"], c["mensagem"][:44]))

    print("\ntrocou uma resposta por outra: %d" % len(outros))
    for c in outros:
        print("  %-5s %-22s -> %-22s %s" % (c["cenario"], c["esperado"],
                                            c["previsto"], c["mensagem"][:44]))

    print("\nvarredura de limiar (rebaixa para DESCONHECIDO abaixo do corte):")
    print("  corte   acertos   escala_demais   perigosos")
    for corte in (0.0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9):
        a = p_ = e_ = 0
        for c in casos:
            prev = c["previsto"] if c["confianca"] >= corte else "DESCONHECIDO"
            if prev == c["esperado"]:
                a += 1
            dev = c["esperado"] in escalam or c["esperado"] == "DESCONHECIDO"
            vai = prev in escalam or prev == "DESCONHECIDO"
            if dev and not vai: p_ += 1
            if not dev and vai: e_ += 1
        print("  %.2f    %3d/%3d   %3d             %d" % (corte, a, len(casos), e_, p_))

    print("\nconfusões mais comuns:")
    conf = Counter((c["esperado"], c["previsto"]) for c in casos if not c["acertou"])
    for (e, p), n in conf.most_common(10):
        print("  %-24s -> %-24s %d" % (e, p, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
