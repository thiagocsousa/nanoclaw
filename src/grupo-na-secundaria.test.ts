import { describe, expect, it } from 'vitest';

import { BOT_MARK } from './config.js';
import {
  guardaNaSecundaria,
  marcaDeBotNaSecundaria,
} from './channels/whatsapp.js';

// CONTEXTO, 16/11/2026. A clínica mandou "@Andy emitir as notas" no grupo
// *Atendimento Dra Marina* e nada aconteceu. A investigação na VM mostrou:
//
//   - a mensagem CHEGOU: o 1911 gravou sender-key do grupo às 13:50;
//   - o 2111 — único que armazenava grupo — não viu nada do grupo o dia todo,
//     embora a CONTA recebesse normalmente no celular (o dispositivo vinculado
//     do bot é que estava defasado);
//   - o 1911 é outbound-only e dava `return` antes de gravar.
//
// Ou seja: a mensagem chegou íntegra na VM e foi descartada por desenho. O
// grupo dependia de UMA conta conseguir decifrá-lo. Estes testes cobrem as
// duas decisões da correção, e cada um deles corresponde a um jeito concreto
// de a correção falhar.
describe('gravação de grupo pela instância secundária', () => {
  // ⛔ O teste que protege o paciente. Se este cair, o agente pode passar a
  // tratar DM de paciente como turno — exatamente o que o modo outbound-only
  // existe para impedir.
  it('NUNCA grava DM, nem registrada', () => {
    expect(
      guardaNaSecundaria({
        chatJid: '558893077811@s.whatsapp.net',
        registrado: true,
      }),
    ).toBe(false);
  });

  it('grava grupo registrado', () => {
    expect(
      guardaNaSecundaria({
        chatJid: '120363287717747603@g.us',
        registrado: true,
      }),
    ).toBe(true);
  });

  it('não grava grupo que não está registrado', () => {
    expect(
      guardaNaSecundaria({
        chatJid: '558699070915-1442714609@g.us',
        registrado: false,
      }),
    ).toBe(false);
  });

  // ⚠️ O teste que impede a correção de ser inútil em silêncio.
  //
  // No celular da clínica TUDO sai com fromMe=true: tanto o que o pipeline
  // publica quanto o que uma pessoa digita. Se `is_bot_message` saísse de
  // `fromMe`, a mensagem entraria no banco e o `getNewMessages` — que filtra
  // `is_bot_message = 0` — a descartaria. O sintoma seria o MESMO de hoje:
  // mensagem no grupo, nada acontece. Só que agora com a correção aplicada.
  it('mensagem digitada por gente na clínica NÃO é marcada como bot', () => {
    expect(
      marcaDeBotNaSecundaria({
        content: '@Andy emitir as notas pendentes',
        enviadoPorNos: false,
      }),
    ).toBe(false);
  });

  it('texto com a marca do bot É marcado como bot', () => {
    expect(
      marcaDeBotNaSecundaria({
        content: `${BOT_MARK}✅ 3 nota(s) emitida(s)`,
        enviadoPorNos: false,
      }),
    ).toBe(true);
  });

  it('o que nós mesmos enviamos é marcado como bot', () => {
    expect(
      marcaDeBotNaSecundaria({
        content: 'Notas fiscais pendentes',
        enviadoPorNos: true,
      }),
    ).toBe(true);
  });
});
