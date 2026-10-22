import { describe, expect, it } from 'vitest';

import { BOT_MARK } from './config.js';
import {
  type EventoSla,
  cursorDepoisDeSemear,
  mensagensDoHistorico,
} from './semear-historico.js';

const JID = '559981716163@s.whatsapp.net';
const OUTRO = '558699572370@s.whatsapp.net';
const LIMITE = {
  maximo: 50,
  desde: '2026-09-22T00:00:00.000Z',
  ate: '2026-11-01T00:00:00.000Z',
};

function ev(p: Partial<EventoSla>): EventoSla {
  return {
    id: 'ID1',
    jid: JID,
    direction: 'in',
    text: 'oi',
    timestamp: '2026-10-20T13:00:00.000Z',
    push_name: 'Paciente',
    ...p,
  };
}

describe('mensagensDoHistorico', () => {
  it('converte o evento preservando o id, que é o que dá idempotência', () => {
    // ⚠️ Conferido contra a VM em 22/10/2026: o `id` do log de SLA é o MESMO
    // `key.id` que a captura grava. Sem isso, `INSERT OR REPLACE` duplicaria a
    // conversa inteira a cada execução em vez de ser idempotente.
    const [m] = mensagensDoHistorico([ev({ id: 'AC080B04' })], JID, LIMITE);
    expect(m.id).toBe('AC080B04');
    expect(m.chat_jid).toBe(JID);
  });

  it('separa os dois lados pela direção', () => {
    const ms = mensagensDoHistorico(
      [
        ev({ id: 'A', direction: 'in', timestamp: '2026-10-20T13:00:00Z' }),
        ev({ id: 'B', direction: 'out', timestamp: '2026-10-20T13:01:00Z' }),
      ],
      JID,
      LIMITE,
    );
    expect(ms.map((m) => m.is_from_me)).toEqual([false, true]);
    expect(ms[1].sender).toBe('clinica');
  });

  /**
   * ⛔ Parte das mensagens `out` do log são da própria Lara — os "Só um
   * instante." que saíram antes da observação. Gravá-las como humanas faria o
   * histórico atribuir à secretária uma fala do bot.
   */
  it('reconhece a fala do BOT pela marca invisível', () => {
    const ms = mensagensDoHistorico(
      [
        ev({ id: 'A', direction: 'out', text: `${BOT_MARK}Só um instante.` }),
        ev({ id: 'B', direction: 'out', text: 'Bom dia, Dona Ana' }),
      ],
      JID,
      LIMITE,
    );
    expect(ms.find((m) => m.id === 'A')!.is_bot_message).toBe(true);
    expect(ms.find((m) => m.id === 'B')!.is_bot_message).toBe(false);
  });

  it('só a conversa pedida', () => {
    const ms = mensagensDoHistorico(
      [ev({ id: 'A' }), ev({ id: 'B', jid: OUTRO })],
      JID,
      LIMITE,
    );
    expect(ms.map((m) => m.id)).toEqual(['A']);
  });

  it('ordena do mais antigo ao mais novo', () => {
    const ms = mensagensDoHistorico(
      [
        ev({ id: 'B', timestamp: '2026-10-20T13:05:00Z' }),
        ev({ id: 'A', timestamp: '2026-10-20T13:00:00Z' }),
      ],
      JID,
      LIMITE,
    );
    expect(ms.map((m) => m.id)).toEqual(['A', 'B']);
  });

  // ⚠️ Os MAIS RECENTES. Numa conversa de 150 eventos, o que explica "tem algum
  // retorno?" é o fim, não o começo.
  it('o teto corta pelo começo, não pelo fim', () => {
    const eventos = Array.from({ length: 10 }, (_, i) =>
      ev({ id: `E${i}`, timestamp: `2026-10-20T13:0${i}:00Z` }),
    );
    const ms = mensagensDoHistorico(eventos, JID, { ...LIMITE, maximo: 3 });
    expect(ms.map((m) => m.id)).toEqual(['E7', 'E8', 'E9']);
  });

  it('descarta o que é mais velho que a janela', () => {
    const ms = mensagensDoHistorico(
      [
        ev({ id: 'VELHO', timestamp: '2026-08-01T10:00:00Z' }),
        ev({ id: 'NOVO', timestamp: '2026-10-20T10:00:00Z' }),
      ],
      JID,
      LIMITE,
    );
    expect(ms.map((m) => m.id)).toEqual(['NOVO']);
  });

  /**
   * ⛔ A mensagem que DESCOBRE a DM já está no log (o SLA grava o mesmo lote).
   * Sem o teto ela entraria no histórico, o cursor ficaria igual ao timestamp
   * dela, e `getNewMessages` — que filtra `timestamp > ?` — a excluiria. O
   * paciente seria visto e não respondido, em silêncio.
   */
  it('NÃO semeia a mensagem que descobriu a DM', () => {
    const agora = '2026-10-22T12:15:51.000Z';
    const ms = mensagensDoHistorico(
      [
        ev({ id: 'ANTES', timestamp: '2026-10-21T17:20:00.000Z' }),
        ev({ id: 'ATUAL', timestamp: agora }),
      ],
      JID,
      { ...LIMITE, ate: agora },
    );
    expect(ms.map((m) => m.id)).toEqual(['ANTES']);
  });

  it('ignora evento sem id, sem texto ou com texto vazio', () => {
    const ms = mensagensDoHistorico(
      [
        ev({ id: undefined }),
        ev({ id: 'B', text: '' }),
        ev({ id: 'C', text: '   ' }),
        ev({ id: 'D' }),
      ],
      JID,
      LIMITE,
    );
    expect(ms.map((m) => m.id)).toEqual(['D']);
  });
});

describe('cursorDepoisDeSemear', () => {
  /**
   * ⛔ A trava que impede o host de achar que o histórico é novidade e
   * RESPONDER a conversa inteira. Em observação encheria a fila de lixo; com a
   * Lara assumindo, iria ao paciente.
   */
  it('é o timestamp da ÚLTIMA mensagem semeada', () => {
    const ms = mensagensDoHistorico(
      [
        ev({ id: 'A', timestamp: '2026-10-20T13:00:00Z' }),
        ev({ id: 'B', timestamp: '2026-10-21T09:00:00Z' }),
      ],
      JID,
      LIMITE,
    );
    expect(cursorDepoisDeSemear(ms)).toBe('2026-10-21T09:00:00Z');
  });

  // Sem nada semeado, quem chama NÃO deve mexer no cursor: o piso de
  // descoberta da DM já é o valor certo.
  it('sem histórico, não manda mexer no cursor', () => {
    expect(cursorDepoisDeSemear([])).toBeUndefined();
  });
});
