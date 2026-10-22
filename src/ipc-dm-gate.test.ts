import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipcgate-'));
vi.mock('./config.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    GROUPS_DIR: path.join(tmp, 'groups'),
    IPC_POLL_INTERVAL: 50,
  };
});

const { startIpcWatcher } = await import('./ipc.js');

const sent: string[] = [];
const docs: string[] = [];
/**
 * O que o canal vai responder. Mutável porque `startIpcWatcher` tem trava de
 * instância única: só o PRIMEIRO objeto de deps vale, então o fake precisa ler
 * uma variável, e não ser trocado por teste.
 */
let resultadoDoEnvio: 'enviado' | 'recusado' | 'enfileirado' = 'enviado';
const pipelinesArmados: string[] = [];
const FOLDER = 'whatsapp_atendimento-dra-marina';
const ipcDir = path.join(tmp, 'ipc', FOLDER, 'messages');

function write(payload: Record<string, unknown>) {
  fs.mkdirSync(ipcDir, { recursive: true });
  const fp = path.join(
    ipcDir,
    `${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(fp + '.tmp', JSON.stringify(payload));
  fs.renameSync(fp + '.tmp', fp);
}

async function drain() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (
      fs.existsSync(ipcDir) &&
      fs.readdirSync(ipcDir).filter((f) => f.endsWith('.json')).length === 0
    )
      return;
  }
}

describe('trava de DM a paciente', () => {
  beforeEach(() => {
    sent.length = 0;
    docs.length = 0;
    pipelinesArmados.length = 0;
    resultadoDoEnvio = 'enviado';
    fs.mkdirSync(path.join(tmp, 'groups', FOLDER), { recursive: true });
    startIpcWatcher({
      sendMessage: async (jid, text) => {
        if (resultadoDoEnvio === 'enviado') sent.push(`${jid}|${text}`);
        return resultadoDoEnvio;
      },
      registraPipeline: (chatJid, origin) => {
        pipelinesArmados.push(`${chatJid}|${origin}`);
      },
      sendImage: async () => {},
      sendDocument: async (jid, fp) => {
        docs.push(`${jid}|${fp}`);
      },
      registeredGroups: () => ({
        '120363287717747603@g.us': {
          jid: '120363287717747603@g.us',
          name: 'Atendimento',
          folder: FOLDER,
          trigger_pattern: '@Andy',
          added_at: '',
          requires_trigger: 1,
        } as never,
        '558681512111@s.whatsapp.net': {
          jid: '558681512111@s.whatsapp.net',
          name: 'Thiago',
          folder: 'whatsapp_main',
          trigger_pattern: '',
          added_at: '',
          requires_trigger: 0,
          isMain: true,
        } as never,
      }),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    });
  });
  afterEach(() => {
    for (const f of fs.existsSync(ipcDir) ? fs.readdirSync(ipcDir) : [])
      fs.rmSync(path.join(ipcDir, f));
  });

  it('BLOQUEIA mensagem do agente a paciente (sem origin)', async () => {
    write({
      type: 'message',
      chatJid: '5586999998888@s.whatsapp.net',
      text: 'Oi! Claro, posso te ajudar',
      groupFolder: FOLDER,
    });
    await drain();
    expect(sent).toEqual([]);
  });

  it('BLOQUEIA mesmo com origin inventado', async () => {
    write({
      type: 'message',
      chatJid: '5586999998888@s.whatsapp.net',
      text: 'oi',
      groupFolder: FOLDER,
      origin: 'agente',
    });
    await drain();
    expect(sent).toEqual([]);
  });

  it('PERMITE o lembrete fixo (origin send_reminder)', async () => {
    write({
      type: 'message',
      chatJid: '5586999998888@s.whatsapp.net',
      text: 'lembrete',
      groupFolder: FOLDER,
      origin: 'send_reminder',
    });
    await drain();
    expect(sent).toEqual(['5586999998888@s.whatsapp.net|lembrete']);
  });

  /**
   * ⛔ A janela de supressão só pode ser armada quando a mensagem SAIU.
   *
   * Achado do review adversarial do Codex em 22/10/2026: o host armava a janela
   * logo depois do `await sendMessage`, e o envio resolve igual em três casos
   * que não são entrega — política recusou (a trava da semana de observação),
   * socket desconectado (fila da reconexão) e falha de transporte (fila de
   * novo). Um lembrete que nunca chegou deixava até 36h em que um "sim"
   * legítimo do paciente — resposta a uma pergunta da secretária, por exemplo —
   * era descartado como eco.
   *
   * Suprimir sem causa é o erro caro; deixar de suprimir é ruído.
   */
  describe('a supressão só é armada quando a mensagem sai', () => {
    it('envio que SAIU arma a janela', async () => {
      write({
        type: 'message',
        chatJid: '5586999998888@s.whatsapp.net',
        text: 'lembrete',
        groupFolder: FOLDER,
        origin: 'send_reminder',
      });
      await drain();
      expect(pipelinesArmados).toEqual([
        '5586999998888@s.whatsapp.net|send_reminder',
      ]);
    });

    it('envio RECUSADO pela política não arma nada', async () => {
      resultadoDoEnvio = 'recusado';
      write({
        type: 'message',
        chatJid: '5586999998888@s.whatsapp.net',
        text: 'lembrete',
        groupFolder: FOLDER,
        origin: 'send_reminder',
      });
      await drain();
      expect(pipelinesArmados).toEqual([]);
    });

    it('envio ENFILEIRADO na reconexão não arma nada', async () => {
      resultadoDoEnvio = 'enfileirado';
      write({
        type: 'message',
        chatJid: '5586999998888@s.whatsapp.net',
        text: 'lembrete',
        groupFolder: FOLDER,
        origin: 'send_reminder',
      });
      await drain();
      expect(pipelinesArmados).toEqual([]);
    });

    it('mensagem sem origin nunca arma, mesmo saindo', async () => {
      write({
        type: 'message',
        chatJid: '558681512111@s.whatsapp.net',
        text: 'oi',
        groupFolder: 'whatsapp_main',
      });
      await drain();
      expect(pipelinesArmados).toEqual([]);
    });
  });

  it('PERMITE a auto-resposta fixa', async () => {
    write({
      type: 'message',
      chatJid: '5586999998888@s.whatsapp.net',
      text: 'ack',
      groupFolder: FOLDER,
      origin: 'lembrete_autoreply',
    });
    await drain();
    expect(sent.length).toBe(1);
  });

  it('PERMITE o PDF da nota (send_nota)', async () => {
    fs.writeFileSync(path.join(tmp, 'groups', FOLDER, 'n.pdf'), 'x');
    write({
      type: 'document',
      chatJid: '5586999998888@s.whatsapp.net',
      filePath: '/workspace/group/n.pdf',
      fileName: 'Nota.pdf',
      groupFolder: FOLDER,
      origin: 'send_nota',
    });
    await drain();
    expect(docs.length).toBe(1);
  });

  it('BLOQUEIA PDF a paciente sem origin', async () => {
    fs.writeFileSync(path.join(tmp, 'groups', FOLDER, 'n.pdf'), 'x');
    write({
      type: 'document',
      chatJid: '5586999998888@s.whatsapp.net',
      filePath: '/workspace/group/n.pdf',
      groupFolder: FOLDER,
    });
    await drain();
    expect(docs).toEqual([]);
  });

  it('NAO afeta post no grupo do atendimento', async () => {
    write({
      type: 'message',
      chatJid: '120363287717747603@g.us',
      text: 'resumo das confirmações',
      groupFolder: FOLDER,
    });
    await drain();
    expect(sent.length).toBe(1);
  });

  it('NAO afeta alerta de SLA pro Thiago', async () => {
    write({
      type: 'message',
      chatJid: '558681512111@s.whatsapp.net',
      text: 'alerta sla',
      groupFolder: 'whatsapp_main',
    });
    await drain();
    expect(sent.length).toBe(1);
  });
});
