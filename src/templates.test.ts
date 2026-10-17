import { describe, expect, it } from 'vitest';

import {
  FECHO,
  SEPARA_MENSAGEM,
  type Tabela,
  carregaTabela,
  esqueceTabela,
  intencoesValidas,
  mensagensDe,
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
    // Tem versão curta: sem dia e hora ainda sabe dizer o "não".
    dia_sem_atendimento: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora'],
      textos: [
        'Infelizmente {dia_pedido} não temos atendimento. O próximo horário é {dia} às {hora}.',
      ],
      textos_sem_slot: ['Infelizmente nesse dia não temos atendimento.'],
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

describe('texto curto quando a agenda não deu os slots', () => {
  // Quatro cenários da passada 6 escalavam aqui: "tem como marcar no sábado?"
  // virava "Só um instante" porque o texto cheio emenda o próximo horário, e
  // a agenda só é consultada depois de necessidade e convênio.
  it('sem dia e hora, responde o "não" em vez de escalar', () => {
    // Sem NENHUM slot, que é como o modelo de fato devolve quando a agenda
    // não foi consultada. Em produção (16/10/2026) veio `slots: {}`.
    const r = renderiza(tabela, 'dia_sem_atendimento', { aleatorio: sempre });
    expect(r.acao).toBe('responder');
    expect(r.intencao).toBe('dia_sem_atendimento');
    expect(r.texto).toBe('Infelizmente nesse dia não temos atendimento.');
  });

  it('com dia e hora, segue emendando o próximo horário', () => {
    const r = renderiza(tabela, 'dia_sem_atendimento', {
      slots: { dia_pedido: 'no sábado', dia: 'segunda', hora: '10:10' },
      aleatorio: sempre,
    });
    expect(r.texto).toContain('10:10');
  });

  it('sem versão curta, continua escalando: horario_oferta não tem o que dizer', () => {
    const r = renderiza(tabela, 'horario_oferta', { aleatorio: sempre });
    expect(r.intencao).toBe('DESCONHECIDO');
    expect(r.motivo).toContain('slot obrigatório ausente');
  });

  it('a versão curta também é checada: slot aberto nela escala', () => {
    const comChave = JSON.parse(JSON.stringify(tabela)) as typeof tabela;
    comChave.intencoes.dia_sem_atendimento.textos_sem_slot = [
      'Infelizmente {dia_pedido} não temos atendimento.',
    ];
    const r = renderiza(comChave, 'dia_sem_atendimento', { aleatorio: sempre });
    expect(r.intencao).toBe('DESCONHECIDO');
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
      // Marca no iClinic a oferta que o host registrou. Não existe `remarcar`
      // nem `cancelar`: marcar é aditivo, os outros dois são destrutivos.
      'marcar',
    ]);
    for (const [nome, def] of Object.entries(t!.intencoes)) {
      expect(acoes.has(def.acao), `${nome}: ação ${def.acao}`).toBe(true);
    }
    // E a trava que importa: NENHUMA intenção pode escrever remarcação ou
    // cancelamento. Se alguém acrescentar isso à tabela, o teste cai.
    for (const [nome, def] of Object.entries(t!.intencoes)) {
      expect(
        ['remarcar', 'cancelar'].includes(def.acao),
        `${nome}: remarcar e cancelar escalam, não escrevem`,
      ).toBe(false);
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

describe('mensagensDe: a resposta pode virar mais de uma mensagem', () => {
  it('divide no separador e some com ele', () => {
    const r = mensagensDe(`Primeira.${SEPARA_MENSAGEM}Segunda.`);
    expect(r).toEqual(['Primeira.', 'Segunda.']);
    expect(r.join('')).not.toContain(SEPARA_MENSAGEM);
  });

  // ⚠️ A razão de existir um caractere de controle em vez de quebrar em "\n\n":
  // quase todo texto aprovado tem parágrafo dentro, e dividir por parágrafo
  // transformaria uma resposta em quatro bolhas.
  it('NÃO divide em parágrafo', () => {
    const dois =
      'O valor depende da técnica.\n\nPor isso o primeiro passo é a avaliação.';
    expect(mensagensDe(dois)).toEqual([dois]);
  });

  it('texto simples continua uma mensagem só', () => {
    expect(mensagensDe('Só um instante.')).toEqual(['Só um instante.']);
  });

  it('separador sobrando não vira mensagem vazia', () => {
    expect(mensagensDe(`A.${SEPARA_MENSAGEM}${SEPARA_MENSAGEM}B.`)).toEqual([
      'A.',
      'B.',
    ]);
    expect(mensagensDe(`${SEPARA_MENSAGEM}A.`)).toEqual(['A.']);
  });
});
