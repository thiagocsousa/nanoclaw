import { describe, expect, it } from 'vitest';

import {
  FECHO,
  type Tabela,
  carregaTabela,
  esqueceTabela,
  intencoesValidas,
  renderiza,
} from './templates.js';

// O valor deste módulo é ser determinístico: mesma intenção, mesmo texto, e
// nenhuma rota em que o modelo consiga escrever algo que ninguém aprovou.
// Então os testes cobrem principalmente os REBAIXAMENTOS, que são o que impede
// uma resposta errada de sair.

const sempre = () => 0; // fixa a variante na primeira

const tabela: Tabela = {
  _niveis_de_confianca: { limiar: 0.75 },
  intencoes: {
    endereco: {
      acao: 'responder',
      fecho: true,
      textos: ['A clínica fica na Av. Elias João Tajra, 1170.'],
    },
    preco_consulta: {
      acao: 'responder',
      fecho: true,
      textos: ['A avaliação é R$ {valor_consulta}.'],
    },
    horario_oferta: {
      acao: 'responder',
      fecho: false,
      slots_obrigatorios: ['dia', 'hora'],
      textos: ['Tenho {dia} às {hora}.', 'O próximo é {dia} às {hora}.'],
    },
    clinico: {
      acao: 'escalar',
      urgente: true,
      fecho: false,
      textos: ['Entendo. Só um instante.'],
    },
    DESCONHECIDO: { acao: 'escalar', textos: ['Só um instante.'] },
  },
};

describe('renderiza', () => {
  it('devolve o texto aprovado, com o fecho quando a intenção pede', () => {
    const r = renderiza(tabela, 'endereco', { aleatorio: sempre });
    expect(r.acao).toBe('responder');
    expect(r.texto).toBe(
      `A clínica fica na Av. Elias João Tajra, 1170.\n\n${FECHO}`,
    );
  });

  it('preenche valor a partir das constantes, nunca do modelo', () => {
    const r = renderiza(tabela, 'preco_consulta', { aleatorio: sempre });
    expect(r.texto).toContain('R$ 430,00');
    expect(r.texto).not.toContain('{');
  });

  it('preenche dia e hora a partir dos slots', () => {
    const r = renderiza(tabela, 'horario_oferta', {
      slots: { dia: 'segunda', hora: '10h' },
      aleatorio: sempre,
    });
    expect(r.texto).toBe('Tenho segunda às 10h.');
  });

  it('escalonamento não leva fecho', () => {
    const r = renderiza(tabela, 'clinico', { aleatorio: sempre });
    expect(r.acao).toBe('escalar');
    expect(r.urgente).toBe(true);
    expect(r.texto).not.toContain(FECHO);
  });
});

describe('rebaixamentos: é aqui que a resposta errada deixa de sair', () => {
  it('intenção fora da tabela vira escalonamento', () => {
    const r = renderiza(tabela, 'inventei_essa', { aleatorio: sempre });
    expect(r.intencao).toBe('DESCONHECIDO');
    expect(r.acao).toBe('escalar');
    expect(r.motivo).toContain('não está na tabela');
  });

  it('confiança abaixo do limiar vira escalonamento', () => {
    const r = renderiza(tabela, 'endereco', {
      confianca: 0.6,
      aleatorio: sempre,
    });
    expect(r.intencao).toBe('DESCONHECIDO');
    expect(r.motivo).toContain('abaixo do limiar');
  });

  it('confiança exatamente no limiar passa', () => {
    expect(
      renderiza(tabela, 'endereco', { confianca: 0.75, aleatorio: sempre })
        .intencao,
    ).toBe('endereco');
  });

  it('slot obrigatório ausente vira escalonamento, não texto com chaves', () => {
    // O caso concreto: oferecer horário sem ter horário.
    const r = renderiza(tabela, 'horario_oferta', { aleatorio: sempre });
    expect(r.intencao).toBe('DESCONHECIDO');
    expect(r.motivo).toContain('slot obrigatório ausente');
    expect(r.texto).not.toContain('{dia}');
  });

  it('NENHUM rebaixamento deixa chave sem preencher no texto final', () => {
    for (const intencao of Object.keys(tabela.intencoes)) {
      const r = renderiza(tabela, intencao, { aleatorio: sempre });
      expect(r.texto, intencao).not.toMatch(/\{\w+\}/);
    }
  });
});

describe('variantes', () => {
  it('sorteia entre os textos, e todos ficam sem chave', () => {
    const vistos = new Set<string>();
    for (const r of [0, 0.99]) {
      const out = renderiza(tabela, 'horario_oferta', {
        slots: { dia: 'quarta', hora: '15h' },
        aleatorio: () => r,
      });
      expect(out.texto).not.toContain('{');
      vistos.add(out.texto);
    }
    expect(vistos.size).toBe(2);
  });
});

describe('a tabela real do grupo de teste', () => {
  it('carrega, e toda intenção tem ação válida', () => {
    esqueceTabela();
    const t = carregaTabela('whatsapp_atendimento-teste');
    expect(t, 'templates.json do grupo de teste').toBeDefined();
    const acoes = new Set([
      'responder',
      'escalar',
      'triagem',
      'recusar_e_triagem',
    ]);
    for (const [nome, def] of Object.entries(t!.intencoes)) {
      expect(acoes.has(def.acao), `${nome}: ação ${def.acao}`).toBe(true);
    }
  });

  it('tem DESCONHECIDO, que é o destino de todo rebaixamento', () => {
    const t = carregaTabela('whatsapp_atendimento-teste')!;
    expect(t.intencoes.DESCONHECIDO).toBeDefined();
    expect(t.intencoes.DESCONHECIDO.acao).toBe('escalar');
  });

  it('todo texto renderiza sem deixar chave, com os slots declarados', () => {
    const t = carregaTabela('whatsapp_atendimento-teste')!;
    const slots = {
      dia: 'segunda',
      data: '06/10',
      hora: '10h',
      dia_pedido: 'sábado',
    };
    for (const intencao of Object.keys(t.intencoes)) {
      const r = renderiza(t, intencao, { slots, aleatorio: sempre });
      expect(r.texto, `${intencao} -> ${r.texto}`).not.toMatch(/\{\w+\}/);
    }
  });

  it('expõe as intenções válidas para o prompt do classificador', () => {
    const t = carregaTabela('whatsapp_atendimento-teste')!;
    const lista = intencoesValidas(t);
    expect(lista).not.toContain('DESCONHECIDO');
    expect(lista.length).toBeGreaterThan(15);
  });
});
