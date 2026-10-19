import { describe, expect, it } from 'vitest';

import { temPlano } from './convenio.js';

/**
 * A regra de ORDEM, nos dois sentidos.
 *
 * Na passada 17 o C01 mostrou o lado fácil: "particular, nao tenho plano" virou
 * "plano não aceito" e a Lara deu R$ 300,00 a quem paga R$ 430,00. Eu alarguei a
 * lista de ausência e criei o lado inverso — o /simplify mediu no mesmo dia, e
 * os cinco primeiros casos de `TEM PLANO` abaixo são os que ele achou.
 *
 * Enumerar não converge em nenhuma das direções. A ordem converge.
 */
describe('temPlano: nome de plano vence palavra de ausência', () => {
  it.each([
    'não tenho certeza, acho que é Bradesco',
    'nao tenho o cartao aqui, mas é Amil',
    'não uso mais o Bradesco, agora é Amil',
    'Hapvida, mas pago por fora o que ele não cobre',
    'Bradesco Saúde particular',
    'SulAmérica (privado)',
    'Bradesco Saude',
    'Amil',
    'Unimed',
    'IASPI',
    'plano da empresa',
  ])('TEM plano: %s', (c) => {
    expect(temPlano(c), c).toBe(true);
  });

  it.each([
    'particular',
    'Particular',
    'não tenho plano',
    'nao tenho plano',
    'particular, nao tenho plano',
    'não tenho convênio',
    'nao possuo plano',
    'sem plano',
    'sem convênio',
    'sem seguro',
    'nenhum',
    'privado',
    'pago do meu bolso',
    'por fora',
  ])('NÃO tem plano: %s', (c) => {
    expect(temPlano(c), c).toBe(false);
  });

  it('vazio não é plano', () => {
    expect(temPlano('')).toBe(false);
    expect(temPlano(undefined)).toBe(false);
    expect(temPlano('   ')).toBe(false);
  });
});
