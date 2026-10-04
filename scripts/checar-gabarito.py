#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Confere o GABARITO contra si mesmo, sem chamar modelo nenhum.

## Por que isto existe

O H03 só apareceu porque o modelo discordou do rótulo. Onde o modelo concorda
com um rótulo errado, o erro fica invisível e entra na acurácia como acerto.
Então o gabarito precisa ser conferido por uma via que não passe pelo modelo.

A via é a redundância que a suíte já tem: cada turno declara o rótulo
(`intencao_esperada`) **e** o que o texto deve ou não conter (`esperado`,
`proibido`). Os dois foram escritos em momentos diferentes, para propósitos
diferentes. Quando discordam, um dos dois está errado, e é cheiro de defeito
mesmo sem saber qual.

Roda local, em segundos, e não gasta token.
"""
import json
import os
import re
import sys
from pathlib import Path

GRUPO = Path(os.environ.get("GRUPO_DIR", "groups/whatsapp_atendimento-teste"))
SUITE = Path(os.environ.get("SUITE", "tests/conversas-lara.json"))
# `esperado` guarda REGEX, não texto. Procurar /S[óo] um instante/ dentro da
# string "S[óo] um instante" não casa: os colchetes ali são literais do padrão.
# Então a detecção é no nível do padrão, por uma subcadeia que sobrevive a
# qualquer grafia dele.
def pede_frase_de_escala(padroes):
    return any("instante" in r.lower() for r in padroes)
EXEMPLO = {
    "valor_consulta": "430,00", "valor_desconto": "300,00", "dia": "segunda",
    "data": "06/10", "hora": "09:20", "dia_pedido": "sábado",
}


def texto_de(tabela, intencao):
    """Os textos do rótulo como o paciente os receberia, fecho incluído.

    O fecho é acrescentado pelo host quando `fecho` é true, então sem ele a
    checagem acusava o endereço de não atender o próprio cenário.
    """
    d = tabela["intencoes"].get(intencao) or {}
    sufixo = "\n\nAjudo em algo mais?" if d.get("fecho") else ""
    saida = []
    for t in d.get("textos") or []:
        for k, v in EXEMPLO.items():
            t = t.replace("{%s}" % k, v)
        saida.append(re.sub(r"\{\w+\}", "...", t) + sufixo)
    return saida


def main():
    tabela = json.loads((GRUPO / "templates.json").read_text(encoding="utf-8"))
    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    escalam = {n for n, d in tabela["intencoes"].items() if d.get("acao") == "escalar"}

    def acao(nome):
        if nome in escalam or nome == "DESCONHECIDO":
            return "escalar"
        return (tabela["intencoes"].get(nome) or {}).get("acao", "?")

    achados = []
    for c in suite["cenarios"]:
        for t in c["turnos"]:
            rot = t.get("intencao_esperada")
            if not rot:
                continue
            # Checagens nomeadas (@regra) são código, não regex de texto.
            esp = [r for r in t.get("esperado") or [] if not r.startswith("@")]
            pro = [r for r in t.get("proibido") or [] if not r.startswith("@")]
            a = acao(rot)
            pede_escala = pede_frase_de_escala(esp)
            textos = texto_de(tabela, rot)

            if a == "escalar" and esp and not pede_escala:
                achados.append((c["id"], rot, "ESCALA SEM A FRASE",
                                "rótulo escala, mas o `esperado` pede %r" % esp[:2]))
            if a != "escalar" and pede_escala:
                achados.append((c["id"], rot, "FRASE SEM ESCALA",
                                "`esperado` pede 'Só um instante' e o rótulo age '%s'" % a))
            # O texto aprovado do rótulo viola uma proibição do próprio cenário?
            for rx in pro:
                for txt in textos:
                    if re.search(rx, txt, re.I):
                        achados.append((c["id"], rot, "TEXTO PROIBIDO",
                                        "o texto do rótulo casa /%s/" % rx))
            # O texto aprovado atende o que o cenário exige?
            if a == "responder" and textos:
                for rx in esp:
                    if not any(re.search(rx, x, re.I) for x in textos):
                        achados.append((c["id"], rot, "TEXTO NAO ATENDE",
                                        "nenhum texto do rótulo casa /%s/" % rx))

    if not achados:
        print("gabarito consistente: nenhuma divergência entre rótulo e esperado/proibido")
        return 0
    print("%d divergência(s) entre o rótulo e o esperado/proibido do mesmo turno:\n" % len(achados))
    for cid, rot, tipo, detalhe in achados:
        print("  %-5s %-22s %-18s %s" % (cid, rot, tipo, detalhe))
    print("\nCada uma é um dos dois errado. Resolver ANTES de pontuar o classificador:")
    print("rótulo errado entra na acurácia como acerto quando o modelo concorda com ele.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
