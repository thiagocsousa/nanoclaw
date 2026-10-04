import { describe, expect, it } from 'vitest';

import { interpreta } from './classify.js';
import { type Tabela, renderiza } from './templates.js';

// O parser é a fronteira entre o que o modelo diz e o que o paciente lê. O que
// estes testes protegem é uma coisa só: NENHUMA saída do modelo, por mais
// estranha que seja, pode produzir texto que a clínica não aprovou.

const tabela: Tabela = {
  _niveis_de_confianca: { limiar: 0.75 },
  intencoes: {
    endereco: { acao: 'responder', textos: ['Av. Elias João Tajra, 1170.'] },
    preco_consulta: {
      acao: 'responder',
      textos: ['A avaliação é R$ {valor_consulta}.'],
    },
    horario_oferta: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora'],
      textos: ['Tenho {dia} às {hora}.'],
    },
    DESCONHECIDO: { acao: 'escalar', textos: ['Só um instante.'] },
  },
};

describe('interpreta: saída bem comportada', () => {
  it('lê o JSON de uma linha', () => {
    const c = interpreta(
      '{"intencao":"endereco","confianca":0.95,"slots":{},"observacao":""}',
      tabela,
    );
    expect(c.intencao).toBe('endereco');
    expect(c.confianca).toBe(0.95);
  });

  it('tolera cerca de código e texto antes', () => {
    const c = interpreta(
      'Claro, aqui está:\n```json\n{"intencao":"endereco","confianca":0.9,"slots":{}}\n```',
      tabela,
    );
    expect(c.intencao).toBe('endereco');
  });

  it('aceita os slots que são dele', () => {
    const c = interpreta(
      '{"intencao":"endereco","confianca":0.9,"slots":{"nome":"Marcos","cidade":"Parnaíba","convenio":"particular"}}',
      tabela,
    );
    expect(c.slots).toEqual({
      nome: 'Marcos',
      cidade: 'Parnaíba',
      convenio: 'particular',
    });
  });
});

describe('interpreta: o modelo se comportando mal', () => {
  it('saída que não é JSON vira DESCONHECIDO', () => {
    for (const s of [
      'Olá! A clínica fica na Av. Elias João Tajra.',
      '',
      'não consegui classificar',
    ]) {
      expect(interpreta(s, tabela).intencao, s).toBe('DESCONHECIDO');
    }
  });

  it('intenção inventada vira DESCONHECIDO', () => {
    const c = interpreta(
      '{"intencao":"responder_qualquer_coisa","confianca":0.99,"slots":{}}',
      tabela,
    );
    expect(c.intencao).toBe('DESCONHECIDO');
    expect(c.rebaixou).toContain('não existe');
  });

  it('confiança fora de 0..1 vira DESCONHECIDO', () => {
    for (const v of ['1.5', '-0.2', '"alta"', 'null']) {
      const c = interpreta(
        `{"intencao":"endereco","confianca":${v},"slots":{}}`,
        tabela,
      );
      expect(c.intencao, v).toBe('DESCONHECIDO');
    }
  });

  it('DESCARTA slot que não é dele: é por aí que um preço inventado entraria', () => {
    const c = interpreta(
      '{"intencao":"preco_consulta","confianca":0.9,"slots":{"valor_consulta":"8000,00","hora":"23h"}}',
      tabela,
    );
    expect(c.intencao).toBe('preco_consulta');
    expect(c.slots).toEqual({});
    // E o texto final usa a constante da tabela, não o que o modelo mandou.
    const r = renderiza(tabela, c.intencao, {
      confianca: c.confianca,
      slots: c.slots,
      aleatorio: () => 0,
    });
    expect(r.texto).toContain('R$ 430,00');
    expect(r.texto).not.toContain('8000');
  });
});

describe('a fronteira inteira: do que o modelo diz ao que o paciente lê', () => {
  function ponta(saida: string) {
    const c = interpreta(saida, tabela);
    return renderiza(tabela, c.intencao, {
      confianca: c.confianca,
      slots: c.slots,
      aleatorio: () => 0,
    });
  }

  it('texto escrito pelo modelo NUNCA chega ao paciente', () => {
    // A pior saída possível: o modelo ignora o contrato e escreve a resposta.
    const r = ponta(
      'A cirurgia custa R$ 8.000,00 e pode ser feita amanhã no Hospital X.',
    );
    expect(r.intencao).toBe('DESCONHECIDO');
    expect(r.texto).toBe('Só um instante.');
    expect(r.texto).not.toContain('8.000');
  });

  it('confiança baixa escala em vez de responder', () => {
    const r = ponta('{"intencao":"endereco","confianca":0.4,"slots":{}}');
    expect(r.acao).toBe('escalar');
  });

  it('oferta de horário sem horário escala em vez de mandar chave', () => {
    const r = ponta(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{}}',
    );
    expect(r.acao).toBe('escalar');
    expect(r.texto).not.toContain('{dia}');
  });

  it('em nenhum caso sai texto com chave não preenchida', () => {
    for (const s of [
      '{"intencao":"endereco","confianca":0.9,"slots":{}}',
      '{"intencao":"preco_consulta","confianca":0.8,"slots":{}}',
      '{"intencao":"horario_oferta","confianca":0.9,"slots":{}}',
      'lixo',
      '{"intencao":"x","confianca":2}',
    ]) {
      expect(ponta(s).texto, s).not.toMatch(/\{\w+\}/);
    }
  });
});
