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
const buscou: Array<{
  perfil: string;
  dia?: string;
  hora?: string;
  antecedencia?: number;
}> = [];
let vagasFalsas: Array<Record<string, string>> = [];
let buscouHook: (() => void) | undefined;

const marcou: Array<Record<string, string>> = [];
let ofertaFalsa: unknown;
let marcaFalha: string | undefined;

vi.mock('./agendamento.js', async (orig) => {
  const real = await orig<typeof import('./agendamento.js')>();
  return {
    ...real,
    ultimaOferta: () => ofertaFalsa,
    registraOferta: (_f: string, _j: string, o: Record<string, unknown>) => {
      ofertaFalsa = o;
    },
    esqueceOferta: () => {
      ofertaFalsa = undefined;
    },
    marca: async (_f: string, d: Record<string, string>) => {
      marcou.push(d);
      return marcaFalha
        ? { ok: false, motivo: 'vaga_tomada', detalhe: marcaFalha }
        : { ok: true, marcacao: d, jaExistia: false };
    },
  };
});

let candidatosFalsos: Array<{ id: number; nome: string; nascimento: string }> =
  [];
let buscasPorTelefone: string[] = [];
vi.mock('./paciente.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    pacientesComTelefone: async (_f: string, tel: string) => {
      buscasPorTelefone.push(tel);
      return candidatosFalsos;
    },
  };
});

vi.mock('./vagas.js', async (orig) => {
  const real = await orig<typeof import('./vagas.js')>();
  return {
    ...real,
    buscaVagas: async (
      _f: string,
      perfil: string,
      o: { dia?: string; hora?: string; antecedencia?: number } = {},
    ) => {
      buscou.push({
        perfil,
        dia: o.dia,
        hora: o.hora,
        antecedencia: o.antecedencia,
      });
      buscouHook?.();
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
    abertura: {
      acao: 'responder',
      textos: ['Olá! Me conta o que você precisa que eu te ajudo.'],
    },
    pergunta_necessidade: {
      acao: 'responder',
      textos: ['Você está procurando cirurgia, ou uma consulta de rotina?'],
    },
    // O convite LEVE: vai para quem ainda não se identificou.
    convite_horario: {
      acao: 'responder',
      textos: ['Se quiser, eu já vejo um horário para você.'],
    },
    quer_horario: {
      acao: 'triagem',
      textos: ['Perfeito.'],
    },
    endereco: {
      acao: 'responder',
      fecho: true,
      textos: ['Av. Elias João Tajra, 1170.'],
    },
    preco_consulta: {
      acao: 'responder',
      emenda_triagem: true,
      textos: ['A avaliação é R$ {valor_consulta}.'],
    },
    desconto: {
      acao: 'responder',
      textos: [
        'Infelizmente a gente não atende o seu convênio.\n\nComo você já paga um plano, a avaliação sai por R$ {valor_desconto} em vez de R$ {valor_consulta}.',
      ],
    },
    // Responde e NÃO pede dia/hora: é a trava de que a regra de retorno/exame
    // não atinge resposta de preço.
    exames_preco: {
      acao: 'responder',
      fecho: true,
      textos: ['A topografia é R$ 150,00.'],
    },
    horario_oferta: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora'],
      textos: ['Tenho {dia} às {hora}.'],
      textos_dois: [
        'Tenho {dia} às {hora}, ou {dia_b} às {hora_b}. Qual fica melhor?',
      ],
    },
    horario_pedido_indisponivel: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora'],
      textos: [
        'Nesse horário não consigo encaixar, mas tenho {dia} às {hora}.',
      ],
    },
    pergunta_lente: {
      acao: 'responder',
      textos: ['Antes de eu ver os horários: você usa lente de contato?'],
    },
    usa_lente: {
      acao: 'responder',
      textos: ['São 3 dias sem usar a lente antes da consulta.'],
    },
    nao_usa_lente: { acao: 'triagem', textos: ['Perfeito.'] },
    pergunta_dia: {
      acao: 'responder',
      textos: ['Para qual dia você quer esse horário?'],
    },
    horario_pedido_convenio: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora'],
      textos: [
        'Pelo convênio os horários seguem a agenda. Tenho {dia} às {hora}.',
      ],
    },
    qual_horario: {
      acao: 'responder',
      slots_obrigatorios: ['dia', 'hora', 'dia_b', 'hora_b'],
      textos: [
        'Só para eu não errar: {dia}, às {hora}, ou {dia_b}, às {hora_b}?',
      ],
    },
    clinico: {
      acao: 'escalar',
      urgente: true,
      textos: [
        'Entendo, isso deve estar incomodando bastante. Só um instante.',
      ],
    },
    quer_humano: {
      acao: 'escalar',
      sem_resposta: true,
      textos: ['Só um instante.'],
    },
    pergunta_se_e_bot: {
      acao: 'escalar',
      sem_resposta: true,
      textos: ['Só um instante.'],
    },
    cobertura_no_hospital: {
      acao: 'escalar',
      motivo_escalada: 'cobertura naquele hospital (CASO DE CONVERSÃO)',
      textos: ['Só um instante.'],
    },
    confirma_paciente: {
      acao: 'responder',
      slots_obrigatorios: ['paciente'],
      textos: ['É para você, {paciente}, ou para outra pessoa?'],
    },
    paciente_confirmado: {
      acao: 'triagem',
      textos: [
        'Muito obrigada pelo seu contato. Para darmos início ao seu atendimento, poderia me informar:\n\nNome completo do paciente:\nData de nascimento:\nCidade:\nConvênio (ou particular):',
      ],
    },
    paciente_outro: {
      acao: 'triagem',
      textos: [
        'Muito obrigada pelo seu contato. Para darmos início ao seu atendimento, poderia me informar:\n\nNome completo do paciente:\nData de nascimento:\nCidade:\nConvênio (ou particular):',
      ],
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
    // Os cinco abaixo cobrem a emenda condicional do convite e a troca do
    // enquadramento refrativo (tom de 17/10/2026). `emenda_triagem` marca quem
    // oferece o próximo passo; quem não tem a marca responde e para.
    convenio_iaspi: {
      acao: 'responder',
      emenda_triagem: true,
      textos: [
        'A consulta pelo IASPI é particular. A cirurgia sai pelo PLAMTA.',
      ],
    },
    convenio_ipmt: {
      acao: 'responder',
      emenda_triagem: true,
      textos: [
        'A consulta pelo IPMT é particular. A cirurgia sai pelo PLANTE.',
      ],
    },
    pentacam_cobertura: {
      acao: 'responder',
      textos: ['O Pentacam é particular e não fazemos no consultório.'],
    },
    preco_cirurgia: {
      acao: 'responder',
      emenda_triagem: true,
      textos: ['Depende da técnica. A avaliação é R$ {valor_consulta}.'],
    },
    preco_cirurgia_refrativa: {
      acao: 'responder',
      emenda_triagem: true,
      textos: [
        'A refrativa ajuda quem quer diminuir a dependência dos óculos. A avaliação é R$ {valor_consulta}.',
      ],
    },
    aceita_horario: {
      acao: 'marcar',
      textos: [
        'Pronto, {paciente}, está agendado para {dia}, dia {data}, às {hora}.',
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
  marcou.length = 0;
  ofertaFalsa = undefined;
  marcaFalha = undefined;
  // A memória de conversa persiste em arquivo e todos os testes usam o mesmo
  // JID, então sem isto um teste herda a necessidade e o convênio do anterior.
  // Em produção cada paciente é um chatJid; aqui é um só.
  fs.rmSync(path.join(RAIZ, PASTA, 'slots_conversa.json'), { force: true });
  candidatosFalsos = [];
  buscasPorTelefone = [];
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

const JID = '5586999@s.whatsapp.net';

const rodar = (bruto: string, pergunta = 'oi') =>
  executa(PASTA, bruto, pergunta, deps(), JID);

// Em grupo, quem escreve não é o chat: o telefone do paciente sai do REMETENTE.
// O JID acima nem é telefone válido, de propósito — quem precisa de telefone
// passa um aqui.
const REMETENTE = '558681512111@s.whatsapp.net';
const rodarDe = (bruto: string, pergunta = 'oi', remetente = REMETENTE) =>
  executa(PASTA, bruto, pergunta, deps(), JID, remetente);

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
      JID,
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
    // Desde 19/10/2026 a refrativa passa pela pergunta da lente antes de ir à
    // agenda (Marina: 3 dias sem usar, qualquer tipo). O que este teste mede é
    // o PERFIL cruzado, então responde a pergunta e segue.
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar(
      '{"intencao":"nao_usa_lente","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"particular"}}',
      'não uso lente',
    );
    buscou.length = 0;
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"particular"}}',
      'tem vaga?',
    );
    expect(buscou).toEqual([
      {
        perfil: 'particular-cirurgia',
        dia: undefined,
        hora: undefined,
        antecedencia: undefined,
      },
    ]);
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

describe('desconto da consulta é decisão do HOST (regra de 06/10/2026)', () => {
  // Cirurgia + plano NÃO aceito = R$ 300. As duas condições juntas.
  it('cirúrgico com plano não aceito recebe o DESCONTO, não o preço cheio', async () => {
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"Bradesco Saude"}}',
      'e quanto fica a consulta?',
    );
    expect(r?.texto).toContain('300');
    expect(r?.texto).not.toMatch(/\b430\b.*\b430\b/s);
  });

  it('a recusa do convênio também vira desconto, e MANTÉM o pedido dos dados', async () => {
    const r = await rodar(
      '{"intencao":"convenio_nao_atendido","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"Bradesco","nome":"Victor","cidade":"Teresina"}}',
      'tenho Bradesco',
    );
    expect(r?.texto).toContain('300');
    // a emenda da triagem não pode sumir: falta o nascimento
    expect(r?.texto.toLowerCase()).toContain('nascimento');
  });

  it('cirúrgico PARTICULAR paga cheia: sem plano não há desconto', async () => {
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"particular"}}',
    );
    expect(r?.texto).not.toContain('300');
  });

  it('ROTINA com plano não aceito paga cheia: falta a intenção cirúrgica', async () => {
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"rotina","convenio":"Bradesco"}}',
    );
    expect(r?.texto).not.toContain('300');
  });

  // Decisão do Thiago em 07/10/2026, e é contraintuitiva: Intermed, Hapvida e
  // Humana são recusados para consulta E cirurgia pelo `convenio_bloqueado`,
  // mas RECEBEM o desconto. Na consulta descobrem que o plano não cobre a
  // cirurgia, e é aí que se tenta a conversão para particular.
  it('plano bloqueado TAMBÉM recebe o desconto (é a conversão)', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    for (const plano of ['Intermed', 'Hapvida', 'Humana']) {
      esqueceSlots(PASTA, JID);
      const r = await rodar(
        `{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"${plano}"}}`,
      );
      expect(r?.texto, plano).toContain('300');
    }
  });

  it('Unimed é atendido, então não é caso de desconto', async () => {
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"Unimed"}}',
    );
    expect(r?.texto).not.toContain('300');
  });

  // O turno do preço não repete necessidade nem convênio: o paciente os disse
  // antes. Sem memória no host a regra avalia falso e ele ouve R$ 430 — foi
  // exatamente o que a passada 5 mostrou em produção (07/10/2026).
  it('lembra do que a CONVERSA disse: preço pedido dois turnos depois', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);

    await rodar(
      '{"intencao":"convenio_nao_atendido","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"Bradesco Saude","nome":"Victor"}}',
      'Victor, Teresina, tenho Bradesco Saude',
    );
    // turno seguinte SEM slots, como o modelo de fato devolve
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.97,"slots":{}}',
      'e quanto fica a consulta?',
    );
    expect(r?.texto).toContain('300');
  });

  it('o turno atual VENCE o lembrado: mudou para rotina, paga cheia', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);

    await rodar(
      '{"intencao":"convenio_nao_atendido","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"Bradesco"}}',
    );
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"rotina"}}',
    );
    expect(r?.texto).not.toContain('300');
  });

  it('intenção que não cita preço não é trocada', async () => {
    const r = await rodar(
      '{"intencao":"endereco","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"Bradesco"}}',
    );
    expect(r?.intencao).toBe('endereco');
  });
});

describe('perguntar preço leva ao próximo passo (Thiago, 18/10/2026)', () => {
  // A análise de conversão: "quanto custa a consulta" é a pergunta de preço
  // mais comum do corpus (24 conversas, contra 18 da cirurgia) e era a única
  // das duas que não convidava. Terminava em "Ajudo em algo mais?".
  // Quem só perguntou o preço, sem se identificar, recebe o convite LEVE.
  // Três campos de cara é o que o manual chama de exigir cadastro para
  // informar valor (Thiago, 19/10/2026: "o melhor dos dois").
  it('quem só pesquisa preço recebe o convite leve', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{}}',
      'quanto custa a consulta?',
    );
    expect(r?.texto).toContain('430');
    expect(r?.texto).toContain('eu já vejo um horário');
    expect(r?.texto.toLowerCase()).not.toContain('poderia me informar');
    expect(r?.texto).not.toContain('Ajudo em algo mais');
  });

  // Quem já se identificou está marcando: pedir o que falta é o passo útil.
  it('quem já deu dado pessoal recebe o pedido do que falta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"nome":"Thiago","convenio":"particular"}}',
      'sou Thiago, particular. quanto custa a consulta?',
    );
    expect(r?.texto).toContain('430');
    expect(r?.texto.toLowerCase()).toContain('poderia me informar');
    expect(r?.texto).not.toContain('eu já vejo um horário');
  });

  // ⚠️ `necessidade` não conta como compromisso: ela é preenchida por qualquer
  // pergunta, e usá-la faria o convite leve nunca acontecer.
  it('saber só o ASSUNTO não dispara o pedido de dados', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      'quanto custa a consulta pra catarata?',
    );
    expect(r?.texto).toContain('eu já vejo um horário');
  });

  it('o convite leve também sai UMA vez por conversa', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar('{"intencao":"preco_consulta","confianca":0.95,"slots":{}}');
    const r = await rodar(
      '{"intencao":"exames_preco","confianca":0.95,"slots":{}}',
      'e os exames?',
    );
    expect(r?.texto).not.toContain('eu já vejo um horário');
  });

  it('mas convida UMA vez: a segunda pergunta de preço só responde', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar('{"intencao":"preco_consulta","confianca":0.95,"slots":{}}');
    const r = await rodar(
      '{"intencao":"exames_preco","confianca":0.95,"slots":{}}',
      'e os exames?',
    );
    expect(r?.texto).toContain('150');
    expect(r?.texto.toLowerCase()).not.toContain('poderia me informar');
  });
});

describe('insistir no mesmo assunto escala (Thiago, 17/10/2026)', () => {
  // O FAQ manda "escalar: se insistir" em quatro blocos e nada contava.
  it('a MESMA resposta pela terceira vez escala', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const p = (n: number) =>
      rodar(
        '{"intencao":"preco_consulta","confianca":0.95,"slots":{}}',
        `quanto é a consulta? (${n})`,
      );
    // O que importa nos dois primeiros é NÃO escalar. A ação exata varia:
    // desde 18/10 o `preco_consulta` convida, então o primeiro turno sai como
    // `recusar_e_triagem`. Assertar 'responder' aqui era precisão falsa.
    expect((await p(1))?.acao).not.toBe('escalar');
    expect((await p(2))?.acao).not.toBe('escalar');
    const terceira = await p(3);
    expect(terceira?.acao).toBe('escalar');
    expect(String(pendencias().pop()?.motivo)).toMatch(/3 vezes seguidas/);
  });

  // O caso exato que a passada 13 pegou: a intenção tem `emenda_triagem`, o
  // primeiro turno vira `recusar_e_triagem`, e a contagem pulava ele.
  it('conta mesmo quando o convite converteu a ação', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const p = (n: number) =>
      rodar(
        '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{}}',
        `quanto custa a cirurgia? (${n})`,
      );
    await p(1); // recusar_e_triagem: responde e emenda o pedido dos dados
    await p(2);
    expect((await p(3))?.acao).toBe('escalar');
  });

  it('mudar de assunto zera a contagem', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar('{"intencao":"preco_consulta","confianca":0.95,"slots":{}}');
    await rodar('{"intencao":"preco_consulta","confianca":0.95,"slots":{}}');
    await rodar('{"intencao":"endereco","confianca":0.95,"slots":{}}');
    // A terceira de preço agora é a PRIMEIRA desde que o assunto mudou.
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{}}',
    );
    expect(r?.acao).toBe('responder');
  });

  // ⚠️ A trava que impede isto de estragar a coleta: triagem repete de
  // propósito enquanto pede um campo por vez, e isso é o caso BOM.
  it('triagem pode repetir sem escalar', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    for (const slots of [
      '{"nome":"Thiago"}',
      '{"nascimento":"01/06/1980"}',
      '{"cidade":"Teresina"}',
    ]) {
      const r = await rodar(
        `{"intencao":"triagem_dados","confianca":0.95,"slots":${slots}}`,
      );
      expect(r?.acao, slots).not.toBe('escalar');
    }
  });
});

describe('triagem completa vira oferta de horário (Thiago, 17/10/2026)', () => {
  // O turno 4 do E08: a mensagem dá os dados que faltavam E pede horário. O
  // classificador rotula `triagem_dados`, e antes disto o host respondia "Só um
  // instante." com os quatro dados e a necessidade na mão.
  it('dá os dados e pede horário na mesma mensagem: oferta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-22',
        dia_semana: 'quinta',
        inicio: '09:00',
        fim: '09:20',
      },
    ];
    await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      'é pra cirurgia de catarata',
    );
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular. tem horario?',
    );
    expect(r?.texto).toMatch(/09:00/);
    expect(r?.acao).toBe('responder');
  });

  it('com dado faltando continua pedindo, não oferta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-22',
        dia_semana: 'quinta',
        inicio: '09:00',
        fim: '09:20',
      },
    ];
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata","nome":"Thiago","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, Teresina, particular',
    );
    expect(r?.texto).not.toMatch(/09:00/);
    expect(r?.texto.toLowerCase()).toContain('nascimento');
  });

  it('sem necessidade não oferta: o perfil dependeria de adivinhar', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-22',
        dia_semana: 'quinta',
        inicio: '09:00',
        fim: '09:20',
      },
    ];
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular',
    );
    expect(r?.texto).not.toMatch(/09:00/);
  });

  // A trava que importa: retorno e exame a Lara NÃO agenda, e a troca não pode
  // furar isso. Quem barra é o `soHumano` dentro do bloco da agenda.
  it('retorno com triagem completa escala, não oferta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-22',
        dia_semana: 'quinta',
        inicio: '09:00',
        fim: '09:20',
      },
    ];
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"retorno","nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).not.toMatch(/09:00/);
  });
});

describe('a triagem não repete o que a CONVERSA já respondeu (Codex, 17/10/2026)', () => {
  // O cenário do achado: um campo por mensagem. O classificador extrai só a
  // mensagem atual, então sem memória a triagem pedia tudo de novo.
  it('um campo por mensagem, e nenhum é pedido duas vezes', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);

    const t1 = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata","nome":"Marcos"}}',
      'sou o Marcos, quero operar catarata',
    );
    expect(t1?.texto.toLowerCase()).toContain('nascimento');

    const t2 = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nascimento":"12/03/1980"}}',
      '12/03/1980',
    );
    // Nascimento veio: não pode ser pedido de novo.
    expect(t2?.texto.toLowerCase()).not.toContain('nascimento');
    expect(t2?.texto.toLowerCase()).not.toContain('nome completo');

    const t3 = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"cidade":"Teresina"}}',
      'Teresina',
    );
    // Cidade era o único campo que a memória não guardava.
    expect(t3?.texto.toLowerCase()).not.toContain('cidade');
    expect(t3?.texto.toLowerCase()).not.toContain('nascimento');
  });

  // A linha vizinha à do achado 5, que eu deixei lendo só o turno. A passada 11
  // cobrou no E08.
  it('não pergunta a necessidade que a conversa já disse', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      'é pra cirurgia de catarata',
    );
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular. tem horario?',
    );
    expect(r?.texto).not.toMatch(/cirurgia, ou uma consulta de rotina/i);
  });

  it('a cidade sobrevive ao turno em que foi dita', async () => {
    const { esqueceSlots, comLembrados } =
      await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"cidade":"Picos"}}',
      'Picos',
    );
    const lembrado = comLembrados(PASTA, JID, {} as Record<string, string>);
    expect(lembrado.cidade).toBe('Picos');
  });
});

describe('o valor da avaliação é o mesmo em toda a conversa (Codex, 17/10/2026)', () => {
  // O cenário exato do achado: dois turnos, duas perguntas de preço, dois
  // valores diferentes para a MESMA pessoa.
  it('quem tem desconto ouve 300 também ao perguntar o preço da cirurgia', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const consulta = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa","convenio":"Bradesco"}}',
      'quanto fica a consulta?',
    );
    expect(consulta?.texto).toContain('300');

    const cirurgia = await rodar(
      '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{}}',
      'e quanto custa a cirurgia?',
    );
    expect(cirurgia?.texto).toContain('300');
    expect(cirurgia?.texto).not.toContain('430');
  });

  it('o enquadramento refrativo também segue o desconto', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos","convenio":"Bradesco"}}',
      'quanto custa pra parar de usar óculos?',
    );
    expect(r?.texto).toContain('óculos');
    expect(r?.texto).toContain('300');
    expect(r?.texto).not.toContain('430');
  });

  it('sem desconto continua 430', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"Unimed"}}',
      'quanto custa a cirurgia?',
    );
    expect(r?.texto).toContain('430');
    expect(r?.texto).not.toContain('300');
  });

  // A trava da exceção: o texto do desconto CONTRASTA os dois valores, e
  // sobrescrever ali faria "R$ 300 em vez de R$ 300".
  it('o texto do desconto mantém os dois valores distintos', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"Bradesco"}}',
      'quanto fica a consulta?',
    );
    expect(r?.texto).toContain('300');
    expect(r?.texto).toContain('430');
  });
});

describe('trocar de paciente esquece quem era (Codex, 17/10/2026)', () => {
  // O cenário do achado: a pessoa confirma que é ela, depois corrige que é para
  // a filha. O id do titular ficava na memória e a marcação ia nele.
  it('paciente_outro apaga o id, o nome e o nascimento do titular', async () => {
    const { esqueceSlots, pacienteConfirmado, comLembrados } =
      await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    candidatosFalsos = [
      { id: 42, nome: 'JOAO DA SILVA', nascimento: '1958-07-09' },
    ];
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      'quero marcar',
    );
    await rodar(
      '{"intencao":"paciente_confirmado","confianca":0.95,"slots":{}}',
    );
    expect(pacienteConfirmado(PASTA, JID)).toBe(42);

    await rodar(
      '{"intencao":"paciente_outro","confianca":0.95,"slots":{}}',
      'na verdade é pra minha filha',
    );
    expect(pacienteConfirmado(PASTA, JID)).toBeUndefined();
    const lembrado = comLembrados(PASTA, JID, {} as Record<string, string>);
    expect(lembrado.nome).toBeUndefined();
    expect(lembrado.nascimento).toBeUndefined();
  });

  it('paciente_outro também mata a oferta pendente do titular', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    const { ultimaOferta, registraOferta } = await import('./agendamento.js');
    esqueceSlots(PASTA, JID);
    registraOferta(PASTA, JID, {
      vaga: { data: '2026-10-20', inicio: '09:00', fim: '09:20' },
      perfil: 'particular',
      nome: 'JOAO DA SILVA',
    } as never);
    expect(ultimaOferta(PASTA, JID)).toBeDefined();
    await rodar(
      '{"intencao":"paciente_outro","confianca":0.95,"slots":{}}',
      'é pra minha filha',
    );
    expect(ultimaOferta(PASTA, JID)).toBeUndefined();
  });
});

describe('o limiar vale ANTES de gravar (Codex, 17/10/2026)', () => {
  it('confiança baixa escala e NÃO grava os slots na memória', async () => {
    const { esqueceSlots, comLembrados } =
      await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.2,"slots":{"necessidade":"catarata","convenio":"Bradesco"}}',
      'sei la',
    );
    expect(r?.acao).toBe('escalar');
    // O que o review pegou: o turno gravava antes do limiar, e aí o turno
    // SEGUINTE lia como fato o que ninguém confiou.
    const lembrado = comLembrados(PASTA, JID, {} as Record<string, string>);
    expect(lembrado.necessidade).toBeUndefined();
    expect(lembrado.convenio).toBeUndefined();
  });

  it('confiança baixa NÃO fixa o cadastro confirmado', async () => {
    const { esqueceSlots, pacienteConfirmado } =
      await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    candidatosFalsos = [
      { id: 7, nome: 'ZULMIRA SOUSA', nascimento: '1950-03-02' },
    ];
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      'quero marcar',
    );
    const r = await rodar(
      '{"intencao":"paciente_confirmado","confianca":0.1,"slots":{}}',
      'aham',
    );
    expect(r?.acao).toBe('escalar');
    expect(pacienteConfirmado(PASTA, JID)).toBeUndefined();
  });

  it('o escalonamento registra a confiança no motivo', async () => {
    const r = await rodar(
      '{"intencao":"endereco","confianca":0.3,"slots":{}}',
      'onde fica?',
    );
    expect(r?.acao).toBe('escalar');
    const p = pendencias();
    expect(String(p[p.length - 1].motivo)).toMatch(/0\.30.*limiar/);
  });

  it('confiança no limiar exato passa', async () => {
    const r = await rodar(
      '{"intencao":"endereco","confianca":0.75,"slots":{}}',
      'onde fica?',
    );
    expect(r?.texto).toContain('Elias João Tajra');
  });
});

describe('retorno e exame não passam pelo formulário (Thiago, 19/10/2026)', () => {
  // Medido antes de mexer: "quero marcar meu retorno" virava `triagem_dados`,
  // o paciente digitava os QUATRO campos e só então ouvia "Só um instante".
  // Justamente quem a clínica já tem no cadastro.
  // ⚠️ COM cadastro, que é a população real do retorno. A primeira versão
  // deste teste rodava com `candidatosFalsos` vazio e passava por acidente: o
  // `confirma_paciente` interceptava o turno em produção e devolvia "é você,
  // Thiago?", então o conserto era inalcançável justamente para quem ele
  // existia. Achado da revisão de eficiência em 19/10/2026.
  it('retorno COM cadastro escala na hora, sem perguntar identidade', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    candidatosFalsos = [
      {
        id: 47555744,
        nome: 'THIAGO CARVALHO DE SOUSA',
        nascimento: '1980-06-01',
      },
    ];
    const r = await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"retorno"}}',
      'queria marcar meu retorno',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).not.toContain('É para você');
    expect(r?.texto.toLowerCase()).not.toContain('nome completo');
  });

  it('retorno sem dados escala na hora, sem pedir nada', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    candidatosFalsos = [];
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"retorno"}}',
      'quero marcar meu retorno',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto.toLowerCase()).not.toContain('nome completo');
    expect(String(pendencias().pop()?.motivo)).toMatch(/retorno/);
  });

  it('exame também', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"exame"}}',
      'quero marcar o mapeamento',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto.toLowerCase()).not.toContain('nome completo');
  });

  // ⚠️ O outro lado: em `recusar_e_triagem` a resposta JÁ SAIU e é aprovada.
  // Escalar ali engoliria uma resposta correta — "quanto custa o retorno?"
  // continua sendo respondido.
  it('pergunta de PREÇO sobre retorno continua respondida', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_consulta","confianca":0.95,"slots":{"necessidade":"retorno","convenio":"particular"}}',
      'quanto custa o retorno?',
    );
    expect(r?.acao).not.toBe('escalar');
    expect(r?.texto).toContain('430');
  });

  it('consulta normal segue pedindo os dados', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"rotina"}}',
      'quero marcar uma consulta',
    );
    expect(r?.acao).not.toBe('escalar');
    expect(r?.texto.toLowerCase()).toContain('nome completo');
  });
});

describe('dia e hora pedidos pelo paciente (Thiago, 19/10/2026)', () => {
  it('o DIA pedido chega à agenda como data', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-23',
        dia_semana: 'sexta',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular","dia_pedido":"sexta"}}',
      'tem vaga na sexta?',
    );
    // Antes de 19/10 isto ia vazio: `diaIso` só aceitava ISO e o modelo manda
    // "sexta", então o pedido de dia era descartado em silêncio.
    expect(buscou[0]?.dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a HORA pedida vale no particular', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-23',
        dia_semana: 'sexta',
        inicio: '10:00',
        fim: '10:30',
      },
    ];
    await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular","dia_pedido":"sexta","hora_pedida":"10h"}}',
      'pode ser sexta às 10h?',
    );
    expect(buscou[0]?.hora).toBe('10:00');
  });

  // ⚠️ No convênio a agenda manda: a hora pedida NÃO vai ao script, e o host
  // EXPLICA em vez de ignorar e oferecer o mesmo horário de novo.
  it('a hora pedida NÃO vale no convênio, e a Lara explica', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-23',
        dia_semana: 'sexta',
        inicio: '08:40',
        fim: '09:00',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"rotina","convenio":"Unimed","dia_pedido":"sexta","hora_pedida":"10h"}}',
      'pode ser sexta às 10h?',
    );
    expect(buscou[0]?.hora).toBeUndefined();
    expect(r?.texto).toContain('seguem a agenda');
    expect(r?.texto).toContain('08:40');
  });

  it('sem hora pedida, nada muda', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-23',
        dia_semana: 'sexta',
        inicio: '08:40',
        fim: '09:00',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"rotina","convenio":"Unimed"}}',
      'tem horario?',
    );
    expect(r?.texto).not.toContain('seguem a agenda');
  });
});

describe('pergunta de robô: escala CALADA (Thiago, 19/10/2026)', () => {
  // "Só um instante." depois de "você é um robô?" é quase uma confissão: é a
  // mesma frase de quando a Lara não entendeu, e aqui ela entendeu muito bem.
  it('não responde nada, e abre o caso', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"pergunta_se_e_bot","confianca":0.95,"slots":{}}',
      'você é um robô?',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).toBe('');
    expect(pendencias()).not.toHaveLength(0);
  });

  // Pedir para falar com uma pessoa é o MESMO caso (Thiago, 19/10/2026):
  // significa que o paciente percebeu que é uma IA. Responder "Só um
  // instante." seria a máquina comentando a própria máquina.
  it('quem pede para falar com alguém também fica sem resposta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"quer_humano","confianca":0.95,"slots":{}}',
      'quero falar com uma pessoa',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).toBe('');
    expect(pendencias()).not.toHaveLength(0);
  });

  // ⚠️ O outro lado, e é o que mantém a regra estreita: quem escala por OUTRO
  // motivo continua falando. Dor, cancelamento, exame fora da lista — calar ali
  // pareceria que a mensagem se perdeu.
  it('escalonamento comum continua respondendo', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"clinico","confianca":0.95,"slots":{}}',
      'to com dor no olho',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).toContain('instante');
  });

  it('sem_resposta NÃO cala quem não escala', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"endereco","confianca":0.95,"slots":{}}',
      'onde fica?',
    );
    expect(r?.texto).toContain('Elias João Tajra');
  });
});

describe('preparo de lente de contato (Marina, 19/10/2026)', () => {
  const refrativa =
    '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos","convenio":"particular"}}';

  // Iniciativa: sem saber da lente, a Lara NÃO oferece horário para refrativa.
  // Sem isso ela ofereceria amanhã a quem precisa de 3 dias sem usar, e a
  // pessoa viajaria para um exame que não prestaria.
  it('pergunta da lente antes de oferecer horário de refrativa', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    const r = await rodar(refrativa, 'tem horario?');
    expect(r?.texto).toContain('lente de contato');
    expect(r?.texto).not.toContain('09:00');
  });

  it('quem usa lente recebe os 3 dias e a agenda ganha antecedência', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-23',
        dia_semana: 'sexta',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    // A necessidade vem antes: a pergunta da lente só existe depois que a
    // conversa já é de refrativa, e a orientação dos 3 dias é exceção DAQUELE
    // contexto. Sem isso o host escala, que é o certo.
    const r1 = await rodar(
      '{"intencao":"usa_lente","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos"}}',
      'uso lente sim',
    );
    expect(r1?.texto).toContain('3 dias');
    await rodar(refrativa, 'e os horarios?');
    expect(buscou.pop()?.antecedencia).toBe(3);
  });

  // ⚠️ Fora da refrativa, os 3 dias NÃO saem: a exceção aprovada é da avaliação
  // refrativa, e preparo de outro contexto é orientação clínica.
  it('uso de lente em consulta de ROTINA escala, não orienta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"usa_lente","confianca":0.95,"slots":{"necessidade":"consulta de rotina"}}',
      'minha consulta é de rotina, uso lente, preciso parar?',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).not.toContain('3 dias');
  });

  // O "sim" fica na memória da conversa; sem recorte ele atrasaria também as
  // buscas de catarata, onde o preparo não existe.
  it('lente não atrasa a agenda de CATARATA', async () => {
    const { esqueceSlots, lembraLente } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    lembraLente(PASTA, JID, 'sim');
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular"}}',
      'tem horario?',
    );
    expect(buscou.pop()?.antecedencia).toBeUndefined();
  });

  it('quem NÃO usa lente não espera nada', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    buscou.length = 0;
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    await rodar(
      '{"intencao":"nao_usa_lente","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos"}}',
      'não uso',
    );
    const r = await rodar(refrativa, 'tem horario?');
    expect(buscou.pop()?.antecedencia).toBeUndefined();
    expect(r?.texto).toContain('09:00');
  });

  // ⚠️ Só na refrativa: catarata e rotina não dependem de lente, e perguntar
  // ali seria um turno a mais sem motivo.
  it('catarata NÃO é perguntada sobre lente', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular"}}',
      'tem horario?',
    );
    expect(r?.texto).not.toContain('lente de contato');
    expect(r?.texto).toContain('09:00');
  });

  // ⚠️ O laço que o Codex reproduziu: triagem COMPLETA, pergunta da lente,
  // paciente responde "não uso" — e recebia a mesma pergunta, para sempre. O
  // gate lia a memória antes de a resposta ser gravada.
  it('responder "não uso" DEPOIS da triagem completa não vira laço', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    const t1 = await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos","nome":"Paulo","nascimento":"12/12/1992","cidade":"Teresina","convenio":"particular"}}',
      'Paulo, 12/12/1992, Teresina, particular',
    );
    expect(t1?.texto).toContain('lente de contato');
    const t2 = await rodar(
      '{"intencao":"nao_usa_lente","confianca":0.95,"slots":{}}',
      'não uso lente',
    );
    expect(t2?.texto).not.toContain('lente de contato');
    expect(t2?.texto).toContain('09:00');
  });

  // Resposta ambígua NÃO libera a agenda: liberar sem prazo manda a pessoa
  // fazer um exame que não vai prestar.
  it('"às vezes" não conta como resposta', async () => {
    const { esqueceSlots, lenteLembrada } =
      await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos","usa_lente":"às vezes"}}',
      'às vezes uso',
    );
    expect(lenteLembrada(PASTA, JID)).toBeUndefined();
  });

  // Mudou de ideia com oferta viva: a oferta pode ser de amanhã, e os 3 dias
  // só valiam para buscas novas.
  it('passar a usar lente descarta oferta cedo demais', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    const { ultimaOferta, registraOferta } = await import('./agendamento.js');
    esqueceSlots(PASTA, JID);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    registraOferta(PASTA, JID, {
      vaga: { data: amanha, inicio: '09:00', fim: '09:30' },
      perfil: 'particular-cirurgia',
      nome: 'Paulo',
    } as never);
    await rodar(
      '{"intencao":"usa_lente","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos"}}',
      'na verdade uso lente sim',
    );
    expect(ultimaOferta(PASTA, JID)).toBeUndefined();
  });

  it('a pergunta sai UMA vez: respondida, não volta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:30',
      },
    ];
    await rodar(refrativa, 'tem horario?');
    await rodar(
      '{"intencao":"nao_usa_lente","confianca":0.95,"slots":{"necessidade":"quero parar de usar óculos"}}',
      'não uso não',
    );
    const r = await rodar(refrativa, 'e entao?');
    expect(r?.texto).not.toContain('lente de contato');
  });
});

describe('hora pedida: os casos que a revisão achou (19/10/2026)', () => {
  // ⚠️ O filtro duro FABRICAVA escalonamento no paciente mais decidido: quem
  // pedia "sexta às 10h" com as 10h ocupadas ouvia "Só um instante", enquanto
  // quem pedia só "sexta" recebia duas opções.
  it('hora indisponível oferece alternativa, não escala', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    let chamada = 0;
    vagasFalsas = [];
    buscouHook = () => {
      chamada += 1;
      // 1ª busca com --hora: nada. 2ª sem --hora: alternativas.
      vagasFalsas =
        chamada === 1
          ? []
          : [
              {
                data: '2026-10-23',
                dia_semana: 'sexta',
                inicio: '09:20',
                fim: '09:50',
              },
            ];
    };
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular","dia_pedido":"sexta","hora_pedida":"10h"}}',
      'consigo sexta às 10h?',
    );
    buscouHook = undefined;
    expect(r?.acao).not.toBe('escalar');
    expect(r?.texto).toContain('09:20');
    expect(r?.texto).toContain('não consigo encaixar');
  });

  // A condição antiga não comparava nada: convênio pedindo 10h e recebendo
  // 10h ouvia "não consigo reservar um horário específico. O que tenho é às
  // 10:00" — negando o que acabava de conceder.
  it('convênio que RECEBE a hora pedida não ouve a explicação', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-23',
        dia_semana: 'sexta',
        inicio: '10:00',
        fim: '10:20',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"rotina","convenio":"Unimed","dia_pedido":"sexta","hora_pedida":"10h"}}',
      'consigo sexta às 10h?',
    );
    expect(r?.texto).toContain('10:00');
    expect(r?.texto).not.toContain('seguem a agenda');
  });

  it('particular que pede hora SEM dia é perguntado o dia', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-21',
        dia_semana: 'quarta',
        inicio: '15:00',
        fim: '15:30',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular","hora_pedida":"10h"}}',
      'pode ser as 10h?',
    );
    expect(r?.texto).toContain('Para qual dia');
    expect(r?.texto).not.toContain('15:00');
  });
});

describe('duas opções de horário (manual, 19/10/2026)', () => {
  const duas = () => {
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:20',
      },
      {
        data: '2026-10-22',
        dia_semana: 'quinta',
        inicio: '14:30',
        fim: '14:50',
      },
    ];
  };

  it('a agenda com duas vagas oferece as duas', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    duas();
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular"}}',
      'tem horario?',
    );
    expect(r?.texto).toContain('09:00');
    expect(r?.texto).toContain('14:30');
  });

  it('com uma vaga só, o texto continua o de uma', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:20',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"catarata","convenio":"particular"}}',
      'tem horario?',
    );
    expect(r?.texto).toContain('09:00');
    expect(r?.texto).not.toContain('Qual fica melhor');
  });

  it('aceite que diz QUAL marca aquele horário', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    duas();
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata","nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular. tem horario?',
    );
    marcou.length = 0;
    const r = await rodar(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{}}',
      'pode ser quinta',
    );
    expect(r?.acao).toBe('marcar');
    expect(marcou[0]?.data).toBe('2026-10-22');
    expect(marcou[0]?.hora).toBe('14:30');
  });

  // ⚠️ O que esta mudança podia estragar: "pode ser" com DUAS na mesa não diz
  // qual, e marcar a primeira por omissão manda a pessoa no dia errado.
  it('aceite AMBÍGUO pergunta, não marca', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    duas();
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata","nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular. tem horario?',
    );
    marcou.length = 0;
    const r = await rodar(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{}}',
      'pode ser',
    );
    expect(marcou).toHaveLength(0);
    expect(r?.texto).toContain('não errar');
    expect(r?.acao).toBe('responder');
  });

  it('com UMA vaga, "pode ser" continua marcando', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    vagasFalsas = [
      {
        data: '2026-10-20',
        dia_semana: 'terça',
        inicio: '09:00',
        fim: '09:20',
      },
    ];
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata","nome":"Thiago","nascimento":"01/06/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 01/06/1980, Teresina, particular. tem horario?',
    );
    marcou.length = 0;
    const r = await rodar(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{}}',
      'pode ser',
    );
    expect(r?.acao).toBe('marcar');
    expect(marcou[0]?.data).toBe('2026-10-20');
  });
});

describe('o convite de agendamento é emenda do host (tom de 17/10/2026)', () => {
  it('emenda o pedido dos dados em quem tem `emenda_triagem`', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"convenio_iaspi","confianca":0.95,"slots":{"convenio":"IASPI"}}',
      'atende IASPI?',
    );
    expect(r?.texto).toContain('PLAMTA');
    expect(r?.texto.toLowerCase()).toContain('poderia me informar');
    // O convite é declarativo, nunca pedido de permissão: é a frase que a
    // guarda proíbe e que o próprio documento de tom manda evitar.
    expect(r?.texto).not.toMatch(/posso (verificar|conferir|checar)/i);
  });

  it('convida UMA vez por conversa, não a cada resposta', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const primeiro = await rodar(
      '{"intencao":"convenio_iaspi","confianca":0.95,"slots":{"convenio":"IASPI"}}',
      'atende IASPI?',
    );
    expect(primeiro?.texto.toLowerCase()).toContain('poderia me informar');
    const segundo = await rodar(
      '{"intencao":"convenio_ipmt","confianca":0.95,"slots":{"convenio":"IPMT"}}',
      'e IPMT?',
    );
    expect(segundo?.texto).toContain('PLANTE');
    expect(segundo?.texto.toLowerCase()).not.toContain('poderia me informar');
  });

  it('quem NÃO tem a marca responde e para', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"pentacam_cobertura","confianca":0.95,"slots":{}}',
      'o Pentacam é coberto?',
    );
    expect(r?.texto).toContain('Pentacam');
    expect(r?.texto.toLowerCase()).not.toContain('poderia me informar');
  });
});

describe('preço de cirurgia: refrativa fala de óculos, catarata não', () => {
  it('necessidade refrativa recebe o enquadramento dos óculos', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{"necessidade":"cirurgia refrativa, quero parar de usar óculos"}}',
      'quanto custa a cirurgia?',
    );
    expect(r?.texto).toContain('óculos');
    expect(r?.texto).toContain('430');
  });

  // O que esta troca existe para impedir. Catarata é cirurgia, e o texto
  // refrativo diria a ele que a cirurgia serve para "diminuir a dependência dos
  // óculos" — que não é o caso dele.
  it('catarata NÃO recebe o texto refrativo', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{"necessidade":"cirurgia de catarata"}}',
      'quanto custa a cirurgia?',
    );
    expect(r?.texto).not.toContain('óculos');
    expect(r?.texto).toContain('430');
  });

  it('sem necessidade nenhuma também fica no neutro', async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    const r = await rodar(
      '{"intencao":"preco_cirurgia","confianca":0.95,"slots":{}}',
      'quanto custa a cirurgia?',
    );
    expect(r?.texto).not.toContain('óculos');
  });
});

describe('o nome do cadastro sobrevive até a marcação (E08, 16/10/2026)', () => {
  it('confirmou dois turnos antes: a oferta leva o nome do cadastro', async () => {
    candidatosFalsos = [
      {
        id: 47555744,
        nome: 'THIAGO CARVALHO DE SOUSA',
        nascimento: '1980-06-01',
      },
    ];
    vagasFalsas = [
      {
        data: '2026-10-19',
        dia_semana: 'segunda',
        inicio: '08:00',
        fim: '08:30',
      },
    ];
    // menu -> pergunta de quem é
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      '2',
    );
    // "sou eu" -> nome e nascimento vêm do cadastro
    await rodarDe(
      '{"intencao":"paciente_confirmado","confianca":0.95,"slots":{}}',
      'sou eu',
    );
    // pede horário SEM repetir nome nem nascimento, como o modelo faz
    await rodarDe(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"cidade":"Teresina","convenio":"particular"}}',
      'Teresina, particular. tem horario?',
    );
    // aceite: a marcação precisa do nome, e ele veio da memória
    await rodarDe(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{}}',
      'pode ser esse horario',
    );
    expect(marcou.length).toBe(1);
    // eslint-disable-next-line no-console
    console.log(
      'DEBUG memoria:',
      fs.readFileSync(path.join(RAIZ, PASTA, 'slots_conversa.json'), 'utf-8'),
    );
    expect(marcou[0].paciente).toContain('THIAGO');
  });
});

describe('a agenda também lembra o que a conversa disse (E08, 16/10/2026)', () => {
  it('necessidade dita antes, horário pedido depois: consulta a agenda', async () => {
    vagasFalsas = [
      {
        data: '2026-10-19',
        dia_semana: 'segunda',
        inicio: '09:20',
        fim: '09:50',
      },
    ];
    // turno 1: só a necessidade, como o menu entrega
    await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      '2',
    );
    // turno 2: os quatro dados, SEM repetir a necessidade — foi assim em produção
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"nome":"Thiago","nascimento":"10/03/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago, 10/03/1980, Teresina, particular',
    );
    // catarata é cirúrgico, então o perfil cruzado é particular-cirurgia — e o
    // fato de ele sair daqui prova que a necessidade veio do turno ANTERIOR.
    expect(buscou).toEqual([{ perfil: 'particular-cirurgia', dia: undefined }]);
    expect(r?.acao).toBe('responder');
    expect(r?.texto).toContain('09:20');
  });

  it('nada dito em turno nenhum: segue escalando, não chuta perfil', async () => {
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"nome":"Thiago"}}',
    );
    expect(buscou).toEqual([]);
    expect(r?.acao).toBe('escalar');
  });
});

describe('retorno e exame a Lara não agenda (regra de 06/10/2026)', () => {
  it('retorno escala SEM consultar a agenda', async () => {
    vagasFalsas = [
      {
        data: '2026-10-06',
        dia_semana: 'segunda',
        inicio: '09:20',
        fim: '09:50',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"retorno","convenio":"particular"}}',
      'queria marcar meu retorno',
    );
    // Não basta escalar: consultar gastaria 18s para achar vaga inofertável.
    expect(buscou).toEqual([]);
    expect(r?.acao).toBe('escalar');
  });

  it('exame escala SEM consultar a agenda', async () => {
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"exame de topografia","convenio":"particular"}}',
    );
    expect(buscou).toEqual([]);
    expect(r?.acao).toBe('escalar');
  });

  it('retorno de cirurgia também, que é o perfil retorno-cirurgia', async () => {
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.95,"slots":{"necessidade":"retorno da cirurgia refrativa","convenio":"particular"}}',
    );
    expect(buscou).toEqual([]);
    expect(r?.acao).toBe('escalar');
  });

  it('a regra NÃO atinge o preço de exames, que é resposta aprovada', async () => {
    const r = await rodar(
      '{"intencao":"exames_preco","confianca":0.95,"slots":{"necessidade":"exame"}}',
    );
    expect(buscou).toEqual([]);
    expect(r?.acao).toBe('responder');
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

describe('triagem pergunta UMA coisa a quem a clínica já conhece', () => {
  const limpa = async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    candidatosFalsos = [];
    buscasPorTelefone = [];
  };

  it('achou cadastro: nomeia o mais velho e oferece "outra pessoa"', async () => {
    await limpa();
    // Ordem vem do script, que já ordena por mais velho primeiro.
    candidatosFalsos = [
      {
        id: 47555744,
        nome: 'THIAGO CARVALHO DE SOUSA',
        nascimento: '1980-06-01',
      },
      {
        id: 47904529,
        nome: 'MANUELA COSTA CARVALHO',
        nascimento: '2015-06-29',
      },
    ];
    const r = await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
      '2',
    );
    expect(r?.texto).toBe('É para você, Thiago, ou para outra pessoa?');
    // o nome da outra pessoa da casa NÃO é revelado sem ela ser mencionada
    expect(r?.texto).not.toContain('Manuela');
  });

  it('pergunta uma vez só: no turno seguinte volta a triagem normal', async () => {
    await limpa();
    candidatosFalsos = [
      { id: 1, nome: 'THIAGO CARVALHO', nascimento: '1980-06-01' },
    ];
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
    );
    const r2 = await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
    );
    expect(r2?.texto).not.toContain('É para você');
    // e não buscou de novo: login custa ~10 s
    expect(buscasPorTelefone.length).toBe(1);
  });

  it('sem cadastro com esse telefone, triagem normal', async () => {
    await limpa();
    const r = await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
    );
    expect(r?.texto).not.toContain('É para você');
    expect(r?.texto).toContain('poderia me informar');
  });

  it('nome já conhecido: não pergunta de quem é', async () => {
    await limpa();
    candidatosFalsos = [
      { id: 1, nome: 'THIAGO CARVALHO', nascimento: '1980-06-01' },
    ];
    const r = await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Joana Silva","necessidade":"catarata"}}',
    );
    expect(r?.texto).not.toContain('É para você');
    expect(buscasPorTelefone.length).toBe(0);
  });
});

describe('resposta de quem é a consulta (peça 2)', () => {
  const prepara = async () => {
    const { esqueceSlots } = await import('./memoria-conversa.js');
    esqueceSlots(PASTA, JID);
    candidatosFalsos = [
      {
        id: 47555744,
        nome: 'THIAGO CARVALHO DE SOUSA',
        nascimento: '1980-06-01',
      },
    ];
    buscasPorTelefone = [];
    await rodarDe(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"necessidade":"catarata"}}',
    );
  };

  it('"sou eu": usa o cadastro e pede só o que ainda falta', async () => {
    await prepara();
    const r = await rodarDe(
      '{"intencao":"paciente_confirmado","confianca":0.95,"slots":{}}',
      'sou eu',
    );
    // nome e nascimento vieram do cadastro, então não são perguntados
    expect(r?.texto).not.toContain('Nome completo');
    expect(r?.texto).not.toContain('nascimento');
    expect(r?.texto).toContain('cidade');
    expect(r?.texto).toContain('convênio');
  });

  it('"é para outra pessoa": esquece o cadastro e pede tudo', async () => {
    await prepara();
    const r = await rodarDe(
      '{"intencao":"paciente_outro","confianca":0.95,"slots":{}}',
      'é pra minha filha',
    );
    expect(r?.texto).toContain('Nome completo');
  });

  it('confirmado vai com --paciente-id na marcação', async () => {
    await prepara();
    await rodarDe(
      '{"intencao":"paciente_confirmado","confianca":0.95,"slots":{}}',
    );
    const { pacienteConfirmado } = await import('./memoria-conversa.js');
    expect(pacienteConfirmado(PASTA, JID)).toBe(47555744);
  });
});

describe('triagem não repete o que já foi dado (E08 da passada 6)', () => {
  it('quatro dados completos e sem necessidade: manda o MENU, não o formulário', async () => {
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Thiago Carvalho de Sousa","nascimento":"10/03/1980","cidade":"Teresina","convenio":"particular"}}',
      'Thiago Carvalho de Sousa, 10/03/1980, Teresina, particular',
    );
    expect(r?.texto).toContain('cirurgia, ou uma consulta de rotina');
    // o pecado capital: devolver os quatro rótulos que a pessoa acabou de dar
    expect(r?.texto).not.toContain('Nome completo do paciente');
  });

  it('nada a perguntar e ainda assim triagem: escala em vez de repetir', async () => {
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Thiago","nascimento":"10/03/1980","cidade":"Teresina","convenio":"particular","necessidade":"catarata"}}',
    );
    expect(r?.acao).toBe('escalar');
  });

  it('faltando alguns, segue pedindo só o que falta', async () => {
    const r = await rodar(
      '{"intencao":"triagem_dados","confianca":0.95,"slots":{"nome":"Joana","cidade":"Teresina"}}',
    );
    expect(r?.texto).toContain('poderia me informar');
    expect(r?.texto).not.toContain('cirurgia, ou uma consulta de rotina');
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

// O furo que a produção achou e a medição não: o avaliador SEMPRE injetava a
// lista no prompt, então os 92,1% foram medidos com ela. Produção mandava o
// agente ler o arquivo, ele não leu, e inventou `endereco_clinica`.
describe('listaDeIntencoes: a lista vai no prompt, não num arquivo a abrir', () => {
  it('traz todos os nomes da tabela, com o critério', async () => {
    const { listaDeIntencoes } = await import('./executor.js');
    const lista = listaDeIntencoes(PASTA) as string;
    expect(lista).toContain('**endereco**');
    expect(lista).toContain('**clinico**');
    expect(lista).toContain('**horario_oferta**');
    expect(lista).toContain('**DESCONHECIDO**');
  });

  it('avisa que nome fora da lista escala, que é o que de fato acontece', async () => {
    const { listaDeIntencoes } = await import('./executor.js');
    expect(listaDeIntencoes(PASTA)).toMatch(/n[ãa]o invente/i);
  });

  it('sem tabela devolve undefined, e o host não emenda nada', async () => {
    fs.rmSync(path.join(RAIZ, PASTA, 'templates.json'));
    esqueceTabela();
    const { listaDeIntencoes } = await import('./executor.js');
    expect(listaDeIntencoes(PASTA)).toBeUndefined();
  });
});

// O caminho que a revisão de 05/10/2026 descobriu INALCANÇÁVEL: `renderiza`
// rebaixava `aceita_horario` para DESCONHECIDO antes de a ação `marcar` poder
// existir, porque o texto tem {paciente} {dia} {data} {hora} e nada preenchia.
// Nenhum teste cobria, e por isso o recurso inteiro passou morto.
describe('aceite do horário chega à marcação', () => {
  const OFERTA = {
    vaga: {
      data: '2026-10-06',
      dia_semana: 'segunda',
      inicio: '09:20',
      fim: '09:50',
    },
    perfil: 'particular',
    quando: Date.now(),
    nome: 'Joana Silva',
    nascimento: '10/03/1980',
    convenio: 'particular',
  };

  // No turno do aceite o paciente escreve "pode ser": os slots vêm VAZIOS, e o
  // nome foi dado dois turnos antes. Foi assim que a primeira marcação real
  // falhou, com `dado_faltando: paciente`.
  it('marca com os dados da OFERTA, mesmo sem slots no turno do aceite', async () => {
    ofertaFalsa = OFERTA;
    const r = await rodar(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{}}',
      'pode ser esse horario',
    );
    expect(r?.acao).toBe('marcar');
    expect(r?.texto).toBe(
      'Pronto, Joana, está agendado para segunda, dia 06/10, às 09:20.',
    );
    expect(r?.texto).not.toMatch(/\{\w+\}/);
    expect(marcou).toHaveLength(1);
    expect(marcou[0]).toMatchObject({
      data: '2026-10-06',
      hora: '09:20',
      paciente: 'Joana Silva',
      nascimento: '10/03/1980',
    });
  });

  it('sem oferta registrada, escala em vez de marcar o próximo livre', async () => {
    ofertaFalsa = undefined;
    const r = await rodar(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{"nome":"Joana"}}',
    );
    expect(r?.acao).toBe('escalar');
    expect(marcou).toHaveLength(0);
  });

  it('marcação recusada escala com o motivo, e não diz que agendou', async () => {
    ofertaFalsa = OFERTA;
    marcaFalha = '09:20 não está mais disponível';
    const r = await rodar(
      '{"intencao":"aceita_horario","confianca":0.95,"slots":{"nome":"Joana"}}',
    );
    expect(r?.acao).toBe('escalar');
    expect(r?.texto).toBe('Só um instante.');
    expect(r?.texto).not.toMatch(/agendad/i);
  });

  it('a oferta só é registrada quando o texto do horário sai', async () => {
    // Confiança baixa: o render rebaixa, e nada pode ter sido registrado —
    // senão um "pode ser" marcaria um horário que o paciente nunca viu.
    vagasFalsas = [
      {
        data: '2026-10-06',
        dia_semana: 'segunda',
        inicio: '09:20',
        fim: '09:50',
      },
    ];
    const r = await rodar(
      '{"intencao":"horario_oferta","confianca":0.4,"slots":{"necessidade":"rotina","convenio":"Unimed"}}',
    );
    expect(r?.acao).toBe('escalar');
    expect(ofertaFalsa).toBeUndefined();
  });
});
