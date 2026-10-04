import { describe, expect, it } from 'vitest';

import { faltamNaTriagem, fraseDeTriagem } from './triagem.js';

const FORMULARIO =
  'Muito obrigada pelo seu contato. Para darmos início ao seu atendimento, poderia me informar:\n\nNome completo do paciente:\nData de nascimento:\nCidade:\nConvênio (ou particular):';

const frase = (slots: Record<string, string>, proposito?: string) =>
  fraseDeTriagem(slots, { textoCompleto: FORMULARIO, proposito });

describe('faltamNaTriagem', () => {
  it('conta só o que está vazio de verdade', () => {
    expect(faltamNaTriagem({})).toEqual([
      'nome',
      'nascimento',
      'cidade',
      'convenio',
    ]);
    expect(faltamNaTriagem({ nome: 'Joana', convenio: 'IASPI' })).toEqual([
      'nascimento',
      'cidade',
    ]);
    expect(faltamNaTriagem({ nome: '   ' })).toContain('nome');
  });
});

describe('o formulário completo é só para quem não deu nada', () => {
  it('sem nenhum dado, manda os quatro tópicos aprovados', () => {
    expect(frase({})).toBe(FORMULARIO);
  });

  it('com qualquer dado na mão, NÃO manda formulário', () => {
    const casos: Array<Record<string, string>> = [
      { nome: 'Joana' },
      { convenio: 'IASPI' },
      { cidade: 'Teresina' },
      { nome: 'Joana', cidade: 'Teresina', convenio: 'particular' },
    ];
    for (const slots of casos) {
      const t = frase(slots);
      expect(t, JSON.stringify(slots)).not.toContain(
        'Nome completo do paciente:',
      );
      expect(t).not.toContain('\n');
    }
  });
});

// O caso que o Thiago apontou: a pessoa diz "IASPI" e leva "Convênio:" de volta.
describe('nunca pede de novo o que a pessoa acabou de informar', () => {
  it('convênio informado não é perguntado', () => {
    const t = frase({ nome: 'Joana', cidade: 'Teresina', convenio: 'IASPI' });
    expect(t).not.toMatch(/conv[êe]nio/i);
    expect(t).toContain('a data de nascimento');
  });

  it('pede exatamente o que falta, e nada além', () => {
    const t = frase({ nome: 'Marcos', nascimento: '10/03/1980' });
    expect(t).toContain('a cidade');
    expect(t).toContain('o convênio');
    expect(t).not.toMatch(/nome completo/i);
    expect(t).not.toMatch(/data de nascimento/i);
  });

  it('nada faltando devolve string vazia, para não emendar pergunta nenhuma', () => {
    expect(
      frase({
        nome: 'Joana',
        nascimento: '01/01/1980',
        cidade: 'Teresina',
        convenio: 'Unimed',
      }),
    ).toBe('');
  });
});

describe('tom: pedido educado, e nunca presumindo gênero', () => {
  it('todo pedido leva "poderia me informar"', () => {
    const casos: Array<Record<string, string>> = [
      { nome: 'Joana' },
      { convenio: 'Amil' },
      { nome: 'Marcos', cidade: 'Picos' },
    ];
    for (const slots of casos) {
      expect(frase(slots), JSON.stringify(slots)).toContain(
        'poderia me informar',
      );
    }
  });

  it('NÃO usa "me passa", que foi reprovado por ser bruto', () => {
    const casos: Array<Record<string, string>> = [
      { nome: 'Joana' },
      { cidade: 'Teresina' },
    ];
    for (const slots of casos) {
      expect(frase(slots)).not.toMatch(/me (passa|manda|envia)/i);
    }
  });

  it('usa "de Nome", nunca "da" nem "do": artigo exigiria adivinhar gênero', () => {
    expect(
      frase({ nome: 'Joana', cidade: 'Teresina', convenio: 'Unimed' }),
    ).toContain('de Joana');
    const m = frase({ nome: 'Marcos', cidade: 'Teresina', convenio: 'Unimed' });
    expect(m).toContain('de Marcos');
    expect(m).not.toMatch(/\b(da|do) Marcos/);
  });

  it('só o primeiro nome, para a frase não repetir o nome inteiro', () => {
    const t = frase({
      nome: 'Joana Silva dos Santos',
      cidade: 'Teresina',
      convenio: 'Unimed',
    });
    expect(t).toContain('de Joana');
    expect(t).not.toContain('Silva');
  });

  it('lista com vírgula e "e" antes do último', () => {
    expect(frase({ nome: 'Marcos' })).toMatch(
      /a data de nascimento de Marcos, a cidade e o conv[êe]nio/,
    );
  });

  it('sem travessão e sem markdown, como a guarda exige', () => {
    const casos: Array<Record<string, string>> = [
      { nome: 'Joana' },
      {},
      { convenio: 'Amil' },
    ];
    for (const slots of casos) {
      expect(frase(slots)).not.toMatch(/[—–]|\*\*/);
    }
  });

  it('propósito vazio devolve frase independente, com maiúscula', () => {
    const t = frase({ nome: 'Joana', cidade: 'T', convenio: 'U' }, '');
    expect(t).toMatch(/^Poderia me informar/);
  });
});
