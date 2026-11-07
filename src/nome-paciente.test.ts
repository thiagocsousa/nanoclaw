import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ Como o nome do paciente chega até ele.
 *
 * A Clínica nas Nuvens guarda em CAIXA ALTA. Em 07/11/2026 havia cinco lugares
 * montando o primeiro nome e quatro implementações: `send_avaliacao.py` e
 * `send_retorno.py` mandavam "Olá, *EVILÂNIA*, tudo bem?" para paciente de
 * verdade, `send_nota.py` tinha função própria com padrão `""` (o "Olá, sr(a)
 * !") e os dois do lembrete traziam a receita inline, cada um com um `strip()`
 * de diferença.
 *
 * O teste guarda as três coisas que podem desfazer isso em silêncio:
 * 1. o comportamento (roda o Python de verdade, não uma reimplementação aqui);
 * 2. a identidade das cópias entre pastas de grupo — mesmo motivo do
 *    `cnn-client-copias.test.ts`: o container monta só `/workspace/group`;
 * 3. que ninguém volte a extrair primeiro nome à mão.
 */

const RAIZ_GRUPOS = path.join(process.cwd(), 'groups');

function copias(arquivo: string): string[] {
  return fs
    .readdirSync(RAIZ_GRUPOS)
    .map((g) => path.join(RAIZ_GRUPOS, g, 'scripts', arquivo))
    .filter((p) => fs.existsSync(p));
}

function scriptsPython(): string[] {
  const fora: string[] = [];
  for (const g of fs.readdirSync(RAIZ_GRUPOS)) {
    const dir = path.join(RAIZ_GRUPOS, g, 'scripts');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.py')) fora.push(path.join(dir, f));
    }
  }
  return fora;
}

describe('primeiro_nome: comportamento', () => {
  const modulo = copias('nome_paciente.py')[0];

  it('existe ao menos uma cópia do módulo', () => {
    expect(modulo).toBeTruthy();
  });

  it.each([
    ['EVILÂNIA CARDOSO CANUTO', 'Evilânia'],
    ['MARIA NAZARE DE ARAUJO', 'Maria'],
    ['ana camila de sousa oliveira', 'Ana'],
    ['Thiago', 'Thiago'],
    ['  JOSEFA   DA COSTA  ', 'Josefa'],
    // Composto ligado: `.capitalize()` sozinho devolveria "Ana-clara".
    ['ANA-CLARA SOUSA', 'Ana-Clara'],
    ["D'ARC LIMA", "D'Arc"],
    // Sem nome sai o padrão, nunca vazio: "Olá, **!" é pior que "Olá,
    // *paciente*!".
    ['', 'paciente'],
    ['   ', 'paciente'],
  ])('%j → %j', (entrada, esperado) => {
    const saida = execFileSync(
      'python3',
      [
        '-c',
        [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(path.dirname(modulo))})`,
          'from nome_paciente import primeiro_nome',
          'print(primeiro_nome(sys.argv[1]), end="")',
        ].join('\n'),
        entrada,
      ],
      { encoding: 'utf-8' },
    );
    expect(saida).toBe(esperado);
  });

  it('None também cai no padrão', () => {
    const saida = execFileSync(
      'python3',
      [
        '-c',
        [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(path.dirname(modulo))})`,
          'from nome_paciente import primeiro_nome',
          'print(primeiro_nome(None), end="")',
        ].join('\n'),
      ],
      { encoding: 'utf-8' },
    );
    expect(saida).toBe('paciente');
  });
});

describe('nome_paciente.py: as cópias entre grupos são idênticas', () => {
  it('todas têm exatamente o mesmo conteúdo', () => {
    const porConteudo = new Map<string, string[]>();
    for (const c of copias('nome_paciente.py')) {
      const texto = fs.readFileSync(c, 'utf-8');
      const grupo = path.relative(RAIZ_GRUPOS, c);
      porConteudo.set(texto, [...(porConteudo.get(texto) ?? []), grupo]);
    }
    const versoes = [...porConteudo.values()];
    expect(
      versoes,
      `cópias divergiram: ${JSON.stringify(versoes)}`,
    ).toHaveLength(1);
  });
});

describe('ninguém extrai primeiro nome à mão', () => {
  /**
   * `split()[0]` e `(x.split() or ["paciente"])[0]` foram as quatro receitas
   * caseiras que existiam. Qualquer uma de volta é um pipeline cumprimentando
   * o paciente de um jeito diferente dos outros — e, nos dois casos que
   * usavam `split()[0]` sem rede, um `IndexError` com nome vazio.
   */
  const CASEIRO = /\.split\(\)\s*\[0\]|\.split\(\)\s*or\s*\[/;

  it('nenhum script de grupo usa a receita caseira', () => {
    const culpados: string[] = [];
    for (const s of scriptsPython()) {
      if (path.basename(s) === 'nome_paciente.py') continue;
      const texto = fs.readFileSync(s, 'utf-8');
      for (const [i, linha] of texto.split('\n').entries()) {
        if (CASEIRO.test(linha)) {
          culpados.push(`${path.relative(process.cwd(), s)}:${i + 1}`);
        }
      }
    }
    expect(culpados, culpados.join('\n')).toEqual([]);
  });

  it('todo script que fala "Olá" com nome importa o módulo', () => {
    const faltando: string[] = [];
    for (const s of scriptsPython()) {
      if (path.basename(s) === 'nome_paciente.py') continue;
      const texto = fs.readFileSync(s, 'utf-8');
      const cumprimenta = /Ol[áa],\s*(\*?\{|sr\(a\))/.test(texto);
      if (!cumprimenta) continue;
      if (!texto.includes('from nome_paciente import primeiro_nome')) {
        faltando.push(path.relative(process.cwd(), s));
      }
    }
    expect(faltando, faltando.join('\n')).toEqual([]);
  });
});
