import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { idsDoBot } from './aguarda-humano.js';

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'aguarda-'));

function arquivo(conteudo: string): string {
  const f = path.join(RAIZ, `bot-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, conteudo);
  return f;
}

describe('idsDoBot', () => {
  it('lê os ids que o host enviou', () => {
    const f = arquivo(
      '{"id":"A","jid":"x"}\n{"id":"B","jid":"y"}\n{"id":"C","jid":"z"}\n',
    );
    expect([...idsDoBot(f)].sort()).toEqual(['A', 'B', 'C']);
  });

  /**
   * ⚠️ O `appendFileSync` não é atômico, então a ÚLTIMA linha pode estar
   * partida quando outro processo escreve ao mesmo tempo. Uma linha torta não
   * pode derrubar as boas: se derrubasse, o conjunto viria vazio e o eco da
   * própria Lara passaria por resposta humana.
   */
  it('linha truncada no fim não leva as boas embora', () => {
    const f = arquivo('{"id":"A","jid":"x"}\n{"id":"B","ji');
    expect([...idsDoBot(f)]).toEqual(['A']);
  });

  it('entrada sem id é ignorada, não vira undefined no conjunto', () => {
    const f = arquivo('{"jid":"x"}\n{"id":"A"}\n');
    expect([...idsDoBot(f)]).toEqual(['A']);
  });

  /**
   * ⛔ Conjunto vazio é o LADO SEGURO, e vale dizer por quê: sem ids do bot,
   * todo `out` conta como humano e a Lara volta a falar. O contrário — tratar
   * falha de leitura como "tudo é meu eco" — a deixaria muda por causa de um
   * arquivo ausente, que é o estado NORMAL de uma instalação nova.
   */
  it('arquivo que não existe devolve conjunto vazio, não erro', () => {
    expect(idsDoBot(path.join(RAIZ, 'nao-existe.jsonl')).size).toBe(0);
  });

  it('arquivo vazio devolve conjunto vazio', () => {
    expect(idsDoBot(arquivo('')).size).toBe(0);
  });

  it('só linhas em branco devolve conjunto vazio', () => {
    expect(idsDoBot(arquivo('\n\n   \n')).size).toBe(0);
  });
});
