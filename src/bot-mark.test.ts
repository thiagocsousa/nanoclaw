import { beforeEach, describe, expect, it } from 'vitest';

import {
  ASSISTANT_NAME,
  BOT_MARK,
  LEGACY_BOT_PREFIX,
  isBotText,
} from './config.js';
import {
  _initTestDatabase,
  getLastBotMessageTimestamp,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from './db.js';

// Contexto: quando o bot divide o número com o humano dono da conta, o echo do
// WhatsApp chega com fromMe=true para as DUAS metades da conversa (verificado
// no grupo de teste: paciente e agente ambos com is_from_me=1). A marca no
// texto é o único discriminador. Se ela falhar, o bot lê a própria resposta
// como mensagem nova e responde a si mesmo em loop — é esse o modo de falha
// que estes testes existem para travar.

const CHAT = '120363275085162068@g.us';

beforeEach(() => {
  _initTestDatabase();
});

describe('BOT_MARK', () => {
  it('é invisível e de largura zero — o paciente não pode ler a marca', () => {
    expect(BOT_MARK).toHaveLength(1);
    expect(BOT_MARK.codePointAt(0)).toBe(0x2063);
    // Não pode ser whitespace: trim() em qualquer camada apagaria a marca.
    expect(BOT_MARK.trim()).toBe(BOT_MARK);
    expect(/\s/.test(BOT_MARK)).toBe(false);
  });

  it('não deixa resto visível quando removida do começo do texto', () => {
    const enviado = `${BOT_MARK}bom dia, tudo bem?`;
    expect(enviado.slice(BOT_MARK.length)).toBe('bom dia, tudo bem?');
  });
});

describe('isBotText', () => {
  it('reconhece a marca atual', () => {
    expect(isBotText(`${BOT_MARK}tem vaga amanhã às 10h`)).toBe(true);
  });

  it('reconhece o prefixo visível antigo — o histórico no banco usa ele', () => {
    expect(isBotText(`${LEGACY_BOT_PREFIX} tem vaga amanhã`)).toBe(true);
    expect(LEGACY_BOT_PREFIX).toBe(`${ASSISTANT_NAME}:`);
  });

  it('não confunde mensagem de paciente com mensagem do bot', () => {
    for (const texto of [
      'Você tem vaga pra amanhã?',
      'Tem na terça ?',
      'quanto custa a consulta',
      '', // mensagem vazia
      'Lara: oi', // paciente citando o nome da agente
      `texto com a marca no meio${BOT_MARK}não no começo`,
    ]) {
      expect(isBotText(texto), texto).toBe(false);
    }
  });
});

describe('filtro de mensagens do bot no banco', () => {
  beforeEach(() => {
    storeChatMetadata(CHAT, '2026-10-04T12:00:00Z');
  });

  function store(id: string, content: string, timestamp: string) {
    storeMessage({
      id,
      chat_jid: CHAT,
      sender: CHAT,
      sender_name: 'teste',
      content,
      timestamp,
      // Pior caso de propósito: is_from_me=1 nas duas pontas (número
      // compartilhado) e is_bot_message ausente, para provar que o backstop de
      // conteúdo sozinho já segura o loop.
      is_from_me: true,
    });
  }

  it('não devolve ao agente a própria resposta marcada', () => {
    store('p1', 'Você tem vaga pra amanhã?', '2026-10-04T12:12:00Z');
    store('b1', `${BOT_MARK}tem sim, amanhã às 10h`, '2026-10-04T12:13:00Z');

    const pendentes = getMessagesSince(
      CHAT,
      '2026-10-04T12:00:00Z',
      ASSISTANT_NAME,
    );
    expect(pendentes.map((m) => m.id)).toEqual(['p1']);
  });

  it('também filtra o prefixo visível antigo', () => {
    store('b2', `${ASSISTANT_NAME}: resposta antiga`, '2026-10-04T12:13:00Z');
    store('p2', 'e na quarta?', '2026-10-04T12:14:00Z');

    const pendentes = getMessagesSince(
      CHAT,
      '2026-10-04T12:00:00Z',
      ASSISTANT_NAME,
    );
    expect(pendentes.map((m) => m.id)).toEqual(['p2']);
  });

  it('getLastBotMessageTimestamp acha a mensagem marcada com a marca nova', () => {
    store('p3', 'oi', '2026-10-04T12:10:00Z');
    store('b3', `${BOT_MARK}oi, tudo bem?`, '2026-10-04T12:11:00Z');

    expect(getLastBotMessageTimestamp(CHAT, ASSISTANT_NAME)).toBe(
      '2026-10-04T12:11:00Z',
    );
  });
});
