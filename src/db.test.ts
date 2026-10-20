import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  storeChatMetadata,
  storeMessageDirect,
  getTaskById,
  setRegisteredGroup,
  idCurto,
  mensagemPorIdCurto,
  storeMessage,
  ultimaMensagemDoPaciente,
  updateTask,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// O bug que escalou o "2" no primeiro teste real: o agente nunca via as falas
// da própria Lara, então uma escolha de menu chegava sem o menu à vista — e
// DESCONHECIDO passava a ser a classificação CORRETA para o que ele viu.
describe('getMessagesSince: incluirBot', () => {
  it('por padrão esconde as mensagens do bot', () => {
    const jid = 'teste-bot@g.us';
    storeChatMetadata(jid, '2026-10-05T09:00:00Z', jid);
    storeMessageDirect({
      id: 'm1',
      chat_jid: jid,
      sender: '55@s',
      sender_name: 'Paciente',
      content: 'Oi',
      timestamp: '2026-10-05T10:00:00Z',
      is_from_me: false,
    });
    storeMessageDirect({
      id: 'm2',
      chat_jid: jid,
      sender: 'bot',
      sender_name: 'Lara',
      content: 'Escolha uma opção: 1, 2 ou 3',
      timestamp: '2026-10-05T10:00:05Z',
      is_from_me: true,
      is_bot_message: true,
    });
    const r = getMessagesSince(jid, '2026-10-05T09:00:00Z', 'Claw');
    expect(r.map((m) => m.content)).toEqual(['Oi']);
  });

  it('com incluirBot, a escolha de menu chega COM o menu à vista', () => {
    const jid = 'teste-bot2@g.us';
    storeChatMetadata(jid, '2026-10-05T10:30:00Z', jid);
    storeMessageDirect({
      id: 'n1',
      chat_jid: jid,
      sender: '55@s',
      sender_name: 'Paciente',
      content: 'Oi',
      timestamp: '2026-10-05T11:00:00Z',
      is_from_me: false,
    });
    storeMessageDirect({
      id: 'n2',
      chat_jid: jid,
      sender: 'bot',
      sender_name: 'Lara',
      content: 'Escolha: 1 refrativa, 2 catarata',
      timestamp: '2026-10-05T11:00:05Z',
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'n3',
      chat_jid: jid,
      sender: '55@s',
      sender_name: 'Paciente',
      content: '2',
      timestamp: '2026-10-05T11:00:30Z',
      is_from_me: false,
    });
    const r = getMessagesSince(jid, '2026-10-05T10:30:00Z', 'Claw', 200, true);
    expect(r.map((m) => m.content)).toEqual([
      'Oi',
      'Escolha: 1 refrativa, 2 catarata',
      '2',
    ]);
  });
});

// --- ultimaMensagemDoPaciente ---

describe('ultimaMensagemDoPaciente', () => {
  it('devolve o texto E o remetente da MESMA linha', () => {
    // ⚠️ O teste que guarda o achado grave do review adversarial do Codex
    // (20/10/2026): a versão anterior devolvia só o texto, e quem chamava
    // pegava o remetente da janela velha de `missedMessages`. Num GRUPO com
    // várias pessoas, o texto saía de uma e o JID de outra — e esse JID vira
    // busca de cadastro e TELEFONE DE CONTATO DA CONSULTA. Um "pode ser esse
    // horário" do paciente podia marcar com o telefone de outro participante.
    storeChatMetadata('grupo@g.us', '2026-10-20T00:00:00.000Z');
    store({
      id: 'm1',
      chat_jid: 'grupo@g.us',
      sender: 'paciente@s.whatsapp.net',
      sender_name: 'Paciente',
      content: 'pode ser esse horario',
      timestamp: '2026-10-20T10:00:00.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'grupo@g.us',
      sender: 'outra-pessoa@s.whatsapp.net',
      sender_name: 'Outra',
      content: 'a primeira',
      timestamp: '2026-10-20T10:01:00.000Z',
    });

    const r = ultimaMensagemDoPaciente('grupo@g.us', 'Lara');
    expect(r).toEqual({
      content: 'a primeira',
      sender: 'outra-pessoa@s.whatsapp.net',
    });
    // O par não pode cruzar: o texto mais novo é de quem o enviou.
    expect(r?.sender).not.toBe('paciente@s.whatsapp.net');
  });

  it('ignora as mensagens do próprio bot', () => {
    storeChatMetadata('grupo2@g.us', '2026-10-20T00:00:00.000Z');
    store({
      id: 'b1',
      chat_jid: 'grupo2@g.us',
      sender: 'paciente@s.whatsapp.net',
      sender_name: 'Paciente',
      content: 'tem horario?',
      timestamp: '2026-10-20T10:00:00.000Z',
    });
    store({
      id: 'b2',
      chat_jid: 'grupo2@g.us',
      sender: 'bot@s.whatsapp.net',
      sender_name: 'Lara',
      content: 'Lara: Tenho quarta as 17:40.',
      timestamp: '2026-10-20T10:01:00.000Z',
    });

    expect(ultimaMensagemDoPaciente('grupo2@g.us', 'Lara')?.content).toBe(
      'tem horario?',
    );
  });

  it('devolve undefined quando a conversa não tem mensagem de paciente', () => {
    storeChatMetadata('vazio@g.us', '2026-10-20T00:00:00.000Z');
    expect(ultimaMensagemDoPaciente('vazio@g.us', 'Lara')).toBeUndefined();
  });
});

// --- mensagemPorIdCurto ---

describe('mensagemPorIdCurto', () => {
  /**
   * ⚠️ O teste da corrida que o conserto do par texto/remetente NÃO cobriu.
   *
   * Com container vivo, uma mensagem nova chega enquanto o resultado da
   * anterior está em voo. `ultimaMensagemDoPaciente` devolve a mais NOVA, então
   * o host executava a intenção velha contra a mensagem nova — e num grupo o
   * remetente dela virava `pedidoPor`, ou seja, o aceite de um participante
   * marcava consulta com o telefone de OUTRO. Achado do review adversarial do
   * Codex em 20/10/2026.
   */
  function doisRemetentes() {
    storeChatMetadata('corrida@g.us', '2026-10-20T00:00:00.000Z');
    store({
      id: 'MSG-DO-PACIENTE-AAAA1111',
      chat_jid: 'corrida@g.us',
      sender: 'paciente@s.whatsapp.net',
      sender_name: 'Paciente',
      content: 'pode ser esse horario',
      timestamp: '2026-10-20T10:00:00.000Z',
    });
    store({
      id: 'MSG-DE-OUTRA-PESSOA-BBBB2222',
      chat_jid: 'corrida@g.us',
      sender: 'outra@s.whatsapp.net',
      sender_name: 'Outra',
      content: 'bom dia a todos',
      timestamp: '2026-10-20T10:00:30.000Z',
    });
  }

  it('acha a mensagem do turno, não a mais nova', () => {
    doisRemetentes();
    // A mais nova é de outra pessoa — é o que o host pegava antes.
    expect(ultimaMensagemDoPaciente('corrida@g.us', 'Lara')?.sender).toBe(
      'outra@s.whatsapp.net',
    );
    // Com o id que o agente devolveu, acha a certa.
    const r = mensagemPorIdCurto(
      'corrida@g.us',
      idCurto('MSG-DO-PACIENTE-AAAA1111'),
      'Lara',
    );
    expect(r).toEqual({
      content: 'pode ser esse horario',
      sender: 'paciente@s.whatsapp.net',
    });
  });

  it('devolve nada quando o sufixo não acha, em vez de chutar', () => {
    doisRemetentes();
    expect(
      mensagemPorIdCurto('corrida@g.us', 'ZZZZ9999', 'Lara'),
    ).toBeUndefined();
  });

  it('devolve nada quando o sufixo é AMBÍGUO', () => {
    // ⚠️ Ambiguidade silenciosa aqui seria pior que a corrida: o host acharia
    // que amarrou o turno e teria amarrado na mensagem errada. Melhor cair no
    // comportamento antigo e logar.
    storeChatMetadata('ambiguo@g.us', '2026-10-20T00:00:00.000Z');
    for (const [id, quem] of [
      ['PRIMEIRA-XXXX0000', 'a@s.whatsapp.net'],
      ['SEGUNDA-XXXX0000', 'b@s.whatsapp.net'],
    ] as const) {
      store({
        id,
        chat_jid: 'ambiguo@g.us',
        sender: quem,
        sender_name: quem,
        content: 'texto ' + id,
        timestamp: '2026-10-20T10:00:00.000Z',
      });
    }
    expect(
      mensagemPorIdCurto('ambiguo@g.us', 'XXXX0000', 'Lara'),
    ).toBeUndefined();
  });

  it('recusa sufixo curto demais', () => {
    doisRemetentes();
    expect(mensagemPorIdCurto('corrida@g.us', '11', 'Lara')).toBeUndefined();
  });

  it('não atravessa conversas', () => {
    doisRemetentes();
    expect(
      mensagemPorIdCurto(
        'outro-chat@g.us',
        idCurto('MSG-DO-PACIENTE-AAAA1111'),
        'Lara',
      ),
    ).toBeUndefined();
  });
});

// --- getMessagesSince devolve a marca de bot ---

describe('getMessagesSince: a marca de bot volta na linha', () => {
  it('devolve is_bot_message, para quem chama poder separar', () => {
    // ⚠️ Sem esta coluna, a varredura do expediente contava a fala da PRÓPRIA
    // Lara como "conversa segurada" e re-enfileirava em laço: ela postava "Só
    // um instante.", aquilo ficava depois do cursor, a varredura de 60 s via
    // pendente, re-enfileirava, ela postava de novo. Medido em produção em
    // 20/10/2026, com um escalonamento no DM do Thiago a cada ciclo.
    //
    // E o conserto no chamador (filtrar `!m.is_bot_message`) era INERTE sem
    // isto: o campo vinha `undefined`, então `!undefined` era true para todas.
    storeChatMetadata('marca@g.us', '2026-10-20T00:00:00.000Z');
    store({
      id: 'p1',
      chat_jid: 'marca@g.us',
      sender: 'paciente@s.whatsapp.net',
      sender_name: 'Paciente',
      content: 'tem horario?',
      timestamp: '2026-10-20T10:00:00.000Z',
    });
    storeMessageDirect({
      id: 'b1',
      chat_jid: 'marca@g.us',
      sender: 'bot',
      sender_name: 'Lara',
      content: 'Só um instante.',
      timestamp: '2026-10-20T10:01:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const todas = getMessagesSince(
      'marca@g.us',
      '2026-10-20T09:00:00.000Z',
      'Lara',
      50,
      true, // pasta com template: devolve as duas
    );
    expect(todas.length).toBe(2);
    const doPaciente = todas.filter((m) => !m.is_bot_message);
    expect(doPaciente.length).toBe(1);
    expect(doPaciente[0].content).toBe('tem horario?');
  });
});
