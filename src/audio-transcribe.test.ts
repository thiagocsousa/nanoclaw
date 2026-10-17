import { describe, expect, it } from 'vitest';

import {
  marcadorDeAudio,
  marcadorDeQueixa,
  parseSaidaStt,
  textoParaAgente,
} from './audio-transcribe.js';

/**
 * O piso duplo, que é a decisão do Thiago em 17/10/2026.
 *
 * A medição no áudio real dele mostrou a confiança ANTICORRELACIONADA com o
 * acerto clínico: a configuração que capturou "está doendo" ficou em 0.45 e
 * seria descartada pelo piso; a que passou (0.62) virou a queixa em "do Índio do
 * Mundo". Com um piso só não havia escolha boa.
 *
 * Agora o alto decide se dá para CITAR o paciente e o baixo decide se dá para
 * SUSPEITAR de queixa. O que estes testes travam é a propriedade que faz isso
 * valer a pena: **texto incerto nunca é entregue como fala dele**, por nenhum
 * dos dois caminhos.
 */
const t = (over: Partial<Parameters<typeof textoParaAgente>[0]> = {}) => ({
  texto: 'bom dia, queria marcar uma consulta',
  segundos: 9,
  confianca: 0.8,
  incerta: false,
  ...over,
});

describe('transcrição confiável é entregue', () => {
  it('cita o paciente quando passou do piso alto', () => {
    const r = textoParaAgente(t());
    expect(r).toContain('áudio transcrito');
    expect(r).toContain('queria marcar uma consulta');
  });
});

describe('transcrição incerta NUNCA é citada', () => {
  it('sem queixa: vira marcador comum', () => {
    const r = textoParaAgente(t({ incerta: true, confianca: 0.45 }));
    expect(r).toBe(marcadorDeAudio(9));
    expect(r).not.toContain('consulta');
  });

  // O caso que motivou o piso duplo: "está doendo" a 0.45.
  it('com queixa e acima do piso de urgência: marcador de QUEIXA', () => {
    const r = textoParaAgente(
      t({
        texto: 'o pereio ontem meu oito está doendo o mundo',
        incerta: true,
        confianca: 0.45,
        segundos: 6,
      }),
    );
    expect(r).toBe(marcadorDeQueixa(6));
    expect(r).toContain('queixa clínica');
  });

  // ⚠️ A propriedade que importa: nem o caminho da queixa vaza o texto. Ele é
  // incerto E é dado de saúde.
  it('o marcador de queixa não carrega o texto transcrito', () => {
    const r = textoParaAgente(
      t({
        texto: 'está doendo muito e saiu secreção amarela',
        incerta: true,
        confianca: 0.5,
      }),
    );
    expect(r).not.toContain('doendo');
    expect(r).not.toContain('secreção');
    expect(r).not.toContain('amarela');
  });

  it('abaixo do piso de urgência nem suspeita', () => {
    const r = textoParaAgente(
      t({ texto: 'dor', incerta: true, confianca: 0.1, segundos: 4 }),
    );
    expect(r).toBe(marcadorDeAudio(4));
  });
});

describe('sem transcrição alguma', () => {
  it('undefined vira marcador com os segundos do canal', () => {
    expect(textoParaAgente(undefined, 12)).toBe(marcadorDeAudio(12));
  });

  it('texto vazio vira marcador', () => {
    expect(textoParaAgente(t({ texto: '', incerta: true }))).toBe(
      marcadorDeAudio(9),
    );
  });
});

describe('parseSaidaStt', () => {
  it('lê o JSON da última linha, ignorando aviso antes', () => {
    const r = parseSaidaStt(
      'UserWarning: blah\n{"ok":true,"texto":"oi","segundos":3,"confianca":0.7,"incerta":false}',
    );
    expect(r?.texto).toBe('oi');
    expect(r?.confianca).toBe(0.7);
  });

  it('ok:false é descartado', () => {
    expect(parseSaidaStt('{"ok":false,"erro":"x"}')).toBeUndefined();
  });
});
