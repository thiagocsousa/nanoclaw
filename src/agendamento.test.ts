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

beforeEach(async () => {
  fs.mkdirSync(path.join(RAIZ, PASTA), { recursive: true });
  vi.resetModules();
  mod = await import('./agendamento.js');
});

afterEach(() => {
  fs.rmSync(path.join(RAIZ, PASTA, 'agendamentos_pendentes.json'), {
    force: true,
  });
});

const base = {
  operacao: 'marcar' as const,
  paciente: 'Joana Silva',
  pedidoPor: '5586999@s.whatsapp.net',
  data: '2026-10-06',
  hora: '09:20',
  perfil: 'particular-cirurgia',
};

describe('criaPedido', () => {
  it('cria com código de 4 caracteres sem ambiguidade', () => {
    const p = mod.criaPedido(PASTA, base);
    expect(p?.codigo).toMatch(/^[A-Z0-9]{4}$/);
    expect(p?.codigo).not.toMatch(/[O01ILS25Z]/);
    expect(mod.lePedidos(PASTA)).toHaveLength(1);
  });

  // Pedido pela metade na fila é pior que nenhum: alguém vai aprová-lo.
  it('NÃO cria sem paciente, data, hora ou perfil', () => {
    for (const k of ['paciente', 'data', 'hora', 'perfil'] as const) {
      expect(mod.criaPedido(PASTA, { ...base, [k]: '' }), k).toBeUndefined();
    }
    expect(mod.lePedidos(PASTA)).toHaveLength(0);
  });

  // Marcar é aditivo; remarcar e cancelar são destrutivos e escalam. A trava
  // está no código, não no prompt: um pedido desses na fila seria aprovável sem
  // ser executável.
  it('só aceita marcar; remarcar e cancelar não entram na fila', () => {
    for (const op of ['remarcar', 'cancelar']) {
      expect(
        mod.criaPedido(PASTA, {
          ...base,
          operacao: op as unknown as 'marcar',
        }),
        op,
      ).toBeUndefined();
    }
    expect(mod.lePedidos(PASTA)).toHaveLength(0);
  });

  it('códigos são únicos entre os pedidos abertos', () => {
    const cods = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const p = mod.criaPedido(PASTA, base);
      cods.add(p!.codigo);
    }
    expect(cods.size).toBe(15);
  });
});

// "ok" é baixa de escalonamento ("já cuidei"). Não pode, por acidente,
// escrever na agenda da médica.
describe('os comandos não se confundem', () => {
  it('confirmar/efetivar/marcar são confirmação', () => {
    for (const t of ['confirmar AB12', 'efetivar ab12', 'marcar AB12']) {
      expect(mod.comandoDeConfirmacao(t), t).toBe('AB12');
    }
  });

  it('"ok CODE" NÃO é confirmação de agendamento', () => {
    for (const t of ['ok AB12', 'okay AB12', 'baixa AB12', 'feito AB12']) {
      expect(mod.comandoDeConfirmacao(t), t).toBeUndefined();
    }
  });

  it('recusar/descartar tiram da fila', () => {
    for (const t of ['recusar AB12', 'descartar ab12', 'não AB12']) {
      expect(mod.comandoDeRecusa(t), t).toBe('AB12');
    }
  });

  it('texto solto não vira comando', () => {
    for (const t of [
      'confirmar',
      'vou confirmar AB12',
      'AB12',
      'confirmar o horário de amanhã',
    ]) {
      expect(mod.comandoDeConfirmacao(t), t).toBeUndefined();
    }
  });
});

describe('achaPedido e removePedido', () => {
  it('acha pelo código e remove', () => {
    const p = mod.criaPedido(PASTA, base)!;
    expect(mod.achaPedido(PASTA, p.codigo)?.paciente).toBe('Joana Silva');
    expect(mod.removePedido(PASTA, p.codigo)).toBe(true);
    expect(mod.achaPedido(PASTA, p.codigo)).toBeUndefined();
  });

  it('código inexistente não acha nem remove', () => {
    expect(mod.achaPedido(PASTA, 'XXXX')).toBeUndefined();
    expect(mod.removePedido(PASTA, 'XXXX')).toBe(false);
  });
});

describe('o aviso tem o que quem aprova precisa conferir', () => {
  it('traz paciente, data legível, hora e os dois comandos', () => {
    const p = mod.criaPedido(PASTA, {
      ...base,
      nascimento: '10/03/1980',
      convenio: 'particular',
    })!;
    const a = mod.avisoDoPedido(p);
    expect(a).toContain('MARCAR');
    expect(a).toContain('Joana Silva');
    expect(a).toContain('10/03/1980');
    expect(a).toContain('06/10/2026 às 09:20');
    expect(a).toContain(`confirmar ${p.codigo}`);
    expect(a).toContain(`recusar ${p.codigo}`);
    expect(a).toContain('Nada é escrito até você confirmar');
  });

  it('omite linha de campo ausente, em vez de mostrar vazio', () => {
    const p = mod.criaPedido(PASTA, base)!;
    const a = mod.avisoDoPedido(p);
    expect(a).not.toContain('Nascimento:');
    expect(a).not.toMatch(/\n\n\n/);
  });
});

// Adivinhar o formato de uma requisição que mexe em agenda médica pode criar um
// evento errado que ninguém sabe desfazer.
describe('efetiva', () => {
  it('lança enquanto o endpoint do iClinic não for descoberto', async () => {
    const p = mod.criaPedido(PASTA, base)!;
    await expect(mod.efetiva(p)).rejects.toThrow(/não descoberto/);
  });
});
