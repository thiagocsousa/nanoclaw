#!/usr/bin/env python3
"""Checa a correlação de identidade do `iclinic_marcar.py`, sem tocar no iClinic.

Depois do POST, o script relê a agenda e decide se o evento novo é o nosso. Essa
decisão é a última coisa entre "Marcado" e um paciente indo à clínica sem
horário, e até 17/10/2026 ela olhava só o HORÁRIO: um evento novo às 09:20 era
aceito como nosso mesmo que fosse da recepção e o nosso POST tivesse falhado
(achado do review adversarial do Codex).

Nada aqui fala com o iClinic nem abre navegador — é a função de correlação
contra entradas montadas à mão, nos formatos que o iClinic já apresentou.

    python3 scripts/checar-marcacao.py
"""

import importlib.util
import os
import sys
import types

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALVO = os.path.join(
    RAIZ, "groups/whatsapp_atendimento-teste/scripts/iclinic_marcar.py"
)

spec = importlib.util.spec_from_file_location("iclinic_marcar", ALVO)
marcar = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(marcar)
except SystemExit:
    # O script tem `main()` guardado por `__main__`, mas valida ambiente no
    # import em algumas versões. Se ele sair, as funções puras já existem.
    pass


def arg(**k):
    return types.SimpleNamespace(**{"nome": "", "paciente_id": None, **k})


# (descrição, evento da agenda, argumentos da marcação, veredito esperado)
#
# True = é o nosso paciente · False = é de outro · None = a agenda não disse.
# O None é deliberado e NÃO é sucesso: quem chama trata como estado incerto e
# escala, porque "não sei de quem é" é indistinguível do evento da recepção.
CASOS = [
    # O id é a prova forte, e vem primeiro.
    ("id confere", {"patient": 42}, arg(paciente_id=42), True),
    ("id divergente", {"patient": 99}, arg(paciente_id=42), False),
    ("id dentro de dict", {"patient": {"id": 42}}, arg(paciente_id=42), True),
    ("id como string", {"patient": "42"}, arg(paciente_id=42), True),
    # Sem `--paciente-id` a marcação cria cadastro novo, e aí só resta o nome.
    # O iClinic devolve em CAIXA ALTA e às vezes com o convênio no título.
    (
        "nome confere apesar da caixa",
        {"patient_name": "JOAO DA SILVA"},
        arg(nome="João da Silva"),
        True,
    ),
    (
        "nome é de outro paciente",
        {"patient_name": "MARIA SOUSA"},
        arg(nome="João da Silva"),
        False,
    ),
    (
        "convênio pendurado no título",
        {"title": "JOAO DA SILVA - UNIMED"},
        arg(nome="João da Silva"),
        True,
    ),
    (
        "nome dentro de patient",
        {"patient": {"name": "JOAO DA SILVA"}},
        arg(nome="João da Silva"),
        True,
    ),
    # Os três que têm de dar None. São eles que impedem o falso "Marcado".
    (
        "agenda não informa paciente",
        {"start_time": "09:20"},
        arg(nome="João da Silva"),
        None,
    ),
    (
        "nome vazio no evento",
        {"patient_name": "   "},
        arg(nome="João da Silva"),
        None,
    ),
    ("nosso nome vazio", {"patient_name": "JOAO"}, arg(nome=""), None),
]


def main():
    falhas = 0
    for desc, ev, a, esperado in CASOS:
        obtido = marcar.confere_paciente(ev, a)
        ok = obtido is esperado
        falhas += not ok
        print(
            "%-5s %-32s -> %-5s esperado: %s"
            % ("ok" if ok else "FALHA", desc, obtido, esperado)
        )
    print()
    print("%d casos, %d falhas" % (len(CASOS), falhas))
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
