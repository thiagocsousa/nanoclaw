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

describe('8h às 18h, segunda a sexta', () => {
  it.each([
    ['2026-10-20T08:00:00', true, 'terça, abrindo'],
    ['2026-10-20T12:30:00', true, 'terça, meio-dia'],
    ['2026-10-20T17:59:00', true, 'terça, último minuto'],
    ['2026-10-20T18:00:00', false, 'terça, 18h em ponto já fechou'],
    ['2026-10-20T07:59:00', false, 'terça, antes de abrir'],
    ['2026-10-20T23:00:00', false, 'terça, madrugada'],
    ['2026-10-17T10:00:00', false, 'SÁBADO, mesmo em horário comercial'],
    ['2026-10-18T10:00:00', false, 'domingo'],
    ['2026-10-19T08:00:00', true, 'segunda'],
    ['2026-10-23T17:00:00', true, 'sexta'],
  ])('%s -> %s (%s)', (iso, esperado) => {
    expect(mod.dentroDoExpediente(emTeresina(iso))).toBe(esperado);
  });
});

describe('quem começou antes das 18h continua', () => {
  // A regra que não é óbvia: o corte é no INÍCIO da conversa. Quem está no
  // meio da triagem às 17h55 não pode levar silêncio às 18h01.
  it('conversa aberta 17h55 segue sendo atendida às 18h30', () => {
    const abriu = emTeresina('2026-10-20T17:55:00').getTime();
    expect(mod.podeResponder(abriu, emTeresina('2026-10-20T18:30:00'))).toBe(
      true,
    );
  });

  it('e até às 21h, se a conversa ainda estiver viva', () => {
    const abriu = emTeresina('2026-10-20T17:55:00').getTime();
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
