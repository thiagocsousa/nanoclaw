import { beforeEach, describe, expect, it, vi } from 'vitest';

let mod: typeof import('./expediente.js');

beforeEach(async () => {
  process.env.EXPEDIENTE_FOLDERS = 'whatsapp_atendimento-teste';
  process.env.EXPEDIENTE_TZ = 'America/Fortaleza';
  vi.resetModules();
  mod = await import('./expediente.js');
});

/** Teresina é UTC-3 o ano todo. 2026-10-20 é uma terça. */
const emTeresina = (iso: string) => new Date(`${iso}-03:00`);

// 7h30 às 18h30 desde 19/10/2026. O fim acompanha a janela de consultório da
// QUARTA, que vai até 18:30 — antes disso a clínica ficava aberta e a Lara
// muda.
describe('7h30 às 18h30, segunda a sexta', () => {
  it.each([
    ['2026-10-20T07:30:00', true, 'terça, abrindo no minuto'],
    ['2026-10-20T07:29:00', false, 'terça, um minuto antes'],
    ['2026-10-20T12:30:00', true, 'terça, meio-dia'],
    ['2026-10-20T18:00:00', true, 'terça, 18h ainda atende'],
    ['2026-10-20T18:29:00', true, 'terça, último minuto'],
    ['2026-10-20T18:30:00', false, 'terça, 18h30 em ponto já fechou'],
    ['2026-10-20T23:00:00', false, 'terça, madrugada'],
    ['2026-10-17T10:00:00', false, 'SÁBADO, mesmo em horário comercial'],
    ['2026-10-18T10:00:00', false, 'domingo'],
    ['2026-10-19T07:45:00', true, 'segunda, antes das 8h'],
    ['2026-10-21T18:15:00', true, 'QUARTA às 18h15, com consultório aberto'],
    ['2026-10-23T17:00:00', true, 'sexta'],
  ])('%s -> %s (%s)', (iso, esperado) => {
    expect(mod.dentroDoExpediente(emTeresina(iso))).toBe(esperado);
  });

  it('o texto do horário acompanha a configuração', () => {
    expect(mod.textoDoExpediente()).toBe('7h30 às 18h30, de segunda a sexta');
  });
});

describe('quem começou antes das 18h continua', () => {
  // A regra que não é óbvia: o corte é no INÍCIO da conversa. Quem está no
  // meio da triagem às 17h55 não pode levar silêncio às 18h01.
  it('conversa aberta 18h25 segue sendo atendida às 19h', () => {
    const abriu = emTeresina('2026-10-20T18:25:00').getTime();
    expect(mod.podeResponder(abriu, emTeresina('2026-10-20T19:00:00'))).toBe(
      true,
    );
  });

  it('e até às 21h, se a conversa ainda estiver viva', () => {
    const abriu = emTeresina('2026-10-20T18:25:00').getTime();
    expect(mod.podeResponder(abriu, emTeresina('2026-10-20T21:00:00'))).toBe(
      true,
    );
  });

  // O outro lado: quem CHEGA fora do horário não é atendido, e quem responde é
  // a mensagem de ausência do WhatsApp Business.
  it('conversa NOVA às 20h não é atendida', () => {
    expect(
      mod.podeResponder(undefined, emTeresina('2026-10-20T20:00:00')),
    ).toBe(false);
  });

  it('conversa aberta às 20h não vira passe livre', () => {
    const abriu = emTeresina('2026-10-20T20:00:00').getTime();
    expect(mod.podeResponder(abriu, emTeresina('2026-10-20T20:30:00'))).toBe(
      false,
    );
  });

  it('no sábado nem continuação existe', () => {
    const abriu = emTeresina('2026-10-17T10:00:00').getTime();
    expect(mod.podeResponder(abriu, emTeresina('2026-10-17T11:00:00'))).toBe(
      false,
    );
  });

  it('dentro do horário responde mesmo sem conversa aberta', () => {
    expect(
      mod.podeResponder(undefined, emTeresina('2026-10-20T09:00:00')),
    ).toBe(true);
  });
});

describe('ligado por pasta', () => {
  it('só a pasta listada', () => {
    expect(mod.wantsExpediente('whatsapp_atendimento-teste')).toBe(true);
    expect(mod.wantsExpediente('whatsapp_marina')).toBe(false);
    expect(mod.wantsExpediente(undefined)).toBe(false);
  });
});

describe('o formato do horário vem do .env', () => {
  // Hora cheia era o formato até 19/10/2026 ("8"/"18"). Aceitar os dois evita
  // que um .env antigo mude o horário sem ninguém pedir.
  it.each([
    ['7:30', '18:30'],
    ['7h30', '18h30'],
    ['8', '18'],
  ])('aceita %s / %s', async (ini, fim) => {
    process.env.EXPEDIENTE_INICIO = ini;
    process.env.EXPEDIENTE_FIM = fim;
    vi.resetModules();
    const m = await import('./expediente.js');
    const dentro = ini.startsWith('8')
      ? '2026-10-20T08:30:00'
      : '2026-10-20T07:45:00';
    expect(m.dentroDoExpediente(emTeresina(dentro))).toBe(true);
    delete process.env.EXPEDIENTE_INICIO;
    delete process.env.EXPEDIENTE_FIM;
  });

  it('valor inválido cai no padrão em vez de abrir 24h', async () => {
    process.env.EXPEDIENTE_INICIO = 'oito';
    process.env.EXPEDIENTE_FIM = '99:99';
    vi.resetModules();
    const m = await import('./expediente.js');
    expect(m.dentroDoExpediente(emTeresina('2026-10-20T03:00:00'))).toBe(false);
    expect(m.dentroDoExpediente(emTeresina('2026-10-20T10:00:00'))).toBe(true);
    delete process.env.EXPEDIENTE_INICIO;
    delete process.env.EXPEDIENTE_FIM;
  });
});
