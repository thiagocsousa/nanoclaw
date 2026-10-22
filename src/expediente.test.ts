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

describe('três faixas: antes das 18h, a meia hora final, e depois das 18h30', () => {
  /**
   * ⛔ A regra ANTERIOR era o contrário: conversa aberta dentro do expediente
   * seguia sendo atendida depois das 18h30, "até encerrar ou escalar". Caiu em
   * 22/10/2026, quando apareceu na fila uma resposta às 19h53 — um comprovante
   * de pagamento que chegou de noite numa conversa aberta às 10h24. A exceção
   * não tinha fim de dia: o que fechava a janela era a validade da memória da
   * conversa, renovada a cada turno.
   *
   * Agora `abertaEm` é restrição, não licença.
   */
  const as = (iso: string) => emTeresina(iso).getTime();

  it('antes das 18h atende todos, com ou sem conversa aberta', () => {
    expect(
      mod.podeResponder(undefined, emTeresina('2026-10-20T09:00:00')),
    ).toBe(true);
    expect(
      mod.podeResponder(
        as('2026-10-20T08:00:00'),
        emTeresina('2026-10-20T17:59:00'),
      ),
    ).toBe(true);
  });

  it('na meia hora final atende quem começou ANTES das 18h', () => {
    expect(
      mod.podeResponder(
        as('2026-10-20T17:55:00'),
        emTeresina('2026-10-20T18:20:00'),
      ),
    ).toBe(true);
  });

  // ⛔ O pedido explícito do Thiago: a meia hora final é para TERMINAR conversa,
  // não para começar.
  it('NÃO atende quem começou depois das 18h, mesmo antes das 18h30', () => {
    expect(
      mod.podeResponder(
        as('2026-10-20T18:05:00'),
        emTeresina('2026-10-20T18:20:00'),
      ),
    ).toBe(false);
  });

  it('NÃO atende quem chega às 18h05 sem conversa aberta', () => {
    expect(
      mod.podeResponder(undefined, emTeresina('2026-10-20T18:05:00')),
    ).toBe(false);
  });

  it('às 18h em ponto já não se começa conversa', () => {
    expect(
      mod.podeResponder(undefined, emTeresina('2026-10-20T18:00:00')),
    ).toBe(false);
    expect(mod.podeComecar(emTeresina('2026-10-20T17:59:00'))).toBe(true);
    expect(mod.podeComecar(emTeresina('2026-10-20T18:00:00'))).toBe(false);
  });

  // ⛔ O teto duro. Era aqui que a regra antiga vazava.
  it.each([
    ['2026-10-20T18:30:00', '18h30 em ponto'],
    ['2026-10-20T19:53:00', 'o caso real que derrubou a exceção'],
    ['2026-10-20T23:00:00', 'madrugada'],
    ['2026-10-21T03:00:00', 'o dia seguinte de madrugada'],
  ])('depois das 18h30 NÃO atende ninguém (%s: %s)', (iso) => {
    expect(mod.podeResponder(as('2026-10-20T10:24:00'), emTeresina(iso))).toBe(
      false,
    );
  });

  it('no sábado nem conversa aberta é atendida', () => {
    expect(
      mod.podeResponder(
        as('2026-10-17T10:00:00'),
        emTeresina('2026-10-17T11:00:00'),
      ),
    ).toBe(false);
  });

  it('o corte de novas conversas vem do .env', async () => {
    process.env.EXPEDIENTE_ULTIMO_INICIO = '17:00';
    vi.resetModules();
    const m2 = await import('./expediente.js');
    expect(m2.podeComecar(emTeresina('2026-10-20T17:30:00'))).toBe(false);
    expect(
      m2.podeResponder(
        as('2026-10-20T16:00:00'),
        emTeresina('2026-10-20T17:30:00'),
      ),
    ).toBe(true);
    delete process.env.EXPEDIENTE_ULTIMO_INICIO;
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
