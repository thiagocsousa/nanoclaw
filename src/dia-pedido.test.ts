import { describe, expect, it } from 'vitest';

import { resolveDiaPedido } from './dia-pedido.js';

// Segunda-feira, 19/10/2026, 10h em Teresina (UTC-3).
const SEGUNDA = new Date('2026-10-19T13:00:00Z');
// Sexta, 23/10/2026.
const SEXTA = new Date('2026-10-23T13:00:00Z');

describe('o dia que o paciente pediu', () => {
  it.each([
    ['sexta', '2026-10-23'],
    ['sexta-feira', '2026-10-23'],
    ['na sexta feira', '2026-10-23'],
    ['quarta', '2026-10-21'],
    ['terça', '2026-10-20'],
    ['sábado', '2026-10-24'],
    ['segunda', '2026-10-19'],
    ['amanhã', '2026-10-20'],
    ['hoje', '2026-10-19'],
    ['depois de amanhã', '2026-10-21'],
    ['dia 23', '2026-10-23'],
    ['23/10', '2026-10-23'],
    ['23/10/2026', '2026-10-23'],
    ['2026-10-23', '2026-10-23'],
    ['pode ser dia 5', '2026-11-05'],
  ])('%s -> %s', (pedido, esperado) => {
    expect(resolveDiaPedido(pedido, SEGUNDA)).toBe(esperado);
  });

  // "segunda" numa segunda é HOJE: a agenda já descarta hora que passou, e
  // mandar para a semana seguinte tiraria um encaixe legítimo.
  it('o próprio dia da semana cai em hoje', () => {
    expect(resolveDiaPedido('segunda', SEGUNDA)).toBe('2026-10-19');
  });

  it('"segunda que vem" pula a de hoje', () => {
    expect(resolveDiaPedido('segunda que vem', SEGUNDA)).toBe('2026-10-26');
  });

  it('data sem ano que já passou vai para o ano que vem', () => {
    expect(resolveDiaPedido('10/03', SEGUNDA)).toBe('2027-03-10');
  });

  it('numa sexta, "sexta" é hoje e "segunda" é a próxima', () => {
    expect(resolveDiaPedido('sexta', SEXTA)).toBe('2026-10-23');
    expect(resolveDiaPedido('segunda', SEXTA)).toBe('2026-10-26');
  });

  // ⚠️ undefined é o caso SEGURO: a agenda devolve o próximo disponível.
  // Chutar uma data seria oferecer um dia que ninguém pediu.
  it.each([
    '',
    undefined,
    'qualquer dia',
    'o mais cedo possível',
    'dia 45',
    '13/13',
  ])('%s não vira data', (pedido) => {
    expect(resolveDiaPedido(pedido, SEGUNDA)).toBeUndefined();
  });
});
