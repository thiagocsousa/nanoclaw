import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'revisao-'));
const PASTA = 'whatsapp_atendimento-teste';

vi.mock('./config.js', async (orig) => ({
  ...(await orig<typeof import('./config.js')>()),
  GROUPS_DIR: RAIZ,
}));

let mod: typeof import('./revisao-humana.js');

beforeEach(async () => {
  process.env.REVISAO_HUMANA_FOLDERS = PASTA;
  process.env.REVISAO_JID = '120363000@g.us';
  process.env.REVISAO_FOLDER = 'whatsapp_main';
  fs.mkdirSync(path.join(RAIZ, PASTA), { recursive: true });
  fs.rmSync(path.join(RAIZ, PASTA, 'respostas_pendentes.json'), {
    force: true,
  });
  vi.resetModules();
  mod = await import('./revisao-humana.js');
});

afterEach(() => {
  delete process.env.REVISAO_HUMANA_FOLDERS;
  delete process.env.REVISAO_JID;
});

const pendente = () => ({
  chatJid: '5586999@s.whatsapp.net',
  partes: ['A avaliação é R$ 430,00.', 'Poderia me informar seu nome?'],
  intencao: 'preco_consulta',
  pergunta: 'quanto é a consulta?',
});

describe('quem aprova', () => {
  it('só o destino da revisão', () => {
    expect(mod.podeAprovar('120363000@g.us')).toBe(true);
    expect(mod.podeAprovar('5586999@s.whatsapp.net')).toBe(false);
  });

  // ⚠️ O default é a DM do Thiago, NÃO o grupo. Sem REVISAO_JID apontando para
  // o grupo, um "ok R7K2" mandado lá seria ignorado em silêncio: a recepção
  // acha que aprovou e o paciente não recebe nada.
  it('o destino vem do env, não do escalonamento', () => {
    expect(mod.destinoDaRevisao().jid).toBe('120363000@g.us');
  });
});

describe('fila de aprovação', () => {
  it('guarda as partes e devolve na aprovação, em ordem', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    expect(p.codigo).toMatch(/^[A-Z0-9]{4}$/);
    const a = mod.aprova(PASTA, p.codigo);
    expect(a?.partes).toEqual([
      'A avaliação é R$ 430,00.',
      'Poderia me informar seu nome?',
    ]);
    expect(a?.chatJid).toBe('5586999@s.whatsapp.net');
  });

  it('aprovar duas vezes não reenvia', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    expect(mod.aprova(PASTA, p.codigo)).toBeDefined();
    expect(mod.aprova(PASTA, p.codigo)).toBeUndefined();
  });

  it('código errado não derruba nada', () => {
    mod.registraParaRevisao(PASTA, pendente());
    expect(mod.aprova(PASTA, 'ZZZZ')).toBeUndefined();
    expect(mod.lePendentes(PASTA)).toHaveLength(1);
  });

  it('caixa do código não importa', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    expect(mod.aprova(PASTA, p.codigo.toLowerCase())).toBeDefined();
  });

  // Deploy reinicia o processo, e a revisão pode estar no meio. Se a pendência
  // morar só na memória, o paciente espera para sempre e ninguém sabe.
  it('sobrevive a reinício: está em arquivo', async () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    vi.resetModules();
    const outro = await import('./revisao-humana.js');
    expect(outro.lePendentes(PASTA).map((x) => x.codigo)).toEqual([p.codigo]);
  });
});

describe('a resposta não some entre aprovar e entregar (Codex, 19/10/2026)', () => {
  // A primeira versão removia da fila ANTES do envio. Reinício ou falha de rede
  // no meio apagava a única cópia: repetir "ok CODIGO" não recuperava nada, e o
  // paciente ficava sem a confirmação de uma consulta já marcada.
  it('aprovar NÃO remove: só `concluiEnvio` remove', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    expect(mod.aprova(PASTA, p.codigo)).toBeDefined();
    expect(mod.lePendentes(PASTA)).toHaveLength(1);
    mod.concluiEnvio(PASTA, p.codigo);
    expect(mod.lePendentes(PASTA)).toHaveLength(0);
  });

  it('aprovar duas vezes não manda duas vezes', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    expect(mod.aprova(PASTA, p.codigo)).toBeDefined();
    expect(mod.aprova(PASTA, p.codigo)).toBeUndefined();
  });

  it('envio que falha volta à fila e pode ser reaprovado', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    mod.aprova(PASTA, p.codigo);
    mod.devolveAFila(PASTA, p.codigo);
    expect(mod.aprova(PASTA, p.codigo)).toBeDefined();
  });

  it('sobrevive a reinício mesmo depois de aprovada', async () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    mod.aprova(PASTA, p.codigo);
    vi.resetModules();
    const outro = await import('./revisao-humana.js');
    expect(outro.lePendentes(PASTA).map((x) => x.codigo)).toEqual([p.codigo]);
  });
});

describe('a escada de cobrança', () => {
  const deps = () => {
    const enviadas: string[] = [];
    let alarmes = 0;
    return {
      enviadas,
      alarmes: () => alarmes,
      sendMessage: (_j: string, t: string) => void enviadas.push(t),
      tocaAlarme: () => {
        alarmes += 1;
      },
    };
  };

  it('nada nos primeiros minutos', async () => {
    mod.registraParaRevisao(PASTA, pendente());
    const d = deps();
    await mod.tickRevisaoSla(d, Date.now() + 60_000);
    expect(d.enviadas).toEqual([]);
  });

  it('cobra depois de 3 min, dizendo que o paciente está sem resposta', async () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    const d = deps();
    await mod.tickRevisaoSla(d, Date.now() + 4 * 60_000);
    expect(d.enviadas).toHaveLength(1);
    expect(d.enviadas[0]).toContain(p.codigo);
    expect(d.enviadas[0]).toContain('sem resposta');
  });

  it('cobra UMA vez, não a cada minuto', async () => {
    mod.registraParaRevisao(PASTA, pendente());
    const d = deps();
    const t = Date.now() + 4 * 60_000;
    await mod.tickRevisaoSla(d, t);
    await mod.tickRevisaoSla(d, t + 60_000);
    expect(d.enviadas).toHaveLength(1);
  });

  // Marcação já feita é urgente: esquecer deixa alguém com consulta na agenda
  // e sem saber. O alarme do escalonamento só toca em urgente.
  // ⚠️ `tocaAlarme` é await. Durante ele uma aprovação pode tirar A da fila e
  // uma resposta nova pode inserir B. Gravar o snapshot antigo ressuscitava A
  // (reenviando) ou apagava B (deixando outro paciente sem resposta).
  it('o que entra DURANTE o alarme não é apagado', async () => {
    const a = mod.registraParaRevisao(PASTA, { ...pendente(), jaMarcou: true });
    const d = deps();
    let b: string | undefined;
    const comInsercao = {
      ...d,
      tocaAlarme: () => {
        b = mod.registraParaRevisao(PASTA, pendente()).codigo;
      },
    };
    await mod.tickRevisaoSla(comInsercao, Date.now() + 6 * 60_000);
    const fila = mod.lePendentes(PASTA).map((x) => x.codigo);
    expect(fila).toContain(a.codigo);
    expect(fila).toContain(b);
  });

  it('o que SAI durante o alarme não ressuscita', async () => {
    const a = mod.registraParaRevisao(PASTA, { ...pendente(), jaMarcou: true });
    const d = deps();
    const comRemocao = {
      ...d,
      tocaAlarme: () => {
        mod.aprova(PASTA, a.codigo);
        mod.concluiEnvio(PASTA, a.codigo);
      },
    };
    await mod.tickRevisaoSla(comRemocao, Date.now() + 6 * 60_000);
    expect(mod.lePendentes(PASTA)).toHaveLength(0);
  });

  it('resposta com marcação feita toca alarme', async () => {
    mod.registraParaRevisao(PASTA, { ...pendente(), jaMarcou: true });
    const d = deps();
    await mod.tickRevisaoSla(d, Date.now() + 6 * 60_000);
    expect(d.alarmes()).toBe(1);
  });

  it('e avisa que o horário já está na agenda', () => {
    const p = mod.registraParaRevisao(PASTA, { ...pendente(), jaMarcou: true });
    expect(mod.textoDaRevisao(p)).toContain('JÁ ESTÁ na agenda');
  });

  // A propriedade central: nada sai sozinho. Se ninguém aprovar, o paciente
  // não recebe — nem depois de uma hora.
  it('NUNCA envia sozinha, por mais que demore', async () => {
    mod.registraParaRevisao(PASTA, pendente());
    const d = deps();
    await mod.tickRevisaoSla(d, Date.now() + 60 * 60_000);
    // Só cobrança e alarme saem, e só para o destino da revisão.
    expect(mod.lePendentes(PASTA)).toHaveLength(1);
  });
});

describe('a mensagem que o grupo recebe', () => {
  it('traz a pergunta, as partes numeradas e o código', () => {
    const p = mod.registraParaRevisao(PASTA, pendente());
    const t = mod.textoDaRevisao(p);
    expect(t).toContain('quanto é a consulta?');
    expect(t).toContain('*1.* A avaliação é R$ 430,00.');
    expect(t).toContain('*2.* Poderia me informar seu nome?');
    expect(t).toContain(`ok ${p.codigo}`);
  });
});
