import { describe, expect, it } from 'vitest';

import {
  duasOpcoes,
  perfilDe,
  periodoPedido,
  slotsDaVaga,
  temDescontoDeConsulta,
  vagaEscolhida,
  vagaNoPeriodo,
} from './vagas.js';

// O perfil decide duração, antecedência e cota da agenda. Errá-lo não produz
// texto errado: produz uma vaga que não existe, já prometida ao paciente. Por
// isso a regra do F12 é "não rode no chute", e aqui isso significa undefined.
describe('uma só definição de intenção cirúrgica (Codex, 17/10/2026)', () => {
  // As duas definições discordavam. Eu tinha escrito um regex próprio no
  // executor para escolher o texto de preço que fala de óculos, e ele
  // reconhecia "quero parar de usar óculos"; o `ehCirurgico` daqui não. O mesmo
  // paciente recebia o enquadramento de cirurgia refrativa E o preço cheio da
  // consulta, porque o desconto julgou que não havia intenção cirúrgica.
  it('"parar de usar óculos" dá desconto igual a "refrativa"', () => {
    for (const n of [
      'quero parar de usar óculos',
      'cirurgia refrativa',
      'tenho miopia e astigmatismo',
      'queria fazer lasik',
      'cirurgia de catarata',
    ]) {
      expect(temDescontoDeConsulta(n, 'Bradesco'), n).toBe(true);
    }
  });

  it('o mesmo vocabulário manda para o perfil cirúrgico', () => {
    expect(perfilDe('quero parar de usar óculos', 'Bradesco')).toContain(
      'cirurgia',
    );
  });

  // Conferência pedida pelo Thiago em 18/10: "o desconto só ocorre quando a
  // intenção é cirúrgica". Ocorria, menos num caso que eu tinha acabado de
  // criar — "óculos" solto no vocabulário fazia "trocar o grau do óculos"
  // valer R$ 300. Trocar o grau é ROTINA: quer receita nova, não operar.
  it('óculos só conta com verbo de livrar-se deles', () => {
    for (const n of [
      'quero parar de usar óculos',
      'queria largar os óculos',
      'quero me livrar dos oculos',
      'queria ficar sem óculos',
    ]) {
      expect(temDescontoDeConsulta(n, 'Bradesco'), n).toBe(true);
    }
    for (const n of [
      'preciso trocar o grau do óculos',
      'quebrei meus óculos',
      'perdi o óculos',
    ]) {
      expect(temDescontoDeConsulta(n, 'Bradesco'), n).toBe(false);
    }
  });

  // ⚠️ "Não tenho plano" custou R$ 130 na passada 17 (C01). O paciente escreveu
  // "Carlos, Teresina, particular, nao tenho plano", o modelo gravou `convenio:
  // "não tenho plano"`, e a lista curta — `particular|sem plano|nenhum` — não
  // casava. Virou "plano não aceito", e a Lara ofereceu R$ 300,00 a quem paga
  // R$ 430,00, com um texto que abre dizendo "esse convênio não é atendido" a
  // quem acabou de dizer que não tem convênio.
  it.each([
    'particular',
    'Particular',
    'não tenho plano',
    'nao tenho plano',
    'particular, nao tenho plano',
    'não tenho convênio',
    'nao possuo plano',
    'sem plano',
    'sem convênio',
    'sem seguro',
    'nenhum',
    'privado',
    'pago do meu bolso',
    'por fora',
  ])('"%s" NÃO dá desconto, mesmo querendo operar', (convenio) => {
    expect(
      temDescontoDeConsulta('quero parar de usar óculos', convenio),
      convenio,
    ).toBe(false);
  });

  // ⚠️ E o par que segura a regra: plano de verdade continua dando desconto.
  // Afrouxar a lista até ninguém receber é tão errado quanto a lista curta.
  it.each(['Bradesco Saúde', 'Amil', 'SulAmérica', 'Hapvida', 'IASPI'])(
    '"%s" continua dando desconto',
    (convenio) => {
      expect(
        temDescontoDeConsulta('quero parar de usar óculos', convenio),
        convenio,
      ).toBe(true);
    },
  );

  it('rotina continua sem desconto e sem perfil cirúrgico', () => {
    expect(temDescontoDeConsulta('consulta de rotina', 'Bradesco')).toBe(false);
    expect(perfilDe('consulta de rotina', 'Bradesco')).not.toContain(
      'cirurgia',
    );
  });

  it('plano ACEITO não tem desconto, mesmo sendo cirúrgico', () => {
    expect(temDescontoDeConsulta('quero parar de usar óculos', 'Unimed')).toBe(
      false,
    );
  });
});

describe('perfilDe', () => {
  it('cruza necessidade e convênio', () => {
    expect(perfilDe('cirurgia refrativa', 'particular')).toBe(
      'particular-cirurgia',
    );
    expect(perfilDe('catarata', 'Unimed')).toBe('unimed-cirurgia');
    expect(perfilDe('consulta de rotina', 'unimed')).toBe('unimed');
    expect(perfilDe('rotina', 'Bradesco Saúde')).toBe('particular');
    expect(perfilDe('retorno de cirurgia', 'particular')).toBe(
      'retorno-cirurgia',
    );
    expect(perfilDe('retorno', 'particular')).toBe('retorno');
  });

  it('plano não atendido cai em particular, que é o que ele vai pagar', () => {
    // A consulta só é coberta para Unimed. Com Amil, a vaga é de particular,
    // e a duração/antecedência precisam ser as de particular.
    expect(perfilDe('cirurgia', 'Amil')).toBe('particular-cirurgia');
    expect(perfilDe('rotina', 'IASPI')).toBe('particular');
  });

  it('exame não depende de convênio', () => {
    expect(perfilDe('exame', undefined)).toBe('exame');
  });

  it('faltando necessidade ou convênio, NÃO escolhe', () => {
    expect(perfilDe(undefined, 'particular')).toBeUndefined();
    expect(perfilDe('cirurgia', undefined)).toBeUndefined();
    expect(perfilDe('rotina', '')).toBeUndefined();
    expect(perfilDe('', '')).toBeUndefined();
  });
});

describe('slotsDaVaga', () => {
  it('converte a data ISO para DD/MM, como a clínica escreve', () => {
    expect(
      slotsDaVaga({
        data: '2026-10-06',
        dia_semana: 'segunda',
        inicio: '09:20',
        fim: '09:50',
      }),
    ).toEqual({ dia: 'segunda', data: '06/10', hora: '09:20' });
  });

  it('data em formato inesperado passa crua, em vez de virar lixo', () => {
    const s = slotsDaVaga({
      data: 'amanhã',
      dia_semana: 'terça',
      inicio: '10:00',
      fim: '10:30',
    });
    expect(s.data).toBe('amanhã');
    expect(s.data).not.toContain('undefined');
  });
});

// O bug que só apareceu no primeiro uso real: o processo do app NÃO recebe o
// .env pelo ambiente (o ecosystem só define NODE_ENV), então `-e NOME`, que
// herda o valor do cliente docker, não passava nada e o container subia sem
// credencial. Meus testes manuais não pegaram porque eu rodava `set -a; . ./.env`
// antes — validei num ambiente que produção não tem.
describe('garanteCredenciais', () => {
  it('não sobrescreve o que já está no ambiente', async () => {
    const antes = process.env.ICLINIC_EMAIL;
    process.env.ICLINIC_EMAIL = 'do-ambiente@exemplo';
    const { garanteCredenciais } = await import('./vagas.js');
    garanteCredenciais();
    expect(process.env.ICLINIC_EMAIL).toBe('do-ambiente@exemplo');
    if (antes === undefined) delete process.env.ICLINIC_EMAIL;
    else process.env.ICLINIC_EMAIL = antes;
  });

  it('a lista cobre as quatro variáveis que o script usa', async () => {
    const { CREDENCIAIS } = await import('./vagas.js');
    expect(CREDENCIAIS).toEqual([
      'ICLINIC_EMAIL',
      'ICLINIC_PASSWORD',
      'ICLINIC_CLINIC_ID',
      'ICLINIC_PHYSICIAN_ID',
    ]);
  });
});

describe('vagaEscolhida: duas opções exigem saber qual (19/10/2026)', () => {
  const A = {
    data: '2026-10-20',
    dia_semana: 'terça',
    inicio: '09:00',
    fim: '09:20',
  };
  const B = {
    data: '2026-10-22',
    dia_semana: 'quinta',
    inicio: '14:30',
    fim: '14:50',
  };

  it('com UMA vaga, qualquer aceite serve', () => {
    expect(vagaEscolhida([A], 'pode ser')).toBe(A);
  });

  it.each([
    ['a primeira', A],
    ['o segundo', B],
    ['quinta', B],
    ['terça fica melhor', A],
    ['pode ser 14:30', B],
    ['as 9h fica bom', A],
    ['9:00 pode ser', A],
    ['as 14h30', B],
    ['14h', B],
    ['dia 22/10', B],
  ])('%s escolhe certo', (texto, esperada) => {
    expect(vagaEscolhida([A, B], texto as string)).toBe(esperada);
  });

  // ⚠️ ORDINAL x DIA DA SEMANA: "segunda" é as duas coisas, e a primeira
  // versão casava o ordinal primeiro. Reproduzido pelo review adversarial do
  // Codex em 19/10/2026: "pode ser segunda", com segunda e quarta oferecidas,
  // marcava QUARTA. Meu teste original usava terça e quinta, que não colidem.
  const SEG = {
    data: '2026-10-19',
    dia_semana: 'segunda',
    inicio: '09:00',
    fim: '09:30',
  };
  const QUA = {
    data: '2026-10-21',
    dia_semana: 'quarta',
    inicio: '10:00',
    fim: '10:30',
  };

  it.each([
    ['pode ser segunda', SEG],
    ['segunda-feira fica melhor', SEG],
    ['na segunda', SEG],
    ['pode ser quarta', QUA],
    // Ordinal EXPLÍCITO vence o dia: "opção" marca, o masculino não é dia.
    ['prefiro a segunda opção', QUA],
    ['o segundo', QUA],
    ['2ª opção', QUA],
  ])('%s com segunda+quarta na mesa', (texto, esperada) => {
    expect(vagaEscolhida([SEG, QUA], texto as string)).toBe(esperada);
  });

  // Ordinal NU só vale quando nenhuma vaga é daquele dia.
  it('"a segunda" é ordinal quando não há segunda-feira oferecida', () => {
    expect(vagaEscolhida([A, B], 'a segunda')).toBe(B);
  });

  it('"a segunda" é o DIA quando há segunda-feira oferecida', () => {
    expect(vagaEscolhida([SEG, QUA], 'a segunda')).toBe(SEG);
  });

  // Negação: "a primeira não, pode ser a segunda" marcava a PRIMEIRA.
  it.each([
    'a primeira não, pode ser a segunda',
    'nenhuma das duas',
    'essa não, tem outra?',
  ])('%s é ambíguo, não escolhe', (texto) => {
    expect(vagaEscolhida([SEG, QUA], texto)).toBeUndefined();
  });

  // ⚠️ O caso que importa: "pode ser" com DUAS na mesa não diz qual. Devolver
  // a primeira mandaria a pessoa à clínica no dia errado.
  it.each(['pode ser', 'ok', 'tá bom', 'confirma', 'qualquer um'])(
    '%s NÃO escolhe: é ambíguo',
    (texto) => {
      expect(vagaEscolhida([A, B], texto)).toBeUndefined();
    },
  );

  it('texto que casa com as duas também é ambíguo', () => {
    const C = { ...B, inicio: '09:00' };
    expect(vagaEscolhida([A, C], 'as 09:00')).toBeUndefined();
  });
});

/**
 * As duas opções em DIAS DISTINTOS (Thiago, 19/10/2026).
 *
 * Antes era `vagas.slice(0, 2)`, e como o `iclinic_vagas.py` esgota as posições
 * de um dia antes de ir para o próximo, as duas saíam coladas:
 * "quarta, dia 21/10, às 17:40 ou às 18:00". Vinte minutos de diferença não é
 * escolha.
 */
describe('duasOpcoes', () => {
  const v = (data: string, inicio: string, dia_semana = 'quarta') => ({
    data,
    dia_semana,
    inicio,
    fim: inicio,
  });

  it('pula as vagas do mesmo dia e pega a melhor do dia seguinte', () => {
    const r = duasOpcoes([
      v('2026-10-21', '17:40'),
      v('2026-10-21', '18:00'),
      v('2026-10-23', '09:20', 'sexta'),
      v('2026-10-23', '10:00', 'sexta'),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].data).toBe('2026-10-21');
    expect(r[0].inicio).toBe('17:40');
    // A MELHOR do outro dia, não a primeira que aparecer depois.
    expect(r[1].data).toBe('2026-10-23');
    expect(r[1].inicio).toBe('09:20');
  });

  it('preserva a ordem do script: a primeira é sempre a melhor', () => {
    const r = duasOpcoes([
      v('2026-10-26', '08:00', 'segunda'),
      v('2026-10-21', '17:40'),
    ]);
    expect(r[0].data).toBe('2026-10-26');
    expect(r[1].data).toBe('2026-10-21');
  });

  // ⚠️ FALLBACK: com um dia só, duas no mesmo dia continua melhor que uma.
  // É por isso que o `textos_dois_mesmo_dia` continua existindo.
  it('só um dia disponível volta a oferecer duas no mesmo dia', () => {
    const r = duasOpcoes([v('2026-10-21', '17:40'), v('2026-10-21', '18:00')]);
    expect(r).toHaveLength(2);
    expect(r[0].data).toBe(r[1].data);
  });

  it('uma vaga só devolve uma', () => {
    expect(duasOpcoes([v('2026-10-21', '17:40')])).toHaveLength(1);
  });

  it('nenhuma vaga devolve nada', () => {
    expect(duasOpcoes([])).toEqual([]);
  });
});

describe('duasOpcoes: o teto de 10 dias (Thiago, 19/10/2026)', () => {
  const v = (data: string, inicio: string) => ({
    data,
    dia_semana: 'quarta',
    inicio,
    fim: inicio,
  });

  it('dentro do teto, oferece as duas', () => {
    const r = duasOpcoes([v('2026-10-21', '17:40'), v('2026-10-31', '09:00')]);
    expect(r).toHaveLength(2);
    expect(r[1].data).toBe('2026-10-31'); // exatamente 10 dias
  });

  // ⛔ Passando do teto: UMA opção. "Quarta 21/10 ou segunda 03/11" não é
  // escolha, é ruído — e o paciente pode pedir outro dia, que o host trata.
  it('além do teto, oferece só uma', () => {
    const r = duasOpcoes([v('2026-10-21', '17:40'), v('2026-11-03', '09:00')]);
    expect(r).toHaveLength(1);
    expect(r[0].data).toBe('2026-10-21');
  });

  // ⚠️ E o fallback do mesmo dia continua vencendo o dia distante: duas no
  // mesmo dia é escolha pior, mas é escolha.
  it('mesmo dia vence o outro dia longe demais', () => {
    const r = duasOpcoes([
      v('2026-10-21', '17:40'),
      v('2026-10-21', '18:00'),
      v('2026-11-03', '09:00'),
    ]);
    expect(r).toHaveLength(2);
    expect(r[1].data).toBe('2026-10-21');
  });

  it('data em formato inesperado não vira segunda opção', () => {
    const r = duasOpcoes([v('2026-10-21', '17:40'), v('amanhã', '09:00')]);
    expect(r).toHaveLength(1);
  });
});

describe('periodoPedido e vagaNoPeriodo (Marina, 19/10/2026)', () => {
  it.each([
    ['quarta pela manhã', 'manha'],
    ['de manhã', 'manha'],
    ['tem de manha?', 'manha'],
    ['atende no período matutino?', 'manha'],
    ['prefiro de tarde', 'tarde'],
    ['à tarde', 'tarde'],
    ['vespertino', 'tarde'],
  ])('%s -> %s', (texto, esperado) => {
    expect(periodoPedido(texto), texto).toBe(esperado);
  });

  // ⚠️ Sem período, undefined: não inventa janela para quem não pediu.
  it.each(['quarta', 'tem horario?', '10h', 'amanhã', ''])(
    'sem período: %s',
    (texto) => {
      expect(periodoPedido(texto), texto).toBeUndefined();
    },
  );

  // ⚠️ O corte é meio-dia, e é por isso que período NÃO é hora: mapear "manhã"
  // para 08:00 faria o host dizer "nesse horário não dá, mas tenho 09:20" — e
  // 09:20 é de manhã.
  it.each([
    ['08:00', 'manha', true],
    ['09:20', 'manha', true],
    ['11:59', 'manha', true],
    ['12:00', 'manha', false],
    ['14:30', 'manha', false],
    ['14:30', 'tarde', true],
    ['17:40', 'tarde', true],
    ['11:59', 'tarde', false],
  ])('%s em %s -> %s', (inicio, periodo, esperado) => {
    const v = { data: '2026-10-21', dia_semana: 'quarta', inicio, fim: inicio };
    expect(vagaNoPeriodo(v, periodo as 'manha' | 'tarde')).toBe(esperado);
  });

  it('hora inválida não cai em período nenhum', () => {
    const v = {
      data: '2026-10-21',
      dia_semana: 'quarta',
      inicio: '??',
      fim: '',
    };
    expect(vagaNoPeriodo(v, 'manha')).toBe(false);
    expect(vagaNoPeriodo(v, 'tarde')).toBe(false);
  });
});
