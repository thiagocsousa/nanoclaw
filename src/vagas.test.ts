import { describe, expect, it } from 'vitest';

import {
  perfilDe,
  slotsDaVaga,
  temDescontoDeConsulta,
  vagaEscolhida,
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
