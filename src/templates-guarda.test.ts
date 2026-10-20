import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { excluiConsulta, inspecionaSaida } from './output-guard.js';

/**
 * Todo texto aprovado da tabela, passado pela guarda.
 *
 * Existe porque a revisão de tom de 17/10/2026 chegou com 8 de 12 textos
 * terminando em "Posso verificar os horários disponíveis para você?" — frase que
 * a guarda marca como pedir permissão para fazer o próprio trabalho. Eu só
 * descobri porque fui ler as regras uma por uma; nada no projeto perguntava
 * isso. Texto aprovado por humano é dado de entrada como outro qualquer, e a
 * guarda existe justamente porque humano aprova texto com deslize dentro.
 *
 * É o teste estrutural contra dado aprovado, não revisão à mão: ele roda em
 * milissegundos, sem VM e sem app, e falha no `npm test` de quem editar a
 * tabela.
 */
const TABELA = JSON.parse(
  fs.readFileSync(
    path.join(
      process.cwd(),
      'groups/whatsapp_atendimento-teste/templates.json',
    ),
    'utf-8',
  ),
) as {
  intencoes: Record<
    string,
    {
      acao: string;
      textos?: string[];
      textos_sem_slot?: string[];
      quando?: string;
      so_do_host?: boolean;
    }
  >;
};

/**
 * Valores de slot plausíveis. Não são os de produção: só precisam ter a FORMA
 * certa, porque é da forma que a guarda trata — dinheiro perto de "cirurgia",
 * telefone, CPF, caixa alta.
 */
const SLOTS: Record<string, string> = {
  valor_consulta: '430,00',
  valor_desconto: '300,00',
  valor_retorno: '0,00',
  dia: 'segunda',
  data: '20/10',
  hora: '09:00',
  dia_pedido: 'sábado',
  paciente: 'Marcos',
  nome: 'Marcos',
  codigo: 'A3F',
  convenio: 'Unimed',
  hospital: 'Hospital Vilar',
  necessidade: 'cirurgia de catarata',
};

function preenche(texto: string): string {
  return texto.replace(/\{(\w+)\}/g, (inteiro, chave: string) =>
    chave in SLOTS ? SLOTS[chave] : inteiro,
  );
}

describe('a tabela de templates passa pela guarda', () => {
  const casos: Array<[string, string, string]> = [];
  for (const [nome, def] of Object.entries(TABELA.intencoes)) {
    if (nome.startsWith('_')) continue;
    for (const t of def.textos ?? []) casos.push([nome, 'textos', t]);
    for (const t of def.textos_sem_slot ?? []) {
      casos.push([nome, 'textos_sem_slot', t]);
    }
  }

  it('nenhum texto aprovado traz o separador de mensagem', () => {
    // Ele é posto pelo HOST ao emendar, nunca escrito na tabela. Se aparecer
    // num texto, vira quebra onde ninguém decidiu quebrar.
    const comSeparador = casos.filter(([, , t]) => t.includes('\u001e'));
    expect(comSeparador.map(([nome]) => nome)).toEqual([]);
  });

  // `fecho` e `emenda_triagem` se contradizem: o primeiro encerra ("Ajudo em
  // algo mais?") e o segundo abre ("Para eu já ver um horário, poderia me
  // informar..."). O FECHO é colado dentro do `renderiza`, ANTES de o executor
  // emendar, então as duas marcas juntas produziriam "Ajudo em algo mais?"
  // seguido de um pedido de dados.
  it('nenhuma intenção fecha e convida ao mesmo tempo', () => {
    const ambos = Object.entries(TABELA.intencoes)
      .filter(
        ([, d]) =>
          (d as Record<string, unknown>).fecho === true &&
          (d as Record<string, unknown>).emenda_triagem === true,
      )
      .map(([nome]) => nome);
    expect(ambos).toEqual([]);
  });

  it('tem texto para inspecionar', () => {
    expect(casos.length).toBeGreaterThan(40);
  });

  it.each(casos)('%s · %s', (nome, _campo, texto) => {
    const v = inspecionaSaida(preenche(texto), {
      // A confirmação de agendamento DIZ que está marcado, e deve: o que a
      // guarda proíbe é dizer isso sem ter marcado. Aqui o fato é dado.
      agendouDeVerdade: TABELA.intencoes[nome].acao === 'marcar',
      intencao: nome,
    });
    const graves = v.achados.filter((a) => a.nivel !== 'sanitize');
    expect(
      graves.map((a) => `${a.regra} (${a.nivel}): ${a.motivo}`),
      texto.slice(0, 120),
    ).toEqual([]);
  });

  // A tabela ficar verde não prova que a guarda olhou. Estes são os dois textos
  // que ela PRECISA pegar: a frase literal que veio na revisão de tom do Thiago,
  // e a frase da abertura usada fora da abertura. Sem eles, afrouxar a guarda
  // deixaria este arquivo passando igual.
  it('pega o convite em forma de permissão', () => {
    const v = inspecionaSaida(
      'As consultas para esse convênio são particulares, no valor de R$ 430,00.' +
        '\n\nPosso verificar os horários disponíveis para você?',
      { intencao: 'convenio_nao_atendido' },
    );
    expect(v.achados.map((a) => a.regra)).toContain('frase_proibida');
  });

  // Terceira vez no mesmo dia que artigo antes de um slot dá errado: "da/do
  // Zulmira" (gênero do paciente), "pela Unimed" (gênero do plano) e "em
  // segunda" (dia da semana). A regra que saiu das três é a mesma: o host não
  // sabe o gênero do que vai no slot, então nada de artigo nem preposição
  // flexionada colada nele.
  //
  // {dia} é o pior porque parece seguro: segunda a sexta são femininas ("na
  // segunda") e sábado é masculino ("no sábado"). Hoje a clínica não atende
  // sábado, então "na" acertaria sempre — e é exatamente esse tipo de "não
  // pode acontecer" que me pegou duas vezes hoje.
  //
  // "para" NÃO entra na lista: não flexiona gênero e é idiomático antes de dia
  // da semana. A primeira versão desta regra o incluiu e acusou o
  // `aceita_horario` ("agendado para {dia}"), que está certo. Regra que acusa o
  // certo é desligada pela equipe em uma semana.
  it('nenhum texto põe artigo ou preposição colada em {dia}', () => {
    const ruins: string[] = [];
    for (const [nome, def] of Object.entries(TABELA.intencoes)) {
      for (const t of [...(def.textos ?? []), ...(def.textos_sem_slot ?? [])]) {
        if (/\b(em|n[ao]|d[ao]|pel[ao])\s+\{dia\}/i.test(t)) {
          ruins.push(`${nome}: ${t.slice(0, 80)}`);
        }
      }
    }
    expect(ruins).toEqual([]);
  });

  it('o detector de artigo colado em {dia} funciona', () => {
    // Sem isto, a asserção acima passaria mesmo quebrada.
    const quebrado = 'mas temos disponibilidade em {dia}, dia {data}';
    expect(/\b(em|n[ao]|d[ao]|pel[ao])\s+\{dia\}/i.test(quebrado)).toBe(true);
    const certo = 'mas tenho {dia}, dia {data}';
    // "para" é invariável e idiomático: tem de passar.
    expect(
      /\b(em|n[ao]|d[ao]|pel[ao])\s+\{dia\}/i.test('agendado para {dia}'),
    ).toBe(false);
    expect(/\b(em|n[ao]|d[ao]|pel[ao])\s+\{dia\}/i.test(certo)).toBe(false);
  });

  // O convite leve é a ÚNICA frase de permissão aprovada (Thiago, 19/10/2026),
  // e a exceção é da FRASE, não da intenção: isentando a intenção inteira,
  // qualquer variação passaria lá dentro.
  it('a frase aprovada passa', () => {
    const r = inspecionaSaida(TABELA.intencoes.convite_horario.textos![0], {
      intencao: 'convite_horario',
    });
    expect(r.achados.map((a) => a.regra)).not.toContain('frase_proibida');
  });

  it('variações continuam proibidas até dentro do convite', () => {
    for (const t of [
      'Quer que eu veja um horário disponível?',
      'Posso verificar a agenda para você?',
      'Quer que eu confira os horários?',
    ]) {
      expect(
        inspecionaSaida(t, { intencao: 'convite_horario' }).achados.map(
          (a) => a.regra,
        ),
        t,
      ).toContain('frase_proibida');
    }
  });

  it('pega a lista de hospitais, e deixa passar um só', () => {
    // O texto que o `hospital_cirurgia` tinha até 17/10/2026.
    const lista = inspecionaSaida(
      'As cirurgias são realizadas em hospital, podendo ser no Hospital Vilar, ' +
        'no Hospital do Olho, no Namir Clementino, no Tércio Rezende ou no COE.',
      { intencao: 'hospital_cirurgia' },
    );
    expect(lista.achados.map((a) => a.regra)).toContain('lista_hospitais');

    // Um hospital só continua certo: o paciente perguntou o endereço DELE.
    const um = inspecionaSaida(
      'O COE fica na R. Coelho Rodrigues, 2041, Centro (Norte), Teresina.',
      { intencao: 'endereco_hospital_coe' },
    );
    expect(um.achados.map((a) => a.regra)).not.toContain('lista_hospitais');

    // E a consulta no Vilar, que é informação da médica, não da cirurgia.
    const vilar = inspecionaSaida(
      'Fora do consultório, a Dra. Marina atende no Hospital Vilar.',
      { intencao: 'consulta_em_hospital' },
    );
    expect(vilar.achados.map((a) => a.regra)).not.toContain('lista_hospitais');
  });

  it('pega a frase da abertura fora da abertura', () => {
    const v = inspecionaSaida('Claro, em que posso te ajudar?', {
      intencao: 'convenio_consulta',
    });
    expect(v.achados.map((a) => a.regra)).toContain('frase_proibida');
    // E não pega na abertura, que é onde ela é a resposta certa.
    const na = inspecionaSaida('Em que posso ajudar?', {
      intencao: 'abertura',
    });
    expect(na.achados.map((a) => a.regra)).not.toContain('frase_proibida');
  });
});

/**
 * A condição que não pode ser dita: nos planos IASPI/IAPEP/IPMT o exame não é
 * avulso — precisa de consulta antes, e essa consulta é particular. Dizer isso
 * por escrito ao paciente fere a regra do convênio, e o Thiago foi explícito
 * em 19/10/2026: "isso nao pode fica explicito".
 *
 * Em 19/10 eu tentei garantir isso ESCALANDO a pergunta, o que custava ao
 * paciente a informação que ele pode ter (o exame sai pelo plano, a consulta
 * não). O arranjo certo é dizer o que é permitido e travar só a marcação, que
 * já escala por `PERFIS_SO_HUMANO`. Então a trava passa a ser esta: os textos
 * desses planos falam de exame, e NÃO falam da condição.
 *
 * Fica aqui, e não no executor.test.ts, porque ali o texto é fixture minha —
 * eu provaria que a minha própria frase não diz o que eu não escrevi.
 */
describe('planos parciais: diz o que pode, cala a condição', () => {
  const RX_CONDICAO =
    /avuls|precisa (?:de |passar por )?(?:uma )?consulta|consulta antes|antes (?:de|da) (?:fazer|marcar|o exame)|mediante consulta/i;

  for (const nome of ['convenio_iaspi', 'convenio_ipmt']) {
    it(`${nome} informa o exame`, () => {
      const t = (TABELA.intencoes[nome]?.textos ?? []).join('\n');
      expect(t, nome).toMatch(/exame/i);
      // A MESMA noção da guarda (regra `plano_parcial`), não uma cópia: é ela
      // que decide se a mensagem diz que a consulta está fora.
      expect(excluiConsulta(t), nome).toBe(true);
    });

    it(`${nome} não diz a condição do exame avulso`, () => {
      for (const t of TABELA.intencoes[nome]?.textos ?? []) {
        expect(t, nome).not.toMatch(RX_CONDICAO);
      }
    });
  }

  // ⚠️ Controle negativo: a regra tem de pegar a frase proibida de verdade.
  // Sem isto, afrouxar o regex até os textos passarem seria invisível.
  it.each([
    'Pelo IASPI o exame não pode ser avulso.',
    'Pelo IPMT o exame precisa de consulta antes.',
    'Os exames do IASPI saem mediante consulta particular.',
  ])('a regra pega: %s', (frase) => {
    expect(frase).toMatch(RX_CONDICAO);
  });
});

/**
 * A flag `so_do_host` e a prosa do `quando` têm de concordar.
 *
 * ⚠️ A frase exata é "NUNCA rotular ISTO". Minha primeira versão casava só
 * "NUNCA rotular", e isso pegava o `nao_usa_lente` — cujo `quando` diz "Nunca
 * rotular em outro contexto", que é restrição de CONTEXTO e não intenção só do
 * host. O teste reprovou na hora, e ele estava certo.
 *
 * O comportamento é dirigido pela FLAG, porque prosa dirigindo código é o
 * defeito que mais custou aqui. Mas a prosa é o que o MODELO lê, então as duas
 * precisam dizer a mesma coisa — e é este teste que garante.
 *
 * Sem ele, marcar a flag e esquecer o `quando` faria o modelo continuar
 * rotulando a intenção (e o host vetando, em silêncio, toda vez); e escrever
 * "NUNCA rotular" sem a flag deixaria o furo do E08 aberto de novo.
 */
describe('so_do_host concorda com o `quando`', () => {
  const TODAS = Object.entries(TABELA.intencoes) as Array<
    [string, { quando?: string; so_do_host?: boolean }]
  >;

  it('toda intenção com a flag diz "NUNCA rotular" no quando', () => {
    for (const [nome, def] of TODAS) {
      if (def.so_do_host !== true) continue;
      expect(def.quando ?? '', nome).toMatch(/NUNCA rotular isto/i);
    }
  });

  it('toda intenção que diz "NUNCA rotular" tem a flag', () => {
    for (const [nome, def] of TODAS) {
      if (!/NUNCA rotular isto/i.test(def.quando ?? '')) continue;
      expect(def.so_do_host, nome).toBe(true);
    }
  });

  // ⚠️ E existe pelo menos uma: um teste que passa com zero intenções marcadas
  // não prova nada, e foi assim que o furo do E08 sobreviveu a duas tentativas.
  it('há intenções só do host na tabela', () => {
    const quantas = TODAS.filter(([, d]) => d.so_do_host === true).length;
    expect(quantas).toBeGreaterThanOrEqual(9);
  });
});

/**
 * IASPI e IPMT são o MESMO texto com as siglas trocadas.
 *
 * Os dois planos têm a mesma regra — consulta não atendida, exames pelo plano
 * menos o Pentacam, cirurgia pelo plano cirúrgico — e os textos sempre foram
 * idênticos a menos de IASPI↔IPMT e PLAMTA↔PLANTE.
 *
 * ⚠️ E eles DIVERGIRAM em 20/10/2026: a Marina aprovou uma redação nova e o
 * Thiago mandou três textos, o do IASPI entre eles e o do IPMT não. Eu apliquei
 * só o aprovado — certo — e por algumas horas o paciente do IPMT ouviu a
 * redação velha enquanto o do IASPI ouvia a nova. Ninguém teria notado: são
 * duas intenções diferentes, disparadas por siglas diferentes, e nenhum cenário
 * compara uma com a outra.
 *
 * Este teste não impede mudar os dois: impede mudar UM e esquecer o outro. Se
 * algum dia eles tiverem de divergir de verdade, é só apagar este teste — de
 * propósito, com alguém decidindo, que é o que faltou aqui.
 */
describe('convenio_iaspi e convenio_ipmt', () => {
  it('são o mesmo texto com as siglas trocadas', () => {
    const iaspi = TABELA.intencoes.convenio_iaspi?.textos?.[0];
    const ipmt = TABELA.intencoes.convenio_ipmt?.textos?.[0];
    expect(iaspi).toBeTruthy();
    expect(ipmt).toBeTruthy();
    const derivado = (iaspi as string)
      .replaceAll('IASPI', 'IPMT')
      .replace('PLAMTA', 'PLANTE');
    expect(ipmt).toBe(derivado);
  });

  it('cada um nomeia só o seu par de siglas', () => {
    // Controle negativo do teste acima: ele passaria se os DOIS textos fossem
    // iguais e errados (ambos citando IASPI, por exemplo).
    const iaspi = TABELA.intencoes.convenio_iaspi?.textos?.[0] as string;
    const ipmt = TABELA.intencoes.convenio_ipmt?.textos?.[0] as string;
    expect(iaspi).toContain('IASPI');
    expect(iaspi).toContain('PLAMTA');
    expect(iaspi).not.toContain('IPMT');
    expect(iaspi).not.toContain('PLANTE');
    expect(ipmt).toContain('IPMT');
    expect(ipmt).toContain('PLANTE');
    expect(ipmt).not.toContain('IASPI');
    expect(ipmt).not.toContain('PLAMTA');
  });
});

/**
 * As cinco intenções de endereço compartilham o mesmo rabo de especificação.
 *
 * ⚠️ O commit 9faa4160 argumenta por que as cinco têm de andar juntas —
 * "ajustar apenas os dois que são clínicas criaria a assimetria inversa: 'a
 * clínica Vilar' deixaria de achar o Hospital Vilar" — e então colou a frase
 * idêntica em cinco lugares sem nada guardando o conjunto. Invariante em prosa
 * é o modo de falha mais caro deste projeto: edite um dos cinco no mês que vem
 * e nada reprova.
 *
 * É o mesmo erro do par IASPI/IPMT acima, cometido no mesmo dia, duas horas
 * depois. Aqui o `quando` é especificação do classificador, não texto ao
 * paciente, então não há checkpoint de aprovação humana a respeitar: dava para
 * compor de uma constante. O teste é a opção conservadora, e deixa o arquivo
 * legível para quem revisa a tabela sem ler o código.
 */
describe('as cinco intenções de endereço', () => {
  const IDS = [
    'endereco_hospital_vilar',
    'endereco_hospital_olho',
    'endereco_hospital_namir',
    'endereco_hospital_tercio',
    'endereco_hospital_coe',
  ];

  it('dizem, todas, que o nome decide e não a palavra antes dele', () => {
    const rabos = IDS.map((id) => {
      const q = TABELA.intencoes[id]?.quando ?? '';
      return q.slice(q.indexOf('nomeando o lugar'));
    });
    expect(rabos[0]).toContain('hospital');
    expect(rabos[0]).toContain('clínica');
    // Todos idênticos a partir do ponto comum.
    for (const r of rabos) expect(r).toBe(rabos[0]);
  });

  it('cada uma nomeia só o SEU lugar', () => {
    // Controle negativo: o teste acima passaria se as cinco fossem iguais
    // inteiras, inclusive na parte que identifica o lugar.
    const nomes: Record<string, string> = {
      endereco_hospital_vilar: 'Vilar',
      endereco_hospital_olho: 'Hospital do Olho',
      endereco_hospital_namir: 'Namir Clementino',
      endereco_hospital_tercio: 'Tércio Rezende',
      endereco_hospital_coe: 'COE',
    };
    for (const [id, nome] of Object.entries(nomes)) {
      expect(TABELA.intencoes[id]?.quando).toContain(nome);
    }
  });
});

/**
 * `agradece_fecha` e `dispensa_convite` não podem trocar de lugar.
 *
 * ⛔ Em 20/10/2026 eu "consertei" o Y05 ampliando o `quando` do
 * `agradece_fecha` para cobrir a RECUSA do convite — e apontei uma situação
 * nova para texto aprovado para outra situação. O paciente que recusava levava
 * "Eu que agradeço!" sem ter agradecido. O texto estava aprovado; o ROTEAMENTO
 * não, e é o roteamento que nenhuma aprovação humana vigia.
 *
 * O invariante é semântico: quem agradece recebe texto de gratidão; quem
 * recusa, não.
 */
describe('agradece_fecha vs dispensa_convite', () => {
  const GRATIDAO = /agrade[çc]|imagina/i;

  it('os textos de agradecimento PRESSUPÕEM gratidão', () => {
    const textos = TABELA.intencoes.agradece_fecha?.textos ?? [];
    expect(textos.length).toBeGreaterThan(0);
    for (const t of textos) expect(t).toMatch(GRATIDAO);
  });

  it('os textos de recusa NÃO agradecem', () => {
    // Este é o teste do defeito: se alguém colar um "Eu que agradeço" aqui, ou
    // reapontar a recusa para a outra intenção, reprova.
    const textos = TABELA.intencoes.dispensa_convite?.textos ?? [];
    expect(textos.length).toBeGreaterThan(0);
    for (const t of textos) expect(t).not.toMatch(GRATIDAO);
  });

  it('o `quando` de cada um aponta para o outro', () => {
    // Prosa é o modo de falha mais caro deste projeto, mas aqui ela é a
    // especificação do classificador — e as duas situações são vizinhas o
    // suficiente para o modelo confundir sem o aviso explícito.
    expect(TABELA.intencoes.agradece_fecha?.quando).toContain(
      'dispensa_convite',
    );
    expect(TABELA.intencoes.dispensa_convite?.quando).toContain(
      'agradece_fecha',
    );
  });
});
