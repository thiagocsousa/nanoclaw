import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'agend-'));
const PASTA = 'whatsapp_agend-teste';

vi.mock('./config.js', async (orig) => ({
  ...(await orig<typeof import('./config.js')>()),
  GROUPS_DIR: RAIZ,
}));

let mod: typeof import('./agendamento.js');

const VAGA = {
  data: '2026-10-06',
  dia_semana: 'segunda',
  inicio: '09:20',
  fim: '09:50',
};

const base = {
  operacao: 'marcar' as const,
  paciente: 'Joana Silva',
  pedidoPor: '5586999@s.whatsapp.net',
  data: '2026-10-06',
  hora: '09:20',
  perfil: 'particular-cirurgia',
};

/** Releitura e escrita injetadas: aqui se testa a DECISÃO, não o iClinic. */
function deps(opts: { livre?: boolean; falhaEscrita?: boolean } = {}) {
  const chamadas: Array<{ perfil: string; dia?: string; hora?: string }> = [];
  const fins: string[] = [];
  return {
    chamadas,
    fins,
    relê: async (
      _f: string,
      perfil: string,
      o: { dia?: string; hora?: string } = {},
    ) => {
      chamadas.push({ perfil, dia: o.dia, hora: o.hora });
      return opts.livre === false ? [] : [VAGA];
    },
    escreve: async (_f: string, _d: unknown, fim: string) => {
      fins.push(fim);
      if (opts.falhaEscrita) throw new Error('endpoint não descoberto');
      return { eventoId: 'evt-77' };
    },
  };
}

beforeEach(async () => {
  fs.mkdirSync(path.join(RAIZ, PASTA), { recursive: true });
  vi.resetModules();
  mod = await import('./agendamento.js');
});

afterEach(() => {
  fs.rmSync(path.join(RAIZ, PASTA, 'agendamentos_feitos.jsonl'), {
    force: true,
  });
});

describe('o caminho que funciona', () => {
  it('marca, registra no livro e devolve o evento', async () => {
    const d = deps();
    const r = await mod.marca(PASTA, base, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jaExistia).toBe(false);
    expect(r.marcacao.eventoId).toBe('evt-77');
    expect(mod.leMarcacoes(PASTA)).toHaveLength(1);
  });

  it('relê a vaga EXATA antes de escrever: dia e hora, não o próximo livre', async () => {
    const d = deps();
    await mod.marca(PASTA, base, d);
    expect(d.chamadas).toEqual([
      { perfil: 'particular-cirurgia', dia: '2026-10-06', hora: '09:20' },
    ]);
  });
});

// A janela entre oferecer e marcar é onde a colisão vive. Uma pessoa clicando
// "confirmar" três minutos depois não a fecha; reler no instante da escrita fecha.
describe('trava 1: releitura no instante da escrita', () => {
  it('vaga tomada NÃO escreve, e diz por quê', async () => {
    const r = await mod.marca(PASTA, base, deps({ livre: false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('vaga_tomada');
    expect(r.detalhe).toContain('09:20');
    expect(mod.leMarcacoes(PASTA)).toHaveLength(0);
  });
});

// Sem isso, um retry de rede ou mensagem duplicada viram duas consultas, e a
// segunda ocupa o horário de outro paciente.
describe('trava 2: idempotência', () => {
  it('a segunda chamada devolve a primeira, sem escrever de novo', async () => {
    const d = deps();
    const a = await mod.marca(PASTA, base, d);
    const b = await mod.marca(PASTA, base, d);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.jaExistia).toBe(true);
    expect(b.marcacao.feitoEm).toBe(a.marcacao.feitoEm);
    expect(mod.leMarcacoes(PASTA)).toHaveLength(1);
    // E não foi à rede na segunda: a trava barata vem primeiro.
    expect(d.chamadas).toHaveLength(1);
  });

  it('o nome reescrito não cria um segundo agendamento', async () => {
    const d = deps();
    await mod.marca(PASTA, base, d);
    const r = await mod.marca(
      PASTA,
      { ...base, paciente: 'Joana Silva Santos' },
      d,
    );
    expect(r.ok && r.jaExistia).toBe(true);
    expect(mod.leMarcacoes(PASTA)).toHaveLength(1);
  });

  it('outro horário do mesmo paciente É um agendamento novo', async () => {
    const d = deps();
    await mod.marca(PASTA, base, d);
    const r = await mod.marca(PASTA, { ...base, hora: '10:00' }, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jaExistia).toBe(false);
    expect(mod.leMarcacoes(PASTA)).toHaveLength(2);
  });
});

describe('falha fecha, sempre com motivo', () => {
  it('nunca lança: devolve ok:false com motivo', async () => {
    const r = await mod.marca(PASTA, base, deps({ falhaEscrita: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('escrita_indisponivel');
    expect(mod.leMarcacoes(PASTA)).toHaveLength(0);
  });

  it('dado faltando não vai à rede', async () => {
    for (const k of [
      'paciente',
      'data',
      'hora',
      'perfil',
      'pedidoPor',
    ] as const) {
      const d = deps();
      const r = await mod.marca(PASTA, { ...base, [k]: '' }, d);
      expect(r.ok, k).toBe(false);
      if (!r.ok) expect(r.motivo).toBe('dado_faltando');
      expect(d.chamadas, k).toHaveLength(0);
    }
  });

  it('remarcar e cancelar são recusados no código, não no prompt', async () => {
    for (const op of ['remarcar', 'cancelar']) {
      const d = deps();
      const r = await mod.marca(
        PASTA,
        { ...base, operacao: op as unknown as 'marcar' },
        d,
      );
      expect(r.ok, op).toBe(false);
      if (!r.ok) expect(r.motivo).toBe('operacao_nao_permitida');
      expect(d.chamadas, op).toHaveLength(0);
    }
  });
});

// Automático não é invisível: a clínica tem que ficar sabendo.
describe('o aviso à clínica', () => {
  it('traz o que a recepção precisa conferir depois do fato', async () => {
    const r = await mod.marca(
      PASTA,
      { ...base, nascimento: '10/03/1980', convenio: 'particular' },
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = mod.avisoDaMarcacao(r.marcacao);
    expect(a).toContain('Joana Silva');
    expect(a).toContain('06/10/2026 às 09:20');
    expect(a).toContain('10/03/1980');
    expect(a).toContain('evt-77');
  });

  it('omite campo ausente em vez de mostrar vazio', async () => {
    const r = await mod.marca(PASTA, base, deps());
    if (!r.ok) return;
    const a = mod.avisoDaMarcacao(r.marcacao);
    expect(a).not.toContain('Nascimento:');
    expect(a).not.toMatch(/\n\n\n/);
  });
});

describe('escreveNoIclinic', () => {
  // Sem o script na pasta não há como escrever, e isso tem que falhar ALTO:
  // silêncio aqui viraria "marquei" sem ter marcado.
  it('sem o iclinic_marcar.py na pasta, lança dizendo qual pasta', async () => {
    await expect(mod.escreveNoIclinic(PASTA, base, '09:50')).rejects.toThrow(
      /iclinic_marcar\.py não existe/,
    );
  });

  it('e marca() transforma isso em recusa com motivo, sem lançar', async () => {
    const r = await mod.marca(PASTA, base, { relê: async () => [VAGA] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('escrita_indisponivel');
    expect(mod.leMarcacoes(PASTA)).toHaveLength(0);
  });
});

// O fim vem da vaga RELIDA, não de uma tabela de durações no host: a aritmética
// de agenda tem uma fonte só. Duplicá-la faria a vaga ser achada com uma
// largura e escrita com outra — evento curto ou sobreposto, sem erro visível.
describe('o fim enviado ao script vem da agenda', () => {
  it('usa o fim da vaga relida, não um cálculo local', async () => {
    const d = deps();
    await mod.marca(PASTA, base, d);
    expect(d.fins).toEqual([VAGA.fim]);
  });
});

describe('telefone a partir do JID', () => {
  // Esta função já foi a causa de três rodadas de teste perdidas em 05/10/2026:
  // mandava o LID como telefone e a marcação recusava o próprio paciente.
  it('aceita o JID de telefone, com e sem DDI', () => {
    expect(mod.telefoneDoJid('558681512111@s.whatsapp.net')).toBe(
      '558681512111',
    );
    expect(mod.telefoneDoJid('8681512111@s.whatsapp.net')).toBe('8681512111');
    expect(mod.telefoneDoJid('86981512111@s.whatsapp.net')).toBe('86981512111');
  });

  it('recusa o LID, que não é telefone', () => {
    expect(mod.telefoneDoJid('195421196562669@lid')).toBeUndefined();
    // 15 dígitos não passariam pelo regex de qualquer jeito, mas um LID curto
    // passaria — o sufixo `@lid` é que decide.
    expect(mod.telefoneDoJid('558681512111@lid')).toBeUndefined();
  });

  it('recusa o que não é número de gente', () => {
    expect(
      mod.telefoneDoJid('120363275085162068@g.us'),
    ).toBeUndefined();
    expect(mod.telefoneDoJid('')).toBeUndefined();
    expect(mod.telefoneDoJid('@s.whatsapp.net')).toBeUndefined();
  });
});
