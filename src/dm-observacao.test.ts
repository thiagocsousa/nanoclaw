import { describe, expect, it } from 'vitest';

import { aceitaDmDeObservacao } from './channels/whatsapp.js';

/**
 * "Só queria para mensagens novas, tanto de pacientes antigos quanto de novos"
 * (Thiago, 19/10/2026).
 *
 * Quatro recusas, e cada uma fecha uma porta diferente por onde histórico ou
 * mensagem da própria clínica entraria como turno de paciente.
 */
const PISO = Date.UTC(2026, 9, 19, 21, 0, 0);
const DM = '558699999999@s.whatsapp.net';
const base = { rawJid: DM, timestampMs: PISO + 1000, piso: PISO };

describe('aceitaDmDeObservacao', () => {
  it('aceita DM nova de paciente', () => {
    expect(aceitaDmDeObservacao({ ...base, tipo: 'notify' })).toBe(true);
    // Sem tipo (chamada interna/sintética) também vale.
    expect(aceitaDmDeObservacao(base)).toBe(true);
  });

  it('RECUSA sincronização de histórico (type append)', () => {
    expect(aceitaDmDeObservacao({ ...base, tipo: 'append' })).toBe(false);
  });

  it('RECUSA mensagem ANTERIOR ao piso, mesmo em notify', () => {
    expect(
      aceitaDmDeObservacao({
        ...base,
        tipo: 'notify',
        timestampMs: PISO - 1,
      }),
    ).toBe(false);
    // E a de exatamente o piso passa: o piso é o instante de subir.
    expect(
      aceitaDmDeObservacao({ ...base, tipo: 'notify', timestampMs: PISO }),
    ).toBe(true);
  });

  // ⚠️ A secretária é quem mais escreve nessas DMs, e o eco `fromMe` é o que
  // mede o SLA — então ele chega aqui sempre.
  /**
   * ⚠️ Virou ACEITA em 22/10/2026, e a mudança é de propósito.
   *
   * A linha `if (m.fromMe) return false` fazia duas coisas: não disparar turno
   * e não VER. A segunda estragou o primeiro dia de observação — a paciente
   * respondeu "Particular" e "Como faço?" à SECRETÁRIA, e a Lara, sem enxergar
   * o que a secretária dissera, respondeu fora de contexto.
   *
   * A fala da clínica agora é GRAVADA como contexto. Quem impede o turno é o
   * host (`index.ts`), que ignora lote só de `is_from_me` em DM observada —
   * separando "não responda a isto" de "não leia isto".
   */
  it('ACEITA fromMe: é a secretária, e a Lara precisa ler', () => {
    expect(aceitaDmDeObservacao({ ...base, fromMe: true })).toBe(true);
  });

  it.each([
    ['grupo', '120363275085162068@g.us'],
    ['status', 'status@broadcast'],
    ['vazio', ''],
    ['nulo', null],
  ])('RECUSA %s', (_c, rawJid) => {
    expect(aceitaDmDeObservacao({ ...base, rawJid })).toBe(false);
  });

  it('RECUSA timestamp inválido', () => {
    expect(aceitaDmDeObservacao({ ...base, timestampMs: NaN })).toBe(false);
  });
});
