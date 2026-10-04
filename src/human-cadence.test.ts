import { describe, expect, it } from 'vitest';

import { MAX_MS, MIN_MS, humanDelayMs } from './human-cadence.js';
import { parseMarking } from './agent-marking.js';

// Os números da cadência vêm das 849 respostas humanas medidas no corpus da
// clínica. O que estes testes travam é o contrato: nunca instantâneo, nunca
// acima de 1 minuto, e o tempo que o container gastou pensando conta.

const semJitter = () => 0.5; // random()=0.5 → fator 1, jitter neutro

describe('humanDelayMs', () => {
  it('nunca responde instantaneamente', () => {
    expect(humanDelayMs('Oi', 0, semJitter)).toBeGreaterThanOrEqual(MIN_MS);
  });

  it('nunca passa de 1 minuto, nem para texto enorme', () => {
    const gigante = 'a'.repeat(5000);
    for (const r of [() => 0, () => 0.5, () => 0.999]) {
      expect(humanDelayMs(gigante, 0, r)).toBeLessThanOrEqual(MAX_MS);
    }
  });

  it('desconta o tempo que o container já gastou pensando', () => {
    const texto = 'a'.repeat(400); // alvo ~30s sem jitter
    const parado = humanDelayMs(texto, 0, semJitter);
    const apos10s = humanDelayMs(texto, 10_000, semJitter);
    expect(parado - apos10s).toBe(10_000);
  });

  it('não espera mais nada se o turno já demorou além do alvo', () => {
    expect(humanDelayMs('Oi', 10 * 60_000, semJitter)).toBe(0);
  });

  it('texto mais longo espera mais (tempo de digitação)', () => {
    const curto = humanDelayMs('Oi', 0, semJitter);
    const longo = humanDelayMs('a'.repeat(600), 0, semJitter);
    expect(longo).toBeGreaterThan(curto);
  });

  it('o jitter varia o resultado, porque atraso constante também é um tell', () => {
    const texto = 'a'.repeat(400);
    const baixo = humanDelayMs(texto, 0, () => 0);
    const alto = humanDelayMs(texto, 0, () => 1);
    expect(alto).toBeGreaterThan(baixo);
  });
});

describe('parseMarking', () => {
  it('lê a marcação de dentro do bloco internal', () => {
    const m = parseMarking(
      'Tem vaga amanhã às 10h.\n<internal>intencao=verificar vaga | fonte=base | bloco=F12 | script=iclinic_vagas.py</internal>',
    );
    expect(m).toEqual({
      intencao: 'verificar vaga',
      fonte: 'base',
      bloco: 'F12',
      script: 'iclinic_vagas.py',
      nota: '',
    });
  });

  it('aceita "intenção" com acento, que é como o agente tende a escrever', () => {
    expect(
      parseMarking('<internal>intenção=abertura | fonte=base</internal>')
        ?.intencao,
    ).toBe('abertura');
  });

  it('devolve undefined quando não há marcação', () => {
    expect(parseMarking('Bom dia, tudo bem?')).toBeUndefined();
    expect(
      parseMarking('<internal>pensando alto aqui</internal>'),
    ).toBeUndefined();
  });

  it('registra INVENTADO, que é o dado que o teste mais quer', () => {
    expect(
      parseMarking(
        '<internal>intencao=preco da cirurgia | fonte=INVENTADO</internal>',
      )?.fonte,
    ).toBe('INVENTADO');
  });
});
