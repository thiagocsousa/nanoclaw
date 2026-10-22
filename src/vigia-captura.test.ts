import { describe, expect, it } from 'vitest';

import {
  ENTRE_AVISOS_MS,
  SILENCIO_SUSPEITO_MS,
  avisoDeCapturaParada,
  textoDoAviso,
} from './vigia-captura.js';

const MIN = 60_000;
const AGORA = 1_000_000_000;

const base = {
  agora: AGORA,
  observando: true,
  noExpediente: true,
  estado: { ultimaCaptura: AGORA - SILENCIO_SUSPEITO_MS - MIN },
};

describe('avisoDeCapturaParada', () => {
  it('avisa com silêncio além do limite, no expediente', () => {
    expect(avisoDeCapturaParada(base)?.minutos).toBe(46);
  });

  // ⚠️ O controle negativo que importa: a semana inteira passa sem alarme se a
  // captura estiver viva, e um alarme que toca sempre é um alarme ignorado.
  it('NÃO avisa com captura recente', () => {
    expect(
      avisoDeCapturaParada({
        ...base,
        estado: { ultimaCaptura: AGORA - 5 * MIN },
      }),
    ).toBeUndefined();
  });

  it('NÃO avisa fora do expediente: ninguém escreve de madrugada', () => {
    expect(
      avisoDeCapturaParada({ ...base, noExpediente: false }),
    ).toBeUndefined();
  });

  it('NÃO avisa com a observação desligada: não há o que vigiar', () => {
    expect(
      avisoDeCapturaParada({ ...base, observando: false }),
    ).toBeUndefined();
  });

  // Sem marca de captura o relógio não tem de onde correr. Avisar aqui seria
  // tocar na subida do processo, todo deploy.
  it('NÃO avisa sem marca de captura', () => {
    expect(avisoDeCapturaParada({ ...base, estado: {} })).toBeUndefined();
  });

  it('não repete o aviso dentro da janela', () => {
    expect(
      avisoDeCapturaParada({
        ...base,
        estado: { ...base.estado, ultimoAviso: AGORA - 10 * MIN },
      }),
    ).toBeUndefined();
  });

  it('volta a avisar depois da janela', () => {
    expect(
      avisoDeCapturaParada({
        ...base,
        estado: {
          ...base.estado,
          ultimoAviso: AGORA - ENTRE_AVISOS_MS - MIN,
        },
      })?.minutos,
    ).toBe(46);
  });
});

describe('textoDoAviso', () => {
  // ⚠️ O texto diz o FATO e entrega o julgamento ao humano. Afirmar "a captura
  // quebrou" mentiria toda vez que a clínica estivesse só parada.
  it('não afirma a causa', () => {
    const t = textoDoAviso(46);
    expect(t).toContain('46 min');
    expect(t).toContain('clínica parada ou captura quebrada');
    expect(t).not.toMatch(/a captura (quebrou|est[áa] quebrada)/i);
  });
});
