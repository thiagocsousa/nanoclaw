#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nome do paciente como se fala com ele.

A Clínica nas Nuvens devolve o cadastro em CAIXA ALTA — "EVILÂNIA CARDOSO
CANUTO" —, que é como o sistema guarda, não como se cumprimenta alguém. Em
07/11/2026 havia CINCO lugares montando o primeiro nome e QUATRO
implementações diferentes: três tratavam a caixa e duas não, então o pipeline
de avaliação e o de retorno anual mandavam "Olá, *EVILÂNIA*, tudo bem?" para
pacientes de verdade. As duas sem tratamento também estouravam `IndexError`
em nome vazio, porque usavam `split()[0]` sem rede.

⛔ Este arquivo é COPIADO entre pastas de grupo, como o `cnn.py`: o container
monta só `/workspace/group`, não há mount comum e portanto não há módulo
comum. Cópia que divergir é o paciente de um pipeline cumprimentado certo e o
do outro não, sem nada explodir — `src/nome-paciente.test.ts` guarda a
identidade das cópias e proíbe extração caseira de primeiro nome.
"""
import re

# Ligações internas de nome composto. Depois de uma delas, letra sobe.
_LIGACOES = r"[-'’]"


def primeiro_nome(nome, padrao="paciente"):
    """
    Primeiro nome em caixa de gente: "EVILÂNIA CARDOSO CANUTO" → "Evilânia".

    `padrao` é o que sai quando não sobra nome. Nunca string vazia por
    acidente: "Olá, **, tudo bem?" é pior do que "Olá, *paciente*, tudo bem?".
    """
    partes = str(nome or "").strip().split()
    if not partes:
        return padrao
    return caixa_de_gente(partes[0])


def caixa_de_gente(palavra):
    """
    Uma passada só, e por quê: `.capitalize()` resolve "EVILÂNIA" mas erra
    "ANA-CLARA" → "Ana-clara", e aplicar `.capitalize()` por segmento em
    sequência erra pior ainda — a segunda passada rebaixa o que a primeira
    tinha subido. Aqui a palavra desce inteira e sobe a letra do começo e a
    que vem depois de cada ligação: "ANA-CLARA" → "Ana-Clara", "D'ARC" →
    "D'Arc".
    """
    return re.sub(
        rf"(^|{_LIGACOES})(\w)",
        lambda m: m.group(1) + m.group(2).upper(),
        str(palavra).lower(),
    )
