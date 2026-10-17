import { describe, expect, it } from 'vitest';

import { perfilDe, slotsDaVaga, temDescontoDeConsulta } from './vagas.js';

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
