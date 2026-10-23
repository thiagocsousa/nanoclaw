import { describe, expect, it } from 'vitest';

import { primeiraVez } from './janela-de-ids.js';

describe('primeiraVez', () => {
  it('o mesmo id só passa uma vez', () => {
    const vistos = new Set<string>();
    expect(primeiraVez(vistos, 'A', 10)).toBe(true);
    expect(primeiraVez(vistos, 'A', 10)).toBe(false);
  });

  /**
   * ⛔ O caso real do log de SLA: a segunda entrega vem com OUTRO timestamp, e
   * é por isso que o discriminador tem de ser o id. 50 das 55 duplicatas
   * medidas em 23/10/2026 diferiam em 1 segundo.
   */
  it('ids diferentes passam', () => {
    const vistos = new Set<string>();
    expect(primeiraVez(vistos, 'A', 10)).toBe(true);
    expect(primeiraVez(vistos, 'B', 10)).toBe(true);
  });

  it('id vazio nunca passa: sem id não há como deduplicar', () => {
    expect(primeiraVez(new Set(), '', 10)).toBe(false);
  });

  // ⚠️ Descarta o MAIS ANTIGO. Descartar o mais novo deixaria passar justamente
  // a duplicata recente, que é o caso que isto pega.
  it('ao encher, esquece o mais antigo e lembra o mais novo', () => {
    const vistos = new Set<string>();
    for (const id of ['A', 'B', 'C']) primeiraVez(vistos, id, 3);
    // Entra 'D': 'A' sai.
    expect(primeiraVez(vistos, 'D', 3)).toBe(true);
    expect(vistos.has('A')).toBe(false);
    expect(primeiraVez(vistos, 'C', 3)).toBe(false);
    expect(primeiraVez(vistos, 'A', 3)).toBe(true);
  });

  it('o teto é respeitado', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 50; i++) primeiraVez(vistos, `id${i}`, 5);
    expect(vistos.size).toBeLessThanOrEqual(5);
  });

  // Teto zero ou negativo não entra em laço infinito.
  it('teto degenerado não trava', () => {
    const vistos = new Set<string>();
    expect(primeiraVez(vistos, 'A', 0)).toBe(true);
    expect(vistos.size).toBeLessThanOrEqual(1);
  });
});
