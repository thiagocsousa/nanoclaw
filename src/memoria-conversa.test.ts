import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'memconv-'));
const PASTA = 'whatsapp_memconv-teste';
const JID = '5586999990000@s.whatsapp.net';

vi.mock('./config.js', async (orig) => ({
  ...(await orig<typeof import('./config.js')>()),
  GROUPS_DIR: RAIZ,
}));

const { abreConversa, conversaAbertaEm } =
  await import('./memoria-conversa.js');

const H = 3600_000;

function gravaSlots(abertaEm: number, quando: number) {
  fs.mkdirSync(path.join(RAIZ, PASTA), { recursive: true });
  fs.writeFileSync(
    path.join(RAIZ, PASTA, 'slots_conversa.json'),
    JSON.stringify({ [JID]: { abertaEm, quando, convenio: 'particular' } }),
  );
}

beforeEach(() => {
  // ⚠️ Apaga o ARQUIVO, não a pasta. `grava` engole a falha de escrita quando o
  // diretório do grupo não existe, então apagar a pasta fazia o teste medir o
  // silêncio do `catch` em vez da regra. Em produção a pasta sempre existe.
  fs.mkdirSync(path.join(RAIZ, PASTA), { recursive: true });
  fs.rmSync(path.join(RAIZ, PASTA, 'slots_conversa.json'), { force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * ⛔ A trava do erro de 22/10/2026. A validade dos slots e o prazo de "esta
 * pessoa ainda está falando comigo" chegaram no mesmo dia e eu usei UM prazo
 * para os dois. Apertar para uma hora servia ao expediente e cobrava do
 * paciente: quem responde 70 minutos depois perdia o convênio lembrado e,
 * pior, os CANDIDATOS da oferta em curso — a Lara oferece três horários às 10h
 * e o "2" das 11h10 não resolve mais.
 *
 * Mesmo dado, duas perguntas. O parâmetro é o que as mantém separadas.
 */
describe('conversaAbertaEm respeita a validade de quem pergunta', () => {
  const abertura = Date.parse('2026-10-20T13:00:00.000Z');
  const agora = abertura + 90 * 60 * 1000; // 1h30 depois

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(agora);
    // Última atividade na abertura: 1h30 de silêncio até agora.
    gravaSlots(abertura, abertura);
  });

  it('com a validade dos slots (4h), 1h30 de silêncio ainda lembra', () => {
    expect(conversaAbertaEm(PASTA, JID)).toBe(abertura);
  });

  it('com o prazo do expediente (1h), 1h30 de silêncio já não conta', () => {
    expect(conversaAbertaEm(PASTA, JID, 1 * H)).toBeUndefined();
  });

  it('dentro dos dois prazos, os dois lembram', () => {
    vi.setSystemTime(abertura + 30 * 60 * 1000);
    expect(conversaAbertaEm(PASTA, JID)).toBe(abertura);
    expect(conversaAbertaEm(PASTA, JID, 1 * H)).toBe(abertura);
  });

  it('além dos dois prazos, nenhum lembra', () => {
    vi.setSystemTime(abertura + 5 * H);
    expect(conversaAbertaEm(PASTA, JID)).toBeUndefined();
    expect(conversaAbertaEm(PASTA, JID, 1 * H)).toBeUndefined();
  });
});

describe('abreConversa', () => {
  it('não remarca a abertura de uma conversa viva', () => {
    const abertura = Date.parse('2026-10-20T13:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(abertura);
    expect(abreConversa(PASTA, JID, abertura)).toBe(abertura);
    // ⛔ É isto que faz a conversa das 17h55 seguir sendo atendida às 18h20 em
    // vez de virar "aberta às 18h20" e cair no corte das 18h.
    const depois = abertura + 30 * 60 * 1000;
    vi.setSystemTime(depois);
    expect(abreConversa(PASTA, JID, depois)).toBe(abertura);
  });

  it('recomeça depois da validade', () => {
    const abertura = Date.parse('2026-10-20T13:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(abertura);
    abreConversa(PASTA, JID, abertura);
    const amanha = abertura + 20 * H;
    vi.setSystemTime(amanha);
    expect(abreConversa(PASTA, JID, amanha)).toBe(amanha);
  });
});
