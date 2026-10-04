import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A pasta e o destino são lidos do ambiente na importação dos módulos, então
// precisam estar de pé ANTES do import dinâmico lá embaixo.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-'));
const PASTA = 'whatsapp_exec-teste';

// O que se testa aqui é a decisão do executor: quando ele vai à agenda, e o que
// faz com o resultado. O iClinic de verdade é testado à mão, contra a agenda
// real, porque mock de Playwright não prova nada sobre o iClinic.
const buscou: Array<{ perfil: string; dia?: string }> = [];
let vagasFalsas: Array<Record<string, string>> = [];

vi.mock('./vagas.js', async (orig) => {
  const real = await orig<typeof import('./vagas.js')>();
  return {
    ...real,
    buscaVagas: async (
      _f: string,
      perfil: string,
      o: { dia?: string } = {},
    ) => {
      buscou.push({ perfil, dia: o.dia });
      return vagasFalsas;
    },
  };
});

vi.mock('./config.js', async (orig) => ({
  ...(await orig<typeof import('./config.js')>()),
  GROUPS_DIR: RAIZ,
}));

const TABELA = {
  _niveis_de_confianca: { limiar: 0.75 },
  intencoes: {
    endereco: {
      acao: 'responder',
      fecho: true,
      textos: ['Av. Elias João Tajra, 1170.'],
    },
    preco_consulta: {
      acao: 'responder',
      textos: ['A avaliação é R$ {valor_consulta}.'],
    },
    horario_oferta: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora'],
      textos: ['Tenho {dia} às {hora}.'],
    },
    clinico: {
      acao: 'escalar',
      urgente: true,
      textos: [
        'Entendo, isso deve estar incomodando bastante. Só um instante.',
      ],
    },
    cobertura_no_hospital: {
      acao: 'escalar',
      motivo_escalada: 'cobertura naquele hospital (CASO DE CONVERSÃO)',
      textos: ['Só um instante.'],
    },
    triagem_dados: {
      acao: 'triagem',
      textos: [
        'Muito obrigada pelo seu contato. Para darmos início ao seu atendimento, poderia me informar:\n\nNome completo do paciente:\nData de nascimento:\nCidade:\nConvênio (ou particular):',
      ],
    },
    convenio_nao_atendido: {
      acao: 'recusar_e_triagem',
      textos: [
        'Infelizmente esse convênio a gente não atende para consulta, seria particular, no valor de R$ {valor_consulta}.',
      ],
    },
    DESCONHECIDO: { acao: 'escalar', textos: ['Só um instante.'] },
  },
};

let executa: typeof import('./executor.js').executa;
let wantsTemplates: typeof import('./executor.js').wantsTemplates;
let esqueceTabela: typeof import('./templates.js').esqueceTabela;
let enviadas: Array<{ jid: string; text: string }>;

beforeEach(async () => {
  process.env.TEMPLATE_FOLDERS = PASTA;
  process.env.ESCALONAMENTO_JID = '55999@s.whatsapp.net';
  process.env.NTFY_TOPIC = '';
  fs.mkdirSync(path.join(RAIZ, PASTA), { recursive: true });
  fs.writeFileSync(
    path.join(RAIZ, PASTA, 'templates.json'),
    JSON.stringify(TABELA),
  );
  vi.resetModules();
  const mod = await import('./executor.js');
  executa = mod.executa;
  wantsTemplates = mod.wantsTemplates;
  esqueceTabela = (await import('./templates.js')).esqueceTabela;
  esqueceTabela();
  enviadas = [];
  buscou.length = 0;
  vagasFalsas = [];
});

afterEach(() => {
  for (const f of ['escalonamentos_pendentes.json', 'escalonamentos.jsonl']) {
    fs.rmSync(path.join(RAIZ, PASTA, f), { force: true });
  }
});

const deps = () => ({
  sendMessage: (jid: string, text: string) => {
    enviadas.push({ jid, text });
  },
});

const rodar = (bruto: string, pergunta = 'oi') =>
  executa(PASTA, bruto, pergunta, deps());

const pendencias = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(RAIZ, PASTA, 'escalonamentos_pendentes.json'),
      'utf-8',
    ),
  ) as Array<Record<string, unknown>>;

describe('wantsTemplates', () => {
  it('só liga para a pasta configurada, e é desligado por padrão', () => {
    expect(wantsTemplates(PASTA)).toBe(true);
    expect(wantsTemplates('whatsapp_outra')).toBe(false);
    expect(wantsTemplates(undefined)).toBe(false);
  });
});

describe('o texto do paciente vem SEMPRE da tabela', () => {
  it('rótulo válido devolve o texto aprovado, com o fecho', async () => {
    const r = await rodar(
      '{"intencao":"endereco","confianca":0.95,"slots":{}}',
    );
    expect(r?.texto).toBe('Av. Elias João Tajra, 1170.\n\nAjudo em algo mais?');
    expect(r?.acao).toBe('responder');
  });

  it('o valor vem da tabela, não do que o modelo mandou', async () => {
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.9,"slots":{"valor_consulta":"9999,00"}}',
    );
    expect(r?.texto).toContain('R$ 430,00');
    expect(r?.texto).not.toContain('9999');
  });

  it('texto escrito pelo modelo NUNCA chega ao paciente', async () => {
    const r = await rodar(
      'A cirurgia custa R$ 8.000,00 e pode ser amanhã no Hospital X.',
    );
    expect(r?.intencao).toBe('DESCONHECIDO');
    expect(r?.texto).toBe('Só um instante.');
    expect(r?.texto).not.toContain('8.000');
  });

  it('nunca sai chave não preenchida', async () => {
    for (const bruto of [
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{}}',
      '{"intencao":"endereco","confianca":0.9,"slots":{}}',
      'lixo',
    ]) {
      const r = await rodar(bruto);
      expect(r?.texto, bruto).not.toMatch(/\{\w+\}/);
    }
  });
});

// O furo original: em 03/10 o agente "escalou" 10 de 10 vezes e a clínica não
// soube de nenhuma. Agora quem escala é o host, então não existe caminho em que
// a ação seja escalar e nada aconteça.
describe('escalada é AÇÃO do host', () => {
  it('abre pendência, grava auditoria e avisa o humano', async () => {
    const r = await rodar(
      '{"intencao":"clinico","confianca":0.98,"slots":{},"observacao":"pós-operatório com dor"}',
      'operei ontem e ta doendo',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.codigo).toMatch(/^[A-Z0-9]{4}$/);

    const p = pendencias();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ codigo: r?.codigo, urgente: true });

    const log = fs.readFileSync(
      path.join(RAIZ, PASTA, 'escalonamentos.jsonl'),
      'utf-8',
    );
    expect(JSON.parse(log.trim())).toMatchObject({
      codigo: r?.codigo,
      origem: 'host',
      urgente: true,
      pergunta: 'operei ontem e ta doendo',
    });

    expect(enviadas).toHaveLength(1);
    expect(enviadas[0].jid).toBe('55999@s.whatsapp.net');
    expect(enviadas[0].text).toContain(r?.codigo as string);
  });

  it('confiança abaixo do limiar escala, em vez de responder no palpite', async () => {
    const r = await rodar('{"intencao":"endereco","confianca":0.4,"slots":{}}');
    expect(r?.acao).toBe('escalar');
    expect(pendencias()).toHaveLength(1);
  });

  it('slot obrigatório ausente escala, em vez de mandar a chave crua', async () => {
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.99,"slots":{}}',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).not.toContain('{dia}');
    expect(pendencias()).toHaveLength(1);
  });

  it('o código é único entre as pendências abertas', async () => {
    for (let i = 0; i < 12; i++) {
      await rodar('{"intencao":"clinico","confianca":0.9,"slots":{}}');
    }
    const codigos = pendencias().map((p) => p.codigo);
    expect(new Set(codigos).size).toBe(12);
  });

  it('o código não usa caractere ambíguo: ele é ditado e redigitado', async () => {
    for (let i = 0; i < 25; i++) {
      await rodar('{"intencao":"clinico","confianca":0.9,"slots":{}}');
    }
    for (const c of pendencias().map((p) => String(p.codigo))) {
      expect(c, c).not.toMatch(/[O01ILS25Z]/);
    }
  });

  it('aviso que falha não cancela o registro: a escada ainda cobra', async () => {
    const r = await executa(
      PASTA,
      '{"intencao":"clinico","confianca":0.9,"slots":{}}',
      'dor',
      {
        sendMessage: () => {
          throw new Error('canal caiu');
        },
      },
    );
    expect(r?.acao).toBe('escalar');
    expect(pendencias()).toHaveLength(1);
  });
});

// O enquadramento do caso é o que faz a recepção ver oportunidade em vez de
// problema, e ele é texto aprovado por humano. A observação do modelo entra como
// detalhe, nunca no lugar dele.
describe('motivo da escalada: tabela antes do modelo', () => {
  it('o motivo da tabela vem primeiro, e a observação do modelo depois', async () => {
    const r = await rodar(
      '{"intencao":"cobertura_no_hospital","confianca":0.9,"slots":{},"observacao":"citou o Hospital do Olho"}',
      'o hospital do olho aceita meu plano?',
    );
    expect(r?.acao).toBe('escalar');
    const aviso = enviadas[0].text;
    const iTabela = aviso.indexOf('CASO DE CONVERSÃO');
    const iModelo = aviso.indexOf('citou o Hospital do Olho');
    expect(iTabela, aviso).toBeGreaterThan(-1);
    expect(iModelo, aviso).toBeGreaterThan(iTabela);
  });

  it('sem motivo na tabela, usa só a observação do modelo', async () => {
    await rodar(
      '{"intencao":"clinico","confianca":0.9,"slots":{},"observacao":"dor pós-operatória"}',
    );
    expect(enviadas[0].text).toContain('dor pós-operatória');
    expect(enviadas[0].text).not.toContain('CASO DE CONVERSÃO');
  });

  it('sem nada, cai na intenção, para o aviso nunca sair sem motivo', async () => {
    await rodar('{"intencao":"clinico","confianca":0.9,"slots":{}}');
    expect(enviadas[0].text).toContain('intenção clinico');
  });
});

// `dia` e `hora` são proibidos ao modelo, então sem o host indo à agenda
// NENHUMA oferta de horário seria possível. Era o estado da primeira versão.
describe('oferta de horário: quem vai à agenda é o host', () => {
  it('com necessidade e convênio, busca com o perfil cruzado e preenche o texto', async () => {
    vagasFalsas = [
      {
        data: '2026-10-06',
        dia_semana: 'segunda',
        inicio: '09:20',
        fim: '09:50',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"particular"}}',
      'tem vaga?',
    );
    expect(buscou).toEqual([{ perfil: 'particular-cirurgia', dia: undefined }]);
    expect(r?.acao).toBe('responder');
    expect(r?.texto).toBe('Tenho segunda às 09:20.');
  });

  it('sem convênio NÃO consulta a agenda, e escala', async () => {
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"rotina"}}',
    );
    expect(buscou).toEqual([]);
    expect(r?.acao).toBe('escalar');
  });

  it('agenda sem vaga escala, em vez de mandar a chave crua', async () => {
    vagasFalsas = [];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"rotina","convenio":"Unimed"}}',
    );
    expect(buscou).toEqual([{ perfil: 'unimed', dia: undefined }]);
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).not.toContain('{dia}');
  });

  it('intenção que não pede horário NÃO consulta a agenda', async () => {
    await rodar(
      '{"intencao":"endereco","confianca":0.95,"slots":{"necessidade":"rotina","convenio":"Unimed"}}',
    );
    expect(buscou).toEqual([]);
  });
});

describe('triagem: pede só o que falta', () => {
  it('sem nenhum dado, manda o formulário aprovado', async () => {
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.9,"slots":{}}',
    );
    expect(r?.texto).toContain('Nome completo do paciente:');
  });

  it('com dado na mão, frase corrida e sem formulário', async () => {
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.9,"slots":{"nome":"Joana","cidade":"Teresina","convenio":"IASPI"}}',
    );
    expect(r?.texto).not.toContain('Nome completo do paciente:');
    expect(r?.texto).toContain(
      'poderia me informar a data de nascimento de Joana',
    );
  });

  it('a recusa vem primeiro e o pedido emenda, sem repetir o convênio', async () => {
    const r = await rodar(
      '{"intencao":"convenio_nao_atendido","confianca":0.93,"slots":{"nome":"Bruno","cidade":"Teresina","convenio":"Bradesco Saúde"}}',
      'tenho bradesco, atende?',
    );
    expect(r?.texto).toMatch(/^Infelizmente esse conv/);
    expect(r?.texto).toContain('R$ 430,00');
    expect(r?.texto).toContain(
      'poderia me informar a data de nascimento de Bruno',
    );
    // Ele acabou de dizer o convênio: perguntar de novo é o vício que o Thiago
    // apontou em 04/10/2026.
    expect(r?.texto).not.toMatch(/informar.*conv[êe]nio/i);
  });

  it('recusa com tudo preenchido não pendura pergunta no fim', async () => {
    const r = await rodar(
      '{"intencao":"convenio_nao_atendido","confianca":0.93,"slots":{"nome":"Bruno","nascimento":"10/03/1980","cidade":"Teresina","convenio":"Amil"}}',
    );
    expect(r?.texto).not.toContain('poderia me informar');
    expect(r?.texto.trimEnd()).toMatch(/430,00\.$/);
  });
});

describe('sem tabela, não improvisa', () => {
  it('devolve undefined em vez de deixar o modelo escrever', async () => {
    fs.rmSync(path.join(RAIZ, PASTA, 'templates.json'));
    esqueceTabela();
    const r = await rodar(
      '{"intencao":"endereco","confianca":0.95,"slots":{}}',
    );
    expect(r).toBeUndefined();
  });
});
