import { describe, expect, it } from 'vitest';

import { contextoDoRetorno } from './retorno-contexto.js';

const HOJE = new Date('2026-10-19T12:00:00Z');

describe('contexto que a recepção recebe num retorno', () => {
  it('um cadastro, dentro dos 30 dias', () => {
    const r = contextoDoRetorno(
      [{ nome: 'THIAGO CARVALHO', ultima_consulta: '2026-10-02' }],
      HOJE,
    );
    expect(r).toContain('02/10/2026');
    expect(r).toContain('há 17 dias');
    expect(r).toContain('dentro dos 30 dias');
  });

  // O que decide a cobrança: fora dos 30 dias não é retorno, é consulta nova.
  it('fora dos 30 dias é dito com todas as letras', () => {
    const r = contextoDoRetorno(
      [{ nome: 'ANA', ultima_consulta: '2026-08-01' }],
      HOJE,
    );
    expect(r).toContain('fora dos 30 dias');
  });

  it('exatamente 30 dias ainda está dentro', () => {
    const r = contextoDoRetorno(
      [{ nome: 'ANA', ultima_consulta: '2026-09-19' }],
      HOJE,
    );
    expect(r).toContain('dentro dos 30 dias');
  });

  // Telefone de uma casa devolve pai e filha: a recepção precisa das duas
  // linhas para saber de quem é o retorno.
  it('dois cadastros, duas linhas', () => {
    const r = contextoDoRetorno(
      [
        { nome: 'THIAGO', ultima_consulta: '2026-10-02' },
        { nome: 'MANUELA', ultima_consulta: '2026-05-17' },
      ],
      HOJE,
    );
    expect(r).toContain('THIAGO');
    expect(r).toContain('MANUELA');
    expect(r.split('|')).toHaveLength(2);
  });

  it('cadastro sem consulta registrada', () => {
    const r = contextoDoRetorno([{ nome: 'NOVO', ultima_consulta: '' }], HOJE);
    expect(r).toContain('sem consulta registrada');
  });

  // Telefone fora do cadastro raramente é retorno de verdade, e dizer isso já
  // faz a recepção desconfiar.
  it('nenhum cadastro é informação, não silêncio', () => {
    expect(contextoDoRetorno([], HOJE)).toContain('não tem cadastro');
  });

  it('hoje e ontem são ditos por extenso', () => {
    expect(
      contextoDoRetorno([{ nome: 'A', ultima_consulta: '2026-10-19' }], HOJE),
    ).toContain('hoje');
    expect(
      contextoDoRetorno([{ nome: 'A', ultima_consulta: '2026-10-18' }], HOJE),
    ).toContain('há 1 dia');
  });

  it('data inválida não quebra nem inventa', () => {
    const r = contextoDoRetorno(
      [{ nome: 'A', ultima_consulta: 'ontem' }],
      HOJE,
    );
    expect(r).toContain('A');
    expect(r).not.toContain('dentro');
  });
});
