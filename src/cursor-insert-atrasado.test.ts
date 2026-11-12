import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getNewMessages,
  rowidDoTimestamp,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { primeiraVez } from './janela-de-ids.js';

/**
 * ⛔ O INSERT ATRASADO, que custou cinco dias de turnos perdidos.
 *
 * Em 12/11/2026, reconstruído do banco de produção:
 *
 *     17673 | 2026-11-12T03:37:00 | DM     ← inserido ANTES
 *     17676 | 2026-11-11T20:21:55 | GRUPO  ← inserido DEPOIS, 7h mais velho
 *     17682 | 2026-11-11T21:42:13 | GRUPO  ← "@Andy 1,2,3", a aprovação da NF-e
 *
 * A fila offline do grupo do atendimento só entrou no banco quando a sessão
 * ressincronizou, de madrugada. Nesse instante o cursor GLOBAL já tinha
 * avançado para 03:37, por causa das DMs que chegaram ao vivo. Com
 * `timestamp > cursor`, as 11 mensagens do grupo ficaram invisíveis para
 * sempre: a aprovação nunca virou turno, o grupo não teve turno nenhum entre
 * 07/11 e 12/11, e não houve um único erro no log.
 *
 * O cursor ser global é o que torna o timestamp fatal — basta OUTRA conversa
 * receber algo mais novo para enterrar o insert atrasado desta.
 */

function store(m: {
  id: string;
  chat_jid: string;
  content: string;
  timestamp: string;
}) {
  storeMessage({
    id: m.id,
    chat_jid: m.chat_jid,
    sender: 'alguem@s.whatsapp.net',
    sender_name: 'Alguém',
    content: m.content,
    timestamp: m.timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
}

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata('grupo@g.us', '2026-11-11T00:00:00.000Z');
  storeChatMetadata('paciente@s.whatsapp.net', '2026-11-11T00:00:00.000Z');
});

describe('insert atrasado de uma conversa não é enterrado por outra', () => {
  it('a aprovação do grupo é vista mesmo chegando depois da DM mais nova', () => {
    // 1. A DM ao vivo, de madrugada, entra primeiro.
    store({
      id: 'dm-1',
      chat_jid: 'paciente@s.whatsapp.net',
      content: 'oi, bom dia',
      timestamp: '2026-11-12T03:37:00.000Z',
    });

    const jids = ['grupo@g.us', 'paciente@s.whatsapp.net'];
    const passada1 = getNewMessages(jids, '0', 'Andy');
    expect(passada1.messages.map((m) => m.id)).toEqual(['dm-1']);

    // 2. Só AGORA a fila offline do grupo desce, com timestamp de ontem.
    store({
      id: 'grupo-aprovacao',
      chat_jid: 'grupo@g.us',
      content: '@Andy 1,2,3',
      timestamp: '2026-11-11T21:42:13.000Z',
    });

    // 3. O cursor avançou na passada 1. Com timestamp, esta mensagem estaria
    //    perdida; com rowid, ela aparece.
    const passada2 = getNewMessages(jids, passada1.newRowid, 'Andy');
    expect(passada2.messages.map((m) => m.id)).toEqual(['grupo-aprovacao']);
    expect(passada2.messages[0].content).toBe('@Andy 1,2,3');
  });

  it('o cursor avança e não reentrega o que já foi visto', () => {
    store({
      id: 'a',
      chat_jid: 'grupo@g.us',
      content: 'primeira',
      timestamp: '2026-11-11T10:00:00.000Z',
    });
    const p1 = getNewMessages(['grupo@g.us'], '0', 'Andy');
    expect(p1.messages).toHaveLength(1);

    const p2 = getNewMessages(['grupo@g.us'], p1.newRowid, 'Andy');
    expect(p2.messages).toHaveLength(0);
    expect(p2.newRowid).toBe(p1.newRowid);
  });
});

describe('reentrega da mesma mensagem não vira turno duplicado', () => {
  /**
   * ⚠️ A outra metade do conserto. `INSERT OR REPLACE` dá rowid NOVO à mesma
   * mensagem, e o baileys reentrega a mesma mensagem 8 a 12 vezes (medido no
   * espelho cru em 07/11/2026). Com cursor de rowid e sem dedup, cada
   * reentrega viraria um turno. Antes o timestamp protegia disso por acidente;
   * agora a proteção é explícita, no `startMessageLoop`.
   */
  it('o mesmo id reinserido ganha rowid novo — e a dedup o segura', () => {
    store({
      id: 'repetida',
      chat_jid: 'grupo@g.us',
      content: '@Andy 1,2,3',
      timestamp: '2026-11-11T21:42:13.000Z',
    });
    const p1 = getNewMessages(['grupo@g.us'], '0', 'Andy');
    const rowid1 = p1.messages[0].rowid;

    // Reentrega: mesmo id, mesmo chat.
    store({
      id: 'repetida',
      chat_jid: 'grupo@g.us',
      content: '@Andy 1,2,3',
      timestamp: '2026-11-11T21:42:13.000Z',
    });
    const p2 = getNewMessages(['grupo@g.us'], p1.newRowid, 'Andy');

    // O rowid MUDOU, então o cursor sozinho a devolve de novo.
    expect(p2.messages).toHaveLength(1);
    expect(p2.messages[0].rowid).not.toBe(rowid1);

    // É a dedup por id que impede o turno duplicado.
    const vistos = new Set<string>();
    const despachadas1 = p1.messages.filter((m) =>
      primeiraVez(vistos, m.id, 100),
    );
    const despachadas2 = p2.messages.filter((m) =>
      primeiraVez(vistos, m.id, 100),
    );
    expect(despachadas1).toHaveLength(1);
    expect(despachadas2).toHaveLength(0);
  });
});

describe('rowidDoTimestamp: a migração não reprocessa o banco', () => {
  it('converte o cursor antigo para o rowid equivalente', () => {
    store({
      id: 'velha',
      chat_jid: 'grupo@g.us',
      content: 'antes do corte',
      timestamp: '2026-11-10T10:00:00.000Z',
    });
    store({
      id: 'nova',
      chat_jid: 'grupo@g.us',
      content: 'depois do corte',
      timestamp: '2026-11-11T10:00:00.000Z',
    });

    const cursor = rowidDoTimestamp('2026-11-10T23:59:59.000Z');
    const { messages } = getNewMessages(['grupo@g.us'], cursor, 'Andy');
    expect(messages.map((m) => m.id)).toEqual(['nova']);
  });

  it('banco vazio devolve 0, e aí tudo é novo', () => {
    expect(rowidDoTimestamp('2026-11-10T00:00:00.000Z')).toBe('0');
  });
});
