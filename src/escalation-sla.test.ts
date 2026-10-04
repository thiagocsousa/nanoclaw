import { describe, expect, it } from 'vitest';

import {
  ALARME_MS,
  COBRANCA_MS,
  codigoDaBaixa,
  proximoDegrau,
  type Pendencia,
} from './escalation-sla.js';

// O que estes testes protegem: um alarme que toca sem motivo acorda quem está
// atendendo e, repetido, faz a clínica ignorar o alarme de verdade. Um alarme
// que não toca deixa o paciente esperando sozinho. Os dois são falhas graves,
// então a escada é função pura e está coberta nos dois sentidos.

function pend(over: Partial<Pendencia> = {}): Pendencia {
  return {
    codigo: 'E7K2',
    quando: 0,
    motivo: 'paciente com dor pos-operatoria',
    pergunta: 'operei ontem e meu olho ta ardendo',
    ...over,
  };
}

describe('proximoDegrau', () => {
  it('não cobra antes dos 3 min', () => {
    expect(proximoDegrau(pend(), COBRANCA_MS - 1)).toBe('nada');
  });

  it('cobra exatamente aos 3 min', () => {
    expect(proximoDegrau(pend(), COBRANCA_MS)).toBe('cobrar');
  });

  it('não cobra de novo depois de cobrado: alarme repetido vira ruído', () => {
    expect(proximoDegrau(pend({ cobrado: true }), COBRANCA_MS + 60_000)).toBe(
      'nada',
    );
  });

  it('alarma aos 5 min mesmo já tendo cobrado, SE urgente', () => {
    expect(
      proximoDegrau(pend({ urgente: true, cobrado: true }), ALARME_MS),
    ).toBe('alarmar');
  });

  it('NÃO alarma quando não é urgente, nem depois de muito tempo', () => {
    // Atestado e receita antiga escalam e são comuns. Alarme por burocracia
    // ensina a clínica a ignorar o alarme, e aí ele não guarda mais nada.
    expect(proximoDegrau(pend({ cobrado: true }), ALARME_MS)).toBe('nada');
    expect(proximoDegrau(pend({ cobrado: true }), 60 * 60_000)).toBe('nada');
  });

  it('não urgente ainda é cobrado aos 3 min', () => {
    expect(proximoDegrau(pend(), COBRANCA_MS)).toBe('cobrar');
  });

  it('alarma uma vez só', () => {
    expect(
      proximoDegrau(
        pend({ urgente: true, cobrado: true, alarmado: true }),
        ALARME_MS * 10,
      ),
    ).toBe('nada');
  });

  it('processo parado entre os degraus vai direto ao alarme, se urgente', () => {
    // Host caiu aos 2 min e voltou aos 9: o degrau devido é o alarme.
    expect(proximoDegrau(pend({ urgente: true }), 9 * 60_000)).toBe('alarmar');
    // Não urgente no mesmo cenário: cobra, não alarma.
    expect(proximoDegrau(pend(), 9 * 60_000)).toBe('cobrar');
  });

  it('pendência baixada não existe mais, então nada a fazer', () => {
    // A baixa remove do arquivo; aqui só garantimos que idade negativa
    // (relógio andando para trás) não dispara nada.
    expect(proximoDegrau(pend({ quando: 10 * 60_000 }), 0)).toBe('nada');
  });
});

describe('codigoDaBaixa', () => {
  it('aceita as formas que uma pessoa realmente digita', () => {
    for (const t of [
      'ok E7K2',
      'OK e7k2',
      'baixa E7K2',
      'resolvido E7K2',
      'feito E7K2',
      '  ok E7K2  ',
    ]) {
      expect(codigoDaBaixa(t), t).toBe('E7K2');
    }
  });

  it('ignora mensagem que não é baixa', () => {
    for (const t of [
      'ok',
      'ok obrigado',
      'E7K2',
      'beleza',
      'ok, vou ver isso agora',
      'pode mandar o ok pro paciente',
      '',
    ]) {
      expect(codigoDaBaixa(t), t).toBeUndefined();
    }
  });

  it('não dá baixa a partir do meio da frase', () => {
    // "já mandei ok E7K2 pra ela" é relato, não baixa.
    expect(codigoDaBaixa('já mandei ok E7K2 pra ela')).toBeUndefined();
  });
});
