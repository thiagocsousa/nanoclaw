#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Confere que script Python que importa um irmão chama função que EXISTE nele.

⛔ Nasceu de um estrago de verdade, em 26/10/2026. Em 25/10 eu reescrevi o
`nfse_coletar.py` para a Clínica nas Nuvens — HTTP puro, sem navegador — e não
olhei o único arquivo que o chama. O `nfse_coletar_pipeline.py` continuou com:

    b, pg, csrf = nc.login(pw)
    out = nc.coletar(pg, csrf, d0, d1, emitidas)

`nc.login` deixou de existir e `coletar` passou a receber três argumentos.

O que fez o estrago não foi o erro: foi o SILÊNCIO. O `pending_nfse.json`
continuou no disco com a coleta de 23/10, a emissão seguiu lendo aquele
retrato, e a recepção tentou emitir a mesma paciente três vezes preenchendo o
cadastro entre as tentativas — enquanto o coletor lia um arquivo de três dias
antes. Pareceu cache. Era a coleta morta.

TypeScript pegaria isto na hora; Python só em execução, e esta execução é um
cron das 18:30 que ninguém vê falhar.

## O que ele checa, e o que deliberadamente não checa

Para cada `import <irmão>` (módulo que é um .py na MESMA pasta), toda chamada
`<irmão>.nome(...)`:

- **o nome existe** no irmão (função, classe ou variável de módulo);
- **a aridade cabe**, contando defaults, `*args` e `**kwargs`.

⚠️ NÃO resolve `getattr`, atributo calculado, nem reexport. Guarda estreita que
não grita sem motivo vale mais que guarda larga que alguém desliga — e o caso
que custou dinheiro é justamente o literal.

Saída: lista de problemas e código 1, ou silêncio e código 0.
"""
import ast
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent


def nomes_do_modulo(arvore):
    """{nome: (min_pos, max_pos | None)} do topo do módulo. None = ilimitado."""
    out = {}
    for n in arvore.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = n.args
            pos = a.posonlyargs + a.args
            minimo = len(pos) - len(a.defaults)
            maximo = None if a.vararg else len(pos)
            out[n.name] = (max(minimo, 0), maximo)
        elif isinstance(n, ast.ClassDef):
            out[n.name] = (0, None)
        elif isinstance(n, ast.Assign):
            for alvo in n.targets:
                if isinstance(alvo, ast.Name):
                    out[alvo.id] = (0, None)
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            out[n.target.id] = (0, None)
    return out


def nomes_reatribuidos(arvore):
    """Todo nome que recebe valor em QUALQUER lugar do arquivo.

    ⛔ Existe por um falso positivo real, achado no primeiro uso desta guarda:
    `nfse_emitir_pipeline.py` faz `import nfse_dps as b` dentro de uma função e
    `a, b = tok.split("-", 1)` dentro de OUTRA. Sem escopo, `b.isdigit()`
    parecia chamada ao módulo.

    Fazer análise de escopo de verdade é muito mais código para um ganho que
    não existe: se o nome é reatribuído em algum ponto, eu não sei
    estaticamente qual ligação está viva, e **calar é o certo**. Guarda que
    grita sem motivo é guarda que alguém desliga — e aí ela não pega o caso que
    custou dinheiro.
    """
    bound = set()

    def dos_alvos(no):
        for x in ast.walk(no):
            if isinstance(x, ast.Name):
                bound.add(x.id)

    for n in ast.walk(arvore):
        if isinstance(n, (ast.Assign, ast.For, ast.AsyncFor)):
            for alvo in getattr(n, "targets", None) or [n.target]:
                dos_alvos(alvo)
        elif isinstance(n, (ast.AugAssign, ast.AnnAssign, ast.NamedExpr)):
            dos_alvos(n.target)
        elif isinstance(n, ast.comprehension):
            dos_alvos(n.target)
        elif isinstance(n, ast.withitem) and n.optional_vars is not None:
            dos_alvos(n.optional_vars)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            a = n.args
            for arg in a.posonlyargs + a.args + a.kwonlyargs:
                bound.add(arg.arg)
            if a.vararg:
                bound.add(a.vararg.arg)
            if a.kwarg:
                bound.add(a.kwarg.arg)
    return bound


def irmaos_importados(arvore, pasta):
    """{apelido: Path} para cada `import X [as Y]` que é .py na mesma pasta."""
    out = {}
    for n in ast.walk(arvore):
        if isinstance(n, ast.Import):
            for a in n.names:
                alvo = pasta / f"{a.name}.py"
                if alvo.exists():
                    out[a.asname or a.name] = alvo
    # Apelido que também é variável sai: ver `nomes_reatribuidos`.
    for nome in nomes_reatribuidos(arvore):
        out.pop(nome, None)
    return out


def problemas_do_arquivo(caminho):
    pasta = caminho.parent
    try:
        arvore = ast.parse(caminho.read_text(encoding="utf-8"))
    except SyntaxError as e:
        return [f"{caminho.relative_to(RAIZ)}:{e.lineno}: não parseia: {e.msg}"]

    irmaos = irmaos_importados(arvore, pasta)
    if not irmaos:
        return []

    api = {}
    for apelido, alvo in irmaos.items():
        try:
            api[apelido] = nomes_do_modulo(ast.parse(alvo.read_text(encoding="utf-8")))
        except SyntaxError:
            continue

    achados = []
    rel = caminho.relative_to(RAIZ)
    for n in ast.walk(arvore):
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if not (isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name)):
            continue
        apelido = f.value.id
        if apelido not in api:
            continue
        if f.attr not in api[apelido]:
            achados.append(
                f"{rel}:{n.lineno}: {apelido}.{f.attr} não existe em "
                f"{irmaos[apelido].name}"
            )
            continue
        minimo, maximo = api[apelido][f.attr]
        # `*lista` na chamada torna a contagem indeterminada; não acusa.
        if any(isinstance(a, ast.Starred) for a in n.args):
            continue
        dados = len(n.args)
        nomeados = {k.arg for k in n.keywords if k.arg}
        tem_duplo_asterisco = any(k.arg is None for k in n.keywords)
        if maximo is not None and dados > maximo:
            achados.append(
                f"{rel}:{n.lineno}: {apelido}.{f.attr} recebe no máximo "
                f"{maximo} posicionais, chamada passa {dados}"
            )
        elif not tem_duplo_asterisco and dados + len(nomeados) < minimo:
            achados.append(
                f"{rel}:{n.lineno}: {apelido}.{f.attr} exige {minimo} "
                f"argumentos, chamada passa {dados + len(nomeados)}"
            )
    return achados


def main():
    achados = []
    for caminho in sorted(RAIZ.glob("groups/*/scripts/*.py")):
        achados += problemas_do_arquivo(caminho)
    for caminho in sorted(RAIZ.glob("scripts/*.py")):
        achados += problemas_do_arquivo(caminho)
    if achados:
        print("\n".join(achados))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
