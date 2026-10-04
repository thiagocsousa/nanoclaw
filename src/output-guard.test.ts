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

  it('passa o telefone da clínica', () => {
    const v = inspecionaSaida(
      'Se estiver doendo muito, liga pra gente: (86) 3226-1619',
    );
    expect(v.bloqueado, JSON.stringify(v.achados)).toBe(false);
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

  it('CPF e telefone de terceiro não saem', () => {
    expect(
      inspecionaSaida('Seu CPF 022.363.623-15 está no cadastro.').bloqueado,
    ).toBe(true);
    expect(
      inspecionaSaida('Liga para o Vilar: (86) 99945-7661').bloqueado,
    ).toBe(true);
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
