import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { achaPrecoDeCirurgia, inspecionaSaida } from './output-guard.js';

// Guarda que bloqueia o certo é desligada pela equipe em uma semana, e aí não
// guarda nada. Por isso metade destes testes é de FALSO POSITIVO: textos reais
// da clínica que precisam passar intactos.

// Texto verbatim do F05, 4 ocorrências no corpus, o mais importante de
// conversão. Tem "cirurgia" e dois valores em dinheiro na mesma frase.
const F05 =
  'No momento não atendemos o seu convênio.\n\n' +
  'Oferecemos um desconto especial para pacientes com planos de saúde que não ' +
  'atendemos e desejam realizar a cirurgia. A avaliação, que normalmente custa ' +
  'R$ 430,00, sai por R$ 300,00 com esse desconto.\n\n' +
  'Podemos fazer seu agendamento garantindo o desconto?';

describe('não bloqueia o que a clínica realmente manda', () => {
  it('passa o texto do desconto do F05 intacto', () => {
    const v = inspecionaSaida(F05);
    expect(v.bloqueado, JSON.stringify(v.achados)).toBe(false);
    expect(v.texto).toBe(F05);
  });

  it('"Podemos fazer seu agendamento garantindo o desconto?" é oferta, não confirmação', () => {
    const v = inspecionaSaida(
      'Podemos fazer seu agendamento garantindo o desconto?',
    );
    expect(v.bloqueado).toBe(false);
  });

  it('passa preço de consulta e de exame', () => {
    for (const t of [
      'A avaliação é R$ 430,00.',
      'Mapeamento de retina: R$ 300,00. Topografia de córnea: R$ 380,00.',
      'Como é para cirurgia e particular, a topografia sai por R$ 220,00.',
    ]) {
      expect(inspecionaSaida(t).bloqueado, t).toBe(false);
    }
  });

  it('passa o texto que a guarda bloqueou errado em produção (04/10, cenário A01)', () => {
    // Falso positivo real: "cirurgia refrativa" é modificador de "consulta de
    // avaliação", não o sujeito do preço. O paciente ficou sem resposta.
    const v = inspecionaSaida(
      'Thiago, a consulta de avaliação para cirurgia refrativa é particular, no valor de R$ 430,00.',
    );
    expect(v.bloqueado, JSON.stringify(v.achados)).toBe(false);
  });

  it('passa variações em que o valor é da consulta, com cirurgia como modificador', () => {
    for (const t of [
      'A avaliação pré-operatória para cirurgia refrativa é R$ 430,00.',
      'A consulta para avaliar a cirurgia de catarata fica R$ 430,00.',
      'Os exames pré-operatórios da refrativa somam R$ 680,00.',
    ]) {
      expect(inspecionaSaida(t).bloqueado, t).toBe(false);
    }
  });

  it('passa a oferta de horário, que não afirma nada', () => {
    const v = inspecionaSaida(
      'Tem vaga segunda às 10h. Consegue nesse horário?',
    );
    expect(v.bloqueado).toBe(false);
  });
});

describe('bloqueia o que machuca', () => {
  it('preço de cirurgia (regra dura 1b)', () => {
    for (const t of [
      'A cirurgia refrativa fica em R$ 8.000,00.',
      'A cirurgia custa R$ 5.500,00 por olho.',
      'O valor da cirurgia de catarata é R$ 7.000.',
      'Facectomia com lente intraocular: 9000 reais.',
    ]) {
      const v = inspecionaSaida(t);
      expect(v.bloqueado, t).toBe(true);
      expect(v.texto).toBe('');
      expect(
        v.achados.some((a) => a.regra === 'preco_cirurgia'),
        t,
      ).toBe(true);
    }
  });

  it('afirmar que está marcado (regra dura 3)', () => {
    for (const t of [
      'Sua consulta está marcada para segunda às 10h.',
      'Pronto, já agendei você para quarta.',
      'Ficou agendado dia 07/10.',
      'Seu horário está reservado.',
      'Já marquei pra você.',
    ]) {
      const v = inspecionaSaida(t);
      expect(v.bloqueado, t).toBe(true);
      expect(
        v.achados.some((a) => a.regra === 'agendamento_confirmado'),
        t,
      ).toBe(true);
    }
  });

  it('CPF e QUALQUER telefone não saem', () => {
    expect(
      inspecionaSaida('Seu CPF 022.363.623-15 está no cadastro.').bloqueado,
    ).toBe(true);
    expect(
      inspecionaSaida('Liga para o Vilar: (86) 99945-7661').bloqueado,
    ).toBe(true);
    // O "telefone da clínica" era inventado por mim e não existe: não há
    // exceção. A atendente não recebe ligação, só mensagem e áudio.
    expect(
      inspecionaSaida('O telefone da clínica é (86) 3226-1619.').bloqueado,
    ).toBe(true);
  });

  it('o regex global de telefone não vaza estado entre chamadas', () => {
    const t = 'Liga para (86) 99945-7661';
    expect(inspecionaSaida(t).bloqueado).toBe(true);
    expect(inspecionaSaida(t).bloqueado, 'segunda chamada').toBe(true);
  });

  it('o aviso de dado sensível não repete o dado', () => {
    const v = inspecionaSaida('CPF 022.363.623-15');
    const achado = v.achados.find((a) => a.regra === 'dado_sensivel');
    expect(achado?.trecho).toBe('(omitido)');
  });
});

describe('conserta em vez de bloquear, onde o conserto é seguro', () => {
  it('troca travessão por vírgula e envia', () => {
    const v = inspecionaSaida(
      'Terça não tem consulta — ela atende segunda de manhã.',
    );
    expect(v.bloqueado).toBe(false);
    expect(v.texto).toBe(
      'Terça não tem consulta, ela atende segunda de manhã.',
    );
    expect(v.achados[0].nivel).toBe('sanitize');
  });

  it('remove a linha de telemetria que escapou do <internal>', () => {
    const v = inspecionaSaida(
      'Tem vaga segunda às 10h.\n[intenção: verificar vaga | fonte: base (F12)]',
    );
    expect(v.bloqueado).toBe(false);
    expect(v.texto).toBe('Tem vaga segunda às 10h.');
    expect(v.achados.some((a) => a.regra === 'telemetria_vazada')).toBe(true);
  });
});

describe('avisa sem bloquear: deslize de estilo', () => {
  it('frase proibida é flag, porque jogar fora resposta correta é pior pro paciente', () => {
    const v = inspecionaSaida(
      'Para eu ver as opções certinhas, me conta: nome e cidade?',
    );
    expect(v.bloqueado).toBe(false);
    expect(v.texto).toContain('me conta');
    expect(
      v.achados.some((a) => a.regra === 'frase_proibida' && a.nivel === 'flag'),
    ).toBe(true);
  });

  it('pegaria os quatro vícios que eu achei lendo transcrição à mão', () => {
    const casos = [
      'Não está cadastrado no nosso sistema.',
      'Quer que eu veja um horário disponível pra você?',
      'Como posso te ajudar?',
      'Qualquer dúvida, estamos à disposição.',
    ];
    for (const t of casos) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'frase_proibida'),
        t,
      ).toBe(true);
    }
  });

  it('pega imperativo seco ao pedir dado', () => {
    for (const t of [
      'Me passa a data de nascimento da Joana para eu já ver um horário.',
      'Me manda seu nome completo.',
      'Preciso que você envie a cidade.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'frase_proibida'),
        t,
      ).toBe(true);
    }
  });

  it('pedido com cortesia passa limpo', () => {
    for (const t of [
      'Poderia me informar a data de nascimento da Joana? Assim eu já vejo um horário.',
      'Qual o seu nome completo, por favor?',
      'De qual cidade você é?',
    ]) {
      const v = inspecionaSaida(t);
      expect(v.achados.length, t + ' -> ' + JSON.stringify(v.achados)).toBe(0);
    }
  });

  it('pega "o que posso fazer por você", o mesmo vício com outras palavras', () => {
    // Apareceu na leva 1 da suíte (cenário A03) e passou, porque o regex só
    // conhecia "como posso ajudar".
    for (const t of [
      'Claro! O que posso fazer por você?',
      'Em que posso te ajudar?',
      'Como posso ser útil?',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'frase_proibida'),
        t,
      ).toBe(true);
    }
  });

  it('pega "inclui o exame completo", que vira cobrança inesperada no balcão', () => {
    for (const t of [
      'A avaliação é R$ 430,00 e já inclui o exame completo.',
      'Nesse valor os exames estão incluídos.',
      'A consulta inclui todos os exames.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'exames_inclusos'),
        t,
      ).toBe(true);
    }
  });

  it('nomear o que está incluso é legítimo e passa', () => {
    for (const t of [
      'A avaliação é R$ 430,00 e inclui a fundoscopia e a tonometria.',
      'Exames essenciais inclusos: Fundoscopia e Tonometria.',
      'O valor do mapeamento já inclui os dois olhos.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'exames_inclusos'),
        t,
      ).toBe(false);
    }
  });

  it('pega a negação do desconto, que conta que o desconto existe', () => {
    for (const t of [
      'A avaliação é R$ 430,00. Para pacientes particulares esse é o valor da consulta, sem desconto.',
      'Não temos desconto para o seu caso.',
      'Esse é o valor cheio mesmo.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'nega_desconto'),
        t,
      ).toBe(true);
    }
  });

  it('informar só o valor passa, que é o jeito certo', () => {
    for (const t of [
      'A avaliação é R$ 430,00.',
      'O valor da consulta é R$ 430,00.',
      'É R$ 430,00, e já inclui a fundoscopia e a tonometria.',
    ]) {
      expect(inspecionaSaida(t).achados.length, t).toBe(0);
    }
  });

  it('pega "escolha uma das opções", que é apontar para o menu', () => {
    for (const t of [
      'Para verificar a disponibilidade, preciso saber qual é a sua necessidade. Escolha uma das opções que enviei para eu te ajudar.',
      'Escolha um número para continuarmos.',
      'Selecione a opção que melhor se adequa.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'aponta_menu'),
        t,
      ).toBe(true);
    }
  });

  it('o menu em si passa: o proibido é mandar de volta a ele', () => {
    const v = inspecionaSaida(
      'Olá, tudo bem? Sou a Lara, assistente da Dra. Marina Costa.\n\n1 - Avaliação para Cirurgia Refrativa\n2 - Avaliação para Cirurgia de Catarata\n3 - Consulta Oftalmológica de Rotina\n4 - Outros',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('pedir para explicar passa, que é o jeito certo', () => {
    const v = inspecionaSaida(
      'Pode me explicar o que você está precisando? Assim eu já vejo o horário.',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('pega "liga pra gente" em contexto de dor, que saiu na suíte', () => {
    const v = inspecionaSaida(
      'Olá, sou a Lara, do atendimento da Dra. Marina. Entendo, isso deve estar incomodando bastante.\n\nSe estiver ardendo muito, liga pra gente agora: (86) 3226-1619.\n\nSó um instante.',
    );
    expect(
      v.achados.some((a) => a.regra === 'manda_ligar'),
      JSON.stringify(v.achados),
    ).toBe(true);
    // O telefone em si é bloqueado pela regra `telefone`, que omite o número.
    expect(v.bloqueado).toBe(true);
    expect(v.achados.find((a) => a.regra === 'telefone')?.trecho).toBe(
      '(omitido)',
    );
    // E nenhum achado repete o número no aviso ao humano.
    for (const a of v.achados) {
      expect(a.trecho ?? '', a.regra).not.toContain('3226');
    }
  });

  it('convida a ligar mesmo sem número: o vício é transferir o trabalho', () => {
    const v = inspecionaSaida(
      'Se a dor aumentar, pode ligar pra clínica que a gente te orienta.',
    );
    expect(v.achados.some((a) => a.regra === 'manda_ligar')).toBe(true);
  });

  it('acolher e escalar sem telefone passa limpo', () => {
    const v = inspecionaSaida(
      'Entendo, isso deve estar incomodando bastante. Só um instante.',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('BLOQUEIA afirmar que é pessoa', () => {
    for (const t of [
      'Não sou um robô, sou uma pessoa da recepção.',
      'Sou da recepção da clínica.',
      'Sou uma pessoa, sim!',
    ]) {
      const v = inspecionaSaida(t);
      expect(v.bloqueado, t).toBe(true);
      expect(
        v.achados.some((a) => a.regra === 'finge_humana'),
        t,
      ).toBe(true);
    }
  });

  it('"Só um instante." passa limpo, que é a resposta certa', () => {
    expect(inspecionaSaida('Só um instante.').achados.length).toBe(0);
  });

  it('pega valor do Pentacam, que muda por hospital', () => {
    for (const t of [
      'O Pentacam fica R$ 500,00 no Hospital do Olho.',
      'São 600 reais o pentacam no Vilar.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'valor_pentacam'),
        t,
      ).toBe(true);
    }
  });

  it('a resposta de cobertura do Pentacam passa limpa', () => {
    const v = inspecionaSaida(
      'O Pentacam nenhum convênio cobre, ele é particular. E não fazemos aqui no consultório.',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('pega pedido do convênio para quem acabou de dizer o plano', () => {
    const v = inspecionaSaida(
      'Infelizmente a consulta pelo IASPI a gente não atende, seria particular, R$ 430,00.\n\nPara eu já ver um horário, poderia me informar:\n\nNome completo do paciente:\nData de nascimento:\nCidade:\nConvênio (ou particular):',
    );
    expect(
      v.achados.some((a) => a.regra === 'pede_dado_repetido'),
      JSON.stringify(v.achados),
    ).toBe(true);
  });

  it('o formulário completo para quem não disse nada passa limpo', () => {
    const v = inspecionaSaida(
      'Muito obrigada pelo seu contato. Para darmos início ao seu atendimento, poderia me informar:\n\nNome completo do paciente:\nData de nascimento:\nCidade:\nConvênio (ou particular):',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('pega pedido de dado de CNPJ, que devia ter escalado', () => {
    for (const t of [
      'Para a nota em nome da empresa, me envie o CNPJ e a razão social.',
      'Preciso da inscrição municipal também.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'coleta_cnpj'),
        t,
      ).toBe(true);
    }
  });

  it('o formulário de nota para pessoa física passa limpo', () => {
    const v = inspecionaSaida(
      'Para a emissão da nota fiscal precisaremos dos seguintes dados do titular da nota: Nome completo, CPF, Endereço completo com CEP.',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('pega "atende sim" para IASPI, que esconde a exclusão da consulta', () => {
    const v = inspecionaSaida(
      'Atende sim, o IASPI cobre cirurgia pelo PLAMTA.',
    );
    expect(
      v.achados.some((a) => a.regra === 'plano_parcial'),
      JSON.stringify(v.achados),
    ).toBe(true);
  });

  it('dizer a exclusão da consulta junto passa', () => {
    const v = inspecionaSaida(
      'Infelizmente a consulta pelo IASPI a gente não atende, seria particular. Já a cirurgia conseguimos fazer pelo PLAMTA.',
    );
    expect(
      v.achados.some((a) => a.regra === 'plano_parcial'),
      JSON.stringify(v.achados),
    ).toBe(false);
  });

  it('pega "são dois exames", que faz o paciente orçar errado', () => {
    for (const t of [
      'Os exames pré-operatórios são dois, e a gente faz aqui mesmo no consultório.',
      'São apenas dois exames.',
      'Precisa só esses dois.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'completude_falsa'),
        t,
      ).toBe(true);
    }
  });

  it('listar os dois do consultório sem afirmar completude passa', () => {
    const v = inspecionaSaida(
      'Aqui no consultório a gente faz dois, e o valor já inclui os dois olhos: mapeamento R$ 300,00 e topografia R$ 380,00. Dependendo do seu caso a Dra. Marina pode pedir outros.',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('"Sou a Lara" numa resposta factual não exige menu', () => {
    const v = inspecionaSaida(
      'Sou a Lara, assistente da Dra. Marina Costa.\n\nA clínica fica na Av. Elias João Tajra, 1170, Sala 07.',
    );
    expect(
      v.achados.some((a) => a.regra === 'abertura_malformada'),
      JSON.stringify(v.achados),
    ).toBe(false);
  });

  it('pega quem anuncia ser automática, em qualquer lugar da mensagem', () => {
    for (const t of [
      'Olá! Sou a Lara, atendimento automático da Dra. Marina Costa.',
      'Sou a assistente virtual da clínica.',
    ]) {
      const v = inspecionaSaida(t);
      expect(
        v.achados.some((a) => a.regra === 'anuncia_bot'),
        t,
      ).toBe(true);
    }
  });

  it('pega menu numerado sem separar refrativa de catarata', () => {
    const v = inspecionaSaida(
      'Escolha:\n1 - Avaliação para cirurgia\n2 - Consulta de rotina\n3 - Outros',
    );
    expect(v.achados.some((a) => a.regra === 'menu_resumido')).toBe(true);
  });

  it('cumprimentar e responder um fato, SEM menu, passa limpo', () => {
    // 68 dos 70 avisos da 3ª passada eram a regra antiga reprovando isto.
    for (const t of [
      'Olá! Sou a Lara, assistente da Dra. Marina Costa. A clínica fica na Av. Elias João Tajra, 1170.',
      'Boa tarde! Sou a Lara. A avaliação é R$ 430,00.',
    ]) {
      const v = inspecionaSaida(t);
      expect(v.achados.length, t + ' -> ' + JSON.stringify(v.achados)).toBe(0);
    }
  });

  it('o menu completo passa limpo', () => {
    const v = inspecionaSaida(
      'Olá, tudo bem? Sou a Lara, assistente da Dra. Marina Costa.\n\n1 - Avaliação para Cirurgia Refrativa\n2 - Avaliação para Cirurgia de Catarata\n3 - Consulta Oftalmológica de Rotina\n4 - Outros',
    );
    expect(v.achados.length, JSON.stringify(v.achados)).toBe(0);
  });

  it('nome de bloco do FAQ no texto ao paciente é flag', () => {
    const v = inspecionaSaida('Conforme o F12, tem vaga segunda.');
    expect(v.achados.some((a) => a.regra === 'linguagem_interna')).toBe(true);
  });
});

describe('achaPrecoDeCirurgia: o sujeito do preço, não a vizinhança', () => {
  it('cirurgia antes do valor, sem assunto precificável no meio: bloqueia', () => {
    expect(
      achaPrecoDeCirurgia('para a cirurgia o valor é R$ 8.000'),
    ).toBeDefined();
  });

  it('cirurgia antes, mas avaliação mais perto do valor: passa', () => {
    expect(
      achaPrecoDeCirurgia(
        'quem quer fazer a cirurgia paga na avaliação R$ 300,00',
      ),
    ).toBeUndefined();
  });

  it('valor sem nenhum assunto de cirurgia antes: passa', () => {
    expect(achaPrecoDeCirurgia('São R$ 430,00.')).toBeUndefined();
  });

  it('caso misto: bloqueia o 2º valor, que é o da cirurgia', () => {
    const a = achaPrecoDeCirurgia(
      'a avaliação é R$ 430,00 e a cirurgia fica R$ 8.000,00',
    );
    expect(a).toBeDefined();
    expect(a?.trecho).toContain('8.000');
  });
});

// ---------------------------------------------------------------------------
// veredito sobre o paciente se encaixar nos critérios (F09)
//
// Os critérios da ANS são numéricos e o paciente informa o grau dele na mesma
// mensagem. Apresentar o critério é o trabalho; fechar a conta por ele, não.
describe('veredito_criterio', () => {
  const bloqueia = (t: string) =>
    inspecionaSaida(t).achados.some((a) => a.regra === 'veredito_criterio');

  it('bloqueia o veredito, em qualquer das formas que ele sai', () => {
    for (const t of [
      'Com 4 graus de miopia você não se encaixa nos critérios do plano.',
      'Você atende os critérios, pode seguir com a autorização.',
      'Pelo que você falou, o seu grau está dentro do que o plano exige.',
      'Infelizmente o seu grau está fora da faixa coberta.',
      'No seu caso o plano cobre sim.',
      'No seu caso, o plano não vai cobrir.',
      'Você tem direito à cobertura pelo convênio.',
      'Com esses graus o plano autoriza.',
      'O seu caso se encaixa nos critérios da ANS.',
      'Você não atende aos critérios de cobertura.',
    ]) {
      expect(bloqueia(t), t).toBe(true);
    }
  });

  it('NÃO bloqueia apresentar o critério, que é exatamente o que ela deve fazer', () => {
    for (const t of [
      'Para o plano autorizar a cirurgia refrativa, os critérios são: mais de 18 anos, grau estável há pelo menos um ano, miopia de -5,0 a -10,0 graus, com ou sem astigmatismo de até -4,0.',
      'Os critérios são da ANS, não da clínica. Quem autoriza é o seu plano, e a indicação é da Dra. Marina depois da avaliação.',
      'A cirurgia a maioria dos convênios cobre, depende de o seu plano autorizar e de você estar dentro dos critérios que ele exige.',
      'Hipermetropia até 6,0 graus também entra, com astigmatismo associado de até -4,0.',
      'O grau precisa estar estável há pelo menos um ano.',
    ]) {
      expect(bloqueia(t), t).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Teste estrutural: a guarda não pode bloquear o que a clínica aprovou.
//
// Onze falsos positivos meus nesta sessão tiveram todos a mesma forma: o
// critério de detecção mais estreito que o comportamento correto. Conferir
// regra por regra à mão não pega isso, porque o erro está justamente no caso
// que eu não imaginei. Então a tabela inteira passa pela guarda, e a falha vem
// de graça a cada texto novo que a clínica aprovar.
describe('a guarda contra a tabela de templates aprovados', () => {
  const tabela = JSON.parse(
    readFileSync('groups/whatsapp_atendimento-teste/templates.json', 'utf-8'),
  ) as { intencoes: Record<string, { textos?: string[] }> };

  const VALOR: Record<string, string> = {
    valor_consulta: '430,00',
    valor_desconto: '300,00',
    dia: 'segunda',
    data: '06/10',
    hora: '09:20',
    dia_pedido: 'sábado',
  };

  const casos: Array<[string, string]> = [];
  for (const [nome, d] of Object.entries(tabela.intencoes)) {
    for (const bruto of d.textos ?? []) {
      let t = bruto;
      for (const [k, v] of Object.entries(VALOR)) t = t.split(`{${k}}`).join(v);
      casos.push([nome, t]);
    }
  }

  it('tem texto para conferir', () => {
    expect(casos.length).toBeGreaterThan(30);
  });

  it('NENHUM texto aprovado é bloqueado', () => {
    for (const [nome, t] of casos) {
      const v = inspecionaSaida(t);
      const motivos = v.achados
        .filter((a) => a.nivel === 'block')
        .map((a) => `${a.regra}: "${a.trecho}"`);
      expect(motivos, `${nome} bloqueado -> ${motivos.join('; ')}`).toEqual([]);
    }
  });

  it('e nenhum carrega travessão nem markdown, que são flag de estilo', () => {
    for (const [nome, t] of casos) {
      expect(t, nome).not.toMatch(/[—–]|\*\*/);
    }
  });
});
