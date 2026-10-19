#!/usr/bin/env python3
"""Checa o ESCOPO das regras globais da suíte, não o comportamento da Lara.

`scripts/testar-lara.py` só roda contra a VM, com o app no ar, e leva uma hora.
Então uma regra global com escopo errado só aparece como "falha dura" numa
passada inteira — e em 17/10/2026 apareceu em três cenários ao mesmo tempo,
acusando a resposta CERTA. O que faltava era poder perguntar à regra, em
segundos e sem VM: "você bate onde deve e não bate onde não deve?".

Cada caso aqui é um par: um texto que a regra DEVE liberar e um que ela DEVE
continuar pegando. O segundo é o que importa — afrouxar uma regra até ela passar
é fácil, e três cenários ficando verdes não é prova de que ela ainda morde.

    python3 scripts/checar-regras-suite.py
"""

import importlib.util
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

spec = importlib.util.spec_from_file_location(
    "testar_lara", os.path.join(RAIZ, "scripts", "testar-lara.py")
)
tl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tl)

with open(os.path.join(RAIZ, "tests", "conversas-lara.json"), encoding="utf-8") as f:
    GLOBAIS = json.load(f)["_proibido_global"]

with open(
    os.path.join(RAIZ, "groups", "whatsapp_atendimento-teste", "templates.json"),
    encoding="utf-8",
) as f:
    _I = json.load(f)["intencoes"]
ABERTURA = _I["abertura"]["textos"][0]
# Lido da tabela, nunca transcrito: com um literal aqui, o caso provaria que a
# regra libera "uma frase que eu digitei em 19/10", e não a frase que o paciente
# recebe. Edite o template e a checagem segue verde sobre texto que saiu de uso.
CONVITE = _I["convite_horario"]["textos"][0]

# (regra, descrição, resposta, mensagem atual, mensagens anteriores, deve_bater)
CASOS = [
    # A abertura responde a saudação sem pedido. Desde que o menu numerado saiu
    # (17/10/2026) ela É a pergunta aberta, e a regra tem de deixar passar.
    ("empurra_trabalho", "oi seco", ABERTURA, "oi", [], False),
    ("empurra_trabalho", "bom dia seco", ABERTURA, "bom dia", [], False),
    ("empurra_trabalho", "só emoji", ABERTURA, "👍", [], False),
    ("empurra_trabalho", "oi depois de oi", ABERTURA, "oi", ["oi"], False),
    # "oi, boa tarde" são DUAS saudações. A primeira versão casava a frase
    # inteira contra uma alternação e aceitava só uma, então o M05 reprovava na
    # abertura correta (passada 11).
    ("empurra_trabalho", "duas saudações juntas", ABERTURA,
     "oi, boa tarde", [], False),
    ("empurra_trabalho", "saudação com pontuação", ABERTURA,
     "Olá! Tudo bem?", [], False),
    ("empurra_trabalho", "bom dia + pedido", ABERTURA,
     "bom dia, queria marcar", [], True),
    # Os quatro que seguram a regra no lugar: devolver a pergunta depois que a
    # pessoa já se explicou continua sendo regressão.
    ("empurra_trabalho", "pedido no próprio turno", ABERTURA,
     "quero marcar catarata", [], True),
    ("empurra_trabalho", "'oi?' depois do pedido", ABERTURA,
     "oi?", ["é pra cirurgia de catarata"], True),
    ("empurra_trabalho", "oi depois de oi + pedido", ABERTURA,
     "oi", ["oi", "quanto custa?"], True),
    ("empurra_trabalho", "variante no meio da conversa",
     "Claro, como posso te ajudar?", "e o preço?", ["quero miopia"], True),
    # A guarda alargou `anuncia_bot` em 19/10/2026 e a cópia da suíte ficou
    # estreita: "assistente de atendimento POR inteligência artificial" era
    # bloqueada em produção e passava limpa na passada de duas horas. Regra de
    # suíte que é subconjunto da guarda deixa de prever a produção, e o sintoma
    # é uma passada verde sobre texto que o paciente nunca recebeu.
    ("anuncia_bot", "IA por extenso",
     "Sou a Lara, assistente de atendimento por inteligência artificial.",
     "voce é um robo?", [], True),
    ("anuncia_bot", "atendimento automatizado",
     "Este é um atendimento automatizado.", "oi", [], True),
    # ⚠️ A abertura diz "assistente da Dra. Marina Costa", que é verdade e não
    # anuncia automação. Acusar isso calaria a Lara na primeira mensagem de
    # toda conversa.
    ("anuncia_bot", "assistente da médica NÃO conta", ABERTURA, "oi", [], False),
    # O convite leve ("Quer que eu veja os horários disponíveis para você?") é a
    # ÚNICA frase de permissão aprovada, escolhida pelo Thiago em 19/10/2026.
    # A razão da regra está na própria regra: "se você JÁ TEM o que precisa para
    # consultar, consulte e mande o resultado". No convite leve a Lara não tem —
    # quem só perguntou preço não deu nome nem nascimento nem cidade.
    ("permissao", "o convite leve aprovado", CONVITE, "quanto custa?",
     [], False),
    # ⚠️ Qualquer OUTRA variação continua pega. Sem estes três, a exceção viraria
    # licença para pedir permissão em qualquer lugar.
    ("permissao", "variação: 'um horário'",
     "Quer que eu veja um horário disponível?", "quanto custa?", [], True),
    ("permissao", "variação: 'posso verificar'",
     "Posso verificar os horários para você?", "quanto custa?", [], True),
    ("permissao", "variação: 'quer que eu confira'",
     "Quer que eu confira a agenda?", "quanto custa?", [], True),
    ("permissao", "variação: 'quer que eu procure'",
     "Quer que eu procure um horário para você?", "quanto custa?", [], True),
]


def lara_constante():
    """Uma Lara que responde sempre a mesma coisa tem de REPROVAR.

    O Codex mediu em 17/10/2026: com a resposta constante "Só um instante." nos
    135 turnos da suíte, zero falhas duras. Toda ausência de comportamento era
    `esperado`, que é aviso — então uma regressão total do atendimento passava
    pela automação sem reprovar.

    Isto não mede a Lara. Mede se a SUÍTE tem como reprovar: devolve quantos
    turnos acusariam falha dura, e exige que seja mais de zero.
    """
    with open(
        os.path.join(RAIZ, "tests", "conversas-lara.json"), encoding="utf-8"
    ) as f:
        suite = json.load(f)
    duras = 0
    for cen in suite["cenarios"]:
        anteriores = []
        for turno in cen.get("turnos", []):
            du, _ = tl.checa("Só um instante.", turno, GLOBAIS, anteriores)
            duras += len(du)
            anteriores.append(turno["paciente"])
    return duras


def main():
    falhas = 0
    for regra, desc, resposta, msg, anteriores, deve_bater in CASOS:
        duras, _ = tl.checa(resposta, {"paciente": msg}, GLOBAIS, anteriores)
        bateu = any("global/%s" % regra in d for d in duras)
        ok = bateu == deve_bater
        falhas += not ok
        print(
            "%-5s %-18s %-32s regra bateu: %-5s esperado: %s"
            % ("ok" if ok else "FALHA", regra, desc, bateu, deve_bater)
        )
        if not ok:
            print("        duras: %s" % duras)
    duras = lara_constante()
    ok = duras > 0
    falhas += not ok
    print(
        "%-5s %-18s %-32s turnos que reprovam: %d"
        % ("ok" if ok else "FALHA", "suite", "resposta constante reprova", duras)
    )
    print()
    print("%d casos, %d falhas" % (len(CASOS) + 1, falhas))
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
