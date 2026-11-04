#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
O tomador que o COLETOR da NFS-e produz satisfaz o que o EMISSOR exige?

⛔ Nasceu de um estrago real, em 04/11/2026. Ao reescrever o `nfse_coletar.py`
para a Clínica nas Nuvens em 25/10, nomeei o campo do endereço como `rua` —
que é o nome dele na CNN — sem olhar quem consome. O
`nfse_emitir_pipeline.py` lê `end.get("logradouro")` para montar o `xLgr` da
DPS, então TODO item da era CNN morria no emissor com:

    cadastro incompleto, faltou xLgr

Ninguém viu por dez dias porque a lista quase sempre vinha vazia: a única nota
automática do período (Kecya, R$ 7.070) estava esperando aprovação e teria
falhado igual. O erro só apareceu quando emiti três notas à mão.

## Por que a outra guarda não pega

`checar-chamadas-python.py` confere CHAMADA — nome de função e aridade. Aqui o
contrato é CHAVE DE DICIONÁRIO entre dois módulos que nem se importam: o
coletor devolve um dict, o emissor lê outro dict. Nenhum `import` liga os dois,
nenhum tipo os amarra, e Python não reclama de chave ausente — `.get()` devolve
None e a falha vira mensagem da prefeitura, três passos adiante.

## O que ele checa

Lê os dois arquivos por AST e compara:
  - as chaves que `endereco_do_cadastro` PRODUZ;
  - as chaves de endereço que o emissor LÊ (`end.get("...")`).

Toda chave lida pelo emissor tem de ser produzida pelo coletor. O contrário não
é erro: o coletor pode produzir extra (`cidade` é só para a mensagem do grupo).
"""
import ast
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
G = RAIZ / "groups" / "whatsapp_atendimento-dra-marina" / "scripts"
COLETOR = G / "nfse_coletar.py"
EMISSOR = G / "nfse_emitir_pipeline.py"


def chaves_produzidas(arquivo, funcao):
    """As chaves literais do dict que `funcao` devolve."""
    arv = ast.parse(arquivo.read_text(encoding="utf-8"))
    for n in ast.walk(arv):
        if isinstance(n, ast.FunctionDef) and n.name == funcao:
            for r in ast.walk(n):
                if isinstance(r, ast.Return) and isinstance(r.value, ast.Dict):
                    return {
                        k.value
                        for k in r.value.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)
                    }
    return set()


def chaves_lidas(arquivo, variavel):
    """As chaves em `<variavel>.get("x")` — o que o consumidor espera."""
    arv = ast.parse(arquivo.read_text(encoding="utf-8"))
    out = set()
    for n in ast.walk(arv):
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr == "get"
            and isinstance(n.func.value, ast.Name)
            and n.func.value.id == variavel
            and n.args
            and isinstance(n.args[0], ast.Constant)
            and isinstance(n.args[0].value, str)
        ):
            out.add(n.args[0].value)
    return out


def main():
    produz = chaves_produzidas(COLETOR, "endereco_do_cadastro")
    le = chaves_lidas(EMISSOR, "end")
    if not produz or not le:
        print("não consegui ler os dois lados — o checador quebrou, não o código")
        return 1
    faltam = le - produz
    if faltam:
        print("⛔ o emissor lê chaves que o coletor NÃO produz:")
        for k in sorted(faltam):
            print("   end.get(%r)  — %s produz: %s" % (k, COLETOR.name, sorted(produz)))
        return 1
    print("✅ contrato ok — emissor lê %s, coletor produz %s"
          % (sorted(le), sorted(produz)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
