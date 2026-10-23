import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import qrcodeTerminal from 'qrcode-terminal';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type WASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  BOT_MARK,
  GROUPS_DIR,
  STORE_DIR,
  isBotText,
} from '../config.js';
import {
  marcadorDeAudio,
  textoParaAgente,
  transcreveAudio,
} from '../audio-transcribe.js';
import { readEnvFile } from '../env.js';

const envConfig = readEnvFile(['WHATSAPP_PAIRING_NUMBER', 'WHATSAPP_QR_FILE']);

/**
 * Caminho onde gravar o QR de vinculação, em texto desenhado.
 *
 * Existe porque o pareamento por NÚMERO falhou três vezes no aparelho do
 * atendimento em 04/10/2026: o código era gerado, vivia os 2m40s e expirava
 * sem o celular conseguir completar ("não foi possível conectar"). O QR é outro
 * caminho no WhatsApp e não depende daquele fluxo.
 *
 * Vazio desliga, e aí vale o pareamento por número. Quando ligado, NÃO se pede
 * código: os dois fluxos disputariam a mesma vinculação.
 */
const QR_FILE =
  process.env.WHATSAPP_QR_FILE || envConfig.WHATSAPP_QR_FILE || '';
const PAIRING_NUMBER =
  process.env.WHATSAPP_PAIRING_NUMBER ||
  envConfig.WHATSAPP_PAIRING_NUMBER ||
  '558681512111';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  ResultadoDoEnvio,
} from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Rotação dos jsonl de captura (ver rotateJsonl): só checa de vez em quando pra
// não dar statSync a cada mensagem, e guarda 48h — o monitor só olha 12h.
const JSONL_ROTATE_CHECK_EVERY = 200;
const JSONL_ROTATE_MAX_BYTES = 4 * 1024 * 1024;
const JSONL_RETENTION_MS = 48 * 60 * 60 * 1000;
const waLogger = {
  level: 'info',
  trace: (...args: unknown[]) => logger.debug({ args }, 'baileys trace'),
  debug: (...args: unknown[]) => logger.debug({ args }, 'baileys debug'),
  info: (...args: unknown[]) => logger.info({ args }, 'baileys info'),
  warn: (...args: unknown[]) => logger.warn({ args }, 'baileys warn'),
  error: (...args: unknown[]) => logger.error({ args }, 'baileys error'),
  fatal: (...args: unknown[]) => logger.fatal({ args }, 'baileys fatal'),
  child: () => waLogger,
};

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * ⛔ A POLÍTICA DE EGRESSO, injetada pelo host.
   *
   * Todo envio a um jid — texto, imagem, documento, presença e o flush da fila
   * de reconexão — passa por aqui antes de tocar o socket. O canal não decide
   * política: ele só garante que ninguém sai sem ser perguntado.
   *
   * O host decide porque é ele que sabe a pasta de cada alvo. Sem a função
   * injetada, tudo é permitido — instalação sem observação não muda em nada.
   */
  podeEntregar?: (opts: {
    alvo: string;
    origem?: string;
    tipo: 'texto' | 'imagem' | 'documento' | 'presenca';
  }) => boolean;
  /** Registra uma DM de paciente numa pasta de observação. Ver `dmObservacaoFolder`. */
  registraDmEmObservacao?: (
    chatJid: string,
    folder: string,
    desdeIso: string,
  ) => void;
  // Per-instance overrides (used for secondary connections)
  authSubDir?: string; // auth dir under STORE_DIR, defaults to 'auth'
  pairingNumber?: string; // phone number for pairing, defaults to PAIRING_NUMBER
  groupFolderOwner?: string; // when set, this instance is outbound-only for this group folder
  /**
   * Pasta para onde as DMs de paciente deste número vão, em MODO OBSERVAÇÃO.
   *
   * Quando definida, a instância deixa de ser estritamente outbound: as DMs
   * passam a virar turno de agente, a Lara calcula a resposta e ela vai para o
   * destino da revisão. A pasta tem de estar em `OBSERVACAO_FOLDERS`, e é a
   * trava do `aprova` que garante que nada volta ao paciente.
   *
   * Decisão do Thiago em 19/10/2026: "quero ler o que o paciente fala na DM e
   * enviar a resposta no grupo de testes em caráter observatório".
   *
   * ⚠️ Sem esta opt o comportamento é o de antes, e é o seguro: nenhum inbound
   * vira turno. Não ligue sem a pasta estar em observação.
   */
  dmObservacaoFolder?: string;
}

/**
 * Esta mensagem vira turno de observação?
 *
 * Extraída da `processaDmsEmObservacao` para poder ser testada: a decisão é a
 * parte que importa, e dentro da classe ela exigiria um socket do baileys.
 *
 * As quatro recusas, e por que cada uma existe:
 *
 * - `tipo !== 'notify'` — 'append' é sincronização de HISTÓRICO. Numa
 *   reconexão, que acontece, a Lara classificaria conversa de semanas atrás.
 * - `fromMe` — nessas DMs quem mais escreve é a SECRETÁRIA. Tratar a resposta
 *   dela como turno do paciente faria a Lara classificar a própria clínica, e o
 *   eco `fromMe` é justamente o que mede o SLA, então chega aqui sempre.
 * - antes do PISO — mesmo em 'notify' o baileys entrega o que ficou offline
 *   enquanto o processo estava fora. "Só mensagens novas" (Thiago, 19/10/2026).
 * - `@g.us` — grupo neste número não é conversa de paciente.
 */
export function aceitaDmDeObservacao(m: {
  tipo?: string;
  fromMe?: boolean;
  rawJid?: string | null;
  timestampMs: number;
  piso: number;
}): boolean {
  if (m.tipo && m.tipo !== 'notify') return false;
  // ⚠️ `fromMe` ENTRA, desde 22/10/2026.
  //
  // Até aqui a linha era `if (m.fromMe) return false`, e a intenção estava
  // certa: a secretária não é o paciente, e tratar a resposta dela como turno
  // faria a Lara responder à própria clínica. Mas a linha fazia DUAS coisas —
  // não disparar e não VER —, e a segunda estragou a semana de observação: a
  // Lara lia metade do diálogo. Na primeira conversa real, 21/10, a paciente
  // respondeu "Particular" e "Como faço?" à SECRETÁRIA, e a Lara, que nunca viu
  // o que a secretária disse, produziu resposta fora de contexto.
  //
  // Quem impede o turno agora é o host, em `index.ts`: numa DM observada, um
  // lote só de `is_from_me` não dispara. Aqui a mensagem é só gravada.
  if (!m.rawJid || m.rawJid === 'status@broadcast') return false;
  if (m.rawJid.endsWith('@g.us')) return false;
  if (!Number.isFinite(m.timestampMs) || m.timestampMs < m.piso) return false;
  return true;
}

export class WhatsAppChannel implements Channel {
  private readonly inicioDaObservacao: number;
  name: string;

  private sock!: WASocket;
  private connected = false;
  /**
   * Código de pareamento já pedido nesta conexão.
   *
   * O baileys emite `connection.update` com `qr` a cada ~20s enquanto espera
   * autenticação, e pedir um código em cada evento tem duas consequências, as
   * duas ruins: cada código novo invalida o anterior, e **um humano não digita
   * 8 caracteres num celular em 20 segundos**. Pior, em 04/10/2026 o app seguiu
   * pedindo código DEPOIS de `registered: true` ter sido gravado, e o vínculo
   * recém-criado morreu com 401 no boot seguinte.
   *
   * Então o código é pedido uma vez por conexão. A janela passa a ser a do
   * WhatsApp, não os 20s do refresh.
   */
  private pairingCodeRequested = false;
  private lidToPhoneMap: Record<string, string> = {};
  // ⚠️ `origem` fica na fila de propósito: item enfileirado antes e entregue
  // depois da reconexão é o caso que nenhuma trava no fluxo pega, e a política
  // tem de ser reavaliada no instante do envio, não no do enfileiramento.
  private outgoingQueue: Array<{ jid: string; text: string; origem?: string }> =
    [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private jsonlAppends: Record<string, number> = {};
  // Rede de segurança para a classificação do echo: se a marca invisível for
  // removida em trânsito, o id ainda identifica a mensagem como nossa. Sem
  // isso, a falha seria o bot respondendo a si mesmo em loop.
  private sentIds = new Set<string>();

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
    // O piso da observação: nada anterior a este instante vira turno. Ver
    // `processaDmsEmObservacao`.
    this.inicioDaObservacao = Date.now();
    this.name = opts.groupFolderOwner
      ? `whatsapp:${opts.groupFolderOwner}`
      : 'whatsapp';
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authSubDir = this.opts.authSubDir ?? 'auth';
    const pairingNumber = this.opts.pairingNumber ?? PAIRING_NUMBER;
    const authDir = path.join(STORE_DIR, authSubDir);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      printQRInTerminal: false,
      logger: waLogger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (QR_FILE) {
          // Desenhado aqui, na VM, de propósito: o QR se renova a cada ~20s, e
          // trazer a string crua para desenhar do outro lado gastaria uma ida a
          // mais da janela de quem vai escanear.
          qrcodeTerminal.generate(qr, { small: true }, (desenho: string) => {
            try {
              const tmp = `${QR_FILE}.tmp`;
              fs.writeFileSync(
                tmp,
                `gerado ${new Date().toISOString()}\n\n${desenho}\n`,
              );
              fs.renameSync(tmp, QR_FILE);
              // A string crua também, para quem quiser desenhar o QR de outro
              // jeito. QR em caracteres de terminal depende da fonte e do
              // tamanho da tela, e no aparelho do atendimento não escaneou.
              //
              // ⚠️ Esta string AUTORIZA vincular um dispositivo à conta. Ela
              // fica no disco da VM e não vai para serviço nenhum: publicá-la
              // em qualquer lugar alcançável daria a conta a quem abrisse o
              // link.
              const bruto = `${QR_FILE}.raw`;
              fs.writeFileSync(`${bruto}.tmp`, qr, { mode: 0o600 });
              fs.renameSync(`${bruto}.tmp`, bruto);
              logger.info({ arquivo: QR_FILE }, 'QR de vinculação atualizado');
            } catch (err) {
              logger.error({ err, arquivo: QR_FILE }, 'não gravei o QR');
            }
          });
          return;
        }
        if (pairingNumber) {
          // Pairing code mode — request code instead of showing QR.
          // UMA vez por conexão: ver pairingCodeRequested.
          if (this.pairingCodeRequested) return;
          this.pairingCodeRequested = true;
          this.sock
            .requestPairingCode(pairingNumber.replace(/\D/g, ''))
            .then((code) => {
              logger.info(
                `WhatsApp pairing code: ${code} — enter this on your phone`,
              );
            })
            .catch((err) => {
              logger.error({ err }, 'Failed to request pairing code');
            });
        } else {
          const msg =
            'WhatsApp authentication required. Set WHATSAPP_PAIRING_NUMBER in .env or run /setup.';
          logger.error(msg);
          exec(
            `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
          );
          setTimeout(() => process.exit(1), 1000);
        }
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else if (this.opts.groupFolderOwner) {
          // Secondary outbound-only instance (e.g. the atendimento number):
          // a logout here must NOT kill the whole process — that would take
          // the primary number down with it. Log and stop this instance only.
          logger.warn(
            { instance: this.name },
            'Secondary WhatsApp instance logged out — re-pair via /setup. Process stays alive.',
          );
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.pairingCodeRequested = false;
        logger.info('Connected to WhatsApp');

        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (this.opts.groupFolderOwner) {
        // Instância outbound-only (ex.: número do atendimento). NUNCA processa
        // inbound como turno de agente / resposta. Só captura passivamente as
        // respostas individuais dos pacientes (pro resumo de confirmação de
        // consulta) e retorna. Nenhum onMessage, nenhum agente, nada ao paciente.
        //
        // A captura passiva roda SEMPRE, e primeiro: é dela que sai o SLA e a
        // confirmação de consulta, e observação não pode custar isso.
        await this.captureInboundReplies(messages);
        await this.captureSlaTimeline(messages);
        if (!this.opts.dmObservacaoFolder) return;
        // MODO OBSERVAÇÃO: as DMs passam a virar turno. O que volta ao paciente
        // é nada — a pasta está em `OBSERVACAO_FOLDERS` e o `aprova` recusa.
        await this.processaDmsEmObservacao(messages, type);
        return;
      }
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          const chatJid = await this.translateJid(rawJid);
          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            const content = await this.conteudoDaMensagem(
              msg,
              normalized,
              chatJid,
              groups[chatJid].folder,
            );

            if (!content) continue;

            const sender = await this.senderJid(msg);
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : isBotText(content) || this.wasSentByUs(msg.key.id);

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  // Tripwire: TODO envio 1:1 por uma instância secundária (número do
  // atendimento) é logado e gravado em jsonl. O agente nunca deve falar com
  // paciente — se um dia falar, isso aparece aqui com o texto, pra auditoria.
  // Não bloqueia: os envios legítimos (lembrete, auto-resposta, PDF de nota)
  // passam pelo mesmo caminho.
  private auditSecondaryDm(jid: string, kind: string, preview: string): void {
    const folder = this.opts.groupFolderOwner;
    if (!folder) return;
    if (!jid.endsWith('@s.whatsapp.net')) return;
    logger.warn(
      { instance: this.name, jid, kind, preview: preview.slice(0, 200) },
      'DM enviada pelo número do atendimento (auditoria)',
    );
    try {
      this.appendGroupJsonl(folder, 'atendimento_dm_enviadas.jsonl', {
        jid,
        kind,
        preview: preview.slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* auditoria nunca pode derrubar o envio */
    }
  }

  // Linha do tempo das conversas 1:1 do número do atendimento, pros dois lados
  // (paciente e quem responde do número). Serve pro monitor de tempo de resposta
  // (SLA). Append-only, NUNCA responde nada, NUNCA aciona o agente.
  // Arquivo separado do lembrete_respostas.jsonl de propósito: aquele é lido
  // pelo pipeline de confirmação e só pode conter mensagens de paciente.
  /**
   * As DMs de paciente deste número viram turno de agente, em observação.
   *
   * Registra o chat na MESMA pasta do grupo de teste (uma vez, por chat) e
   * entrega ao
   * `onMessage`, que é o caminho normal. Daí para frente nada é especial: o
   * executor classifica, a guarda inspeciona, e a resposta vai para o destino
   * da revisão em vez do paciente.
   *
   * ⚠️ Ignora `fromMe`. Nessas DMs quem mais escreve é a SECRETÁRIA, e tratar a
   * resposta dela como turno do paciente faria a Lara classificar a própria
   * clínica — e, pior, o eco `fromMe` é o que mede o SLA, então ele chega aqui
   * de todo jeito. Só mensagem do paciente vira turno.
   *
   * ⛔ Só DM. Grupo que apareça neste número não é conversa de paciente.
   */
  /**
   * O TEXTO que o agente vai ler, venha ele de onde vier.
   *
   * ⚠️ Nasceu em 22/10/2026 porque havia DUAS cópias disto, e a segunda era
   * pobre. O laço de observação (`processaDmsEmObservacao`, criado em
   * 19/10/2026) copiou só a extração de legenda e deixou para trás o ramo do
   * ÁUDIO e o do PDF, que viviam vinte linhas acima — reintroduzindo, num
   * caminho novo, exatamente o defeito que o comentário do áudio descreve como
   * consertado em 04/10: "quem mandava áudio nunca era respondido".
   *
   * O sintoma apareceu no primeiro dia de observação: uma paciente mandou
   * áudio às 20:48 e a Lara não viu nada, enquanto o log de SLA registrava
   * `[áudio]`. Copiar o ramo para o segundo laço seria fazer a terceira cópia;
   * o conserto é os dois chamarem isto.
   *
   * `folder` é onde os arquivos ficam: o `.ogg` e o PDF PERMANECEM em disco,
   * porque são a fonte para o humano conferir a transcrição no escalonamento.
   */
  private async conteudoDaMensagem(
    msg: import('@whiskeysockets/baileys').WAMessage,
    normalized: NonNullable<ReturnType<typeof normalizeMessageContent>>,
    chatJid: string,
    folder: string,
  ): Promise<string> {
    let content =
      normalized.conversation ||
      normalized.extendedTextMessage?.text ||
      normalized.imageMessage?.caption ||
      normalized.videoMessage?.caption ||
      '';

    // Áudio: baixa, transcreve localmente e entrega o texto ao agente.
    // Antes de 04/10/2026 isto era descartado em silêncio (content ficava
    // vazio e o `continue` abaixo engolia a mensagem), então quem mandava
    // áudio nunca era respondido.
    //
    // Qualquer falha ou transcrição incerta cai no marcador, e o FAQ
    // (F00d) manda pedir por escrito: agir sobre palpite é pior que
    // admitir que não entendeu.
    if (!content && normalized.audioMessage) {
      const seg = normalized.audioMessage.seconds || 0;
      content = marcadorDeAudio(seg);
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const groupDir = path.join(GROUPS_DIR, folder);
        const audioDir = path.join(groupDir, 'audios');
        fs.mkdirSync(audioDir, { recursive: true });
        // O arquivo FICA no disco: é a fonte para o humano conferir a
        // transcrição no escalonamento.
        const nome = `${msg.key.id || Date.now()}.ogg`;
        const filePath = path.join(audioDir, nome);
        fs.writeFileSync(filePath, buffer as Buffer);
        const t = await transcreveAudio(filePath);
        content = textoParaAgente(t, seg);
      } catch (err) {
        logger.warn(
          { err, jid: chatJid },
          'Failed to download audio, keeping marker',
        );
      }
    }

    if (normalized.documentMessage?.mimetype === 'application/pdf') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const groupDir = path.join(GROUPS_DIR, folder);
        const attachDir = path.join(groupDir, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });
        const filename = path.basename(
          normalized.documentMessage.fileName || `doc-${Date.now()}.pdf`,
        );
        const filePath = path.join(attachDir, filename);
        fs.writeFileSync(filePath, buffer as Buffer);
        const sizeKB = Math.round((buffer as Buffer).length / 1024);
        const pdfRef = `[PDF: attachments/${filename} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${filename}`;
        const caption = normalized.documentMessage.caption || '';
        content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;
        logger.info({ jid: chatJid, filename }, 'Downloaded PDF attachment');
      } catch (err) {
        logger.warn({ err, jid: chatJid }, 'Failed to download PDF attachment');
      }
    }
    return content;
  }

  private async processaDmsEmObservacao(
    messages: import('@whiskeysockets/baileys').WAMessage[],
    tipo?: string,
  ): Promise<void> {
    const folder = this.opts.dmObservacaoFolder;
    if (!folder) return;
    // ⛔ SÓ mensagem NOVA. "Só queria para mensagens novas, tanto de pacientes
    // antigos quanto de novos" (Thiago, 19/10/2026).
    //
    // Duas portas, e as duas precisavam fechar:
    //
    // 1. `type`: o baileys manda 'notify' para o que chega ao vivo e 'append'
    //    para sincronização de histórico. Numa reconexão — que acontece — o
    //    histórico entraria como se fosse novo, e a Lara classificaria conversa
    //    de semanas atrás.
    // 2. O PISO de tempo: mesmo em 'notify', o baileys entrega o que ficou
    //    offline enquanto o processo estava fora. O piso é o instante em que
    //    esta instância subiu.
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const quando = Number(msg.messageTimestamp) * 1000;
        const rawJid = msg.key.remoteJid;
        if (
          !aceitaDmDeObservacao({
            tipo,
            fromMe: !!msg.key.fromMe,
            rawJid,
            timestampMs: quando,
            piso: this.inicioDaObservacao,
          })
        ) {
          continue;
        }
        // `aceitaDmDeObservacao` já recusou rawJid vazio; o if abaixo é para o
        // TypeScript, que não enxerga isso através da função.
        if (!rawJid) continue;
        const normalized = normalizeMessageContent(msg.message);
        if (!normalized) continue;
        const chatJid = await this.translateJid(rawJid);
        // ⚠️ A MESMA extração do caminho normal. Até 22/10/2026 aqui havia uma
        // cópia pobre — só texto e legenda —, e áudio e PDF morriam no
        // `continue` abaixo, sem log. Ver `conteudoDaMensagem`.
        const content = await this.conteudoDaMensagem(
          msg,
          normalized,
          chatJid,
          folder,
        );
        if (!content.trim()) continue;
        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          false,
        );
        if (!this.opts.registeredGroups()[chatJid]) {
          // O cursor do chat começa 1ms ANTES desta mensagem: sem isso, a
          // primeira rodada varreria tudo que já estiver gravado do chat,
          // porque `getOrRecoverCursor` devolve '' para chat desconhecido.
          this.opts.registraDmEmObservacao?.(
            chatJid,
            folder,
            new Date(quando - 1).toISOString(),
          );
          logger.info(
            { chatJid, folder },
            'observação: DM de paciente registrada para leitura',
          );
        }
        const daClinica = !!msg.key.fromMe;
        this.opts.onMessage(chatJid, {
          chat_jid: chatJid,
          // Quem falou. Com `fromMe`, é a clínica (secretária) — e o nome vem
          // do `pushName` para o prompt mostrar de quem é a fala, em vez de
          // atribuir tudo ao paciente.
          sender: daClinica ? 'clinica' : chatJid,
          sender_name: daClinica
            ? msg.pushName || 'Atendimento'
            : msg.pushName || chatJid.split('@')[0],
          content,
          timestamp,
          is_from_me: daClinica,
          // ⚠️ NÃO é mensagem de bot: a secretária é humana, e marcar como bot
          // seria mentir para esconder o gatilho. Quem segura o gatilho é o
          // host, que ignora lote só de `is_from_me` em DM observada.
          is_bot_message: false,
          id: msg.key.id || `${Date.now()}`,
        } as never);
      } catch (err) {
        logger.warn({ err }, 'observação: falhou ao processar DM');
      }
    }
  }

  private async captureSlaTimeline(
    messages: import('@whiskeysockets/baileys').WAMessage[],
  ): Promise<void> {
    const folder = this.opts.groupFolderOwner;
    if (!folder) return;
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;
        const chatJid = await this.translateJid(rawJid);
        if (!chatJid.endsWith('@s.whatsapp.net')) continue; // só individual
        const normalized = normalizeMessageContent(msg.message);
        if (!normalized) continue;
        const text =
          normalized.conversation ||
          normalized.extendedTextMessage?.text ||
          normalized.imageMessage?.caption ||
          normalized.videoMessage?.caption ||
          '';
        // Mídia sem legenda também é demanda (foto de exame) e também é resposta
        // (áudio da atendente) — registra um marcador em vez de descartar.
        const kind = normalized.imageMessage
          ? '[imagem]'
          : normalized.audioMessage
            ? '[áudio]'
            : normalized.videoMessage
              ? '[vídeo]'
              : normalized.documentMessage
                ? '[documento]'
                : normalized.stickerMessage
                  ? '[sticker]'
                  : '';
        const body = text.trim() || kind;
        if (!body) continue;
        const entry = {
          id: msg.key.id || '',
          jid: chatJid,
          phone: chatJid.split('@')[0],
          direction: msg.key.fromMe ? 'out' : 'in',
          text: body,
          push_name: msg.pushName || '',
          timestamp: new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString(),
        };
        this.appendGroupJsonl(folder, 'atendimento_sla.jsonl', entry);
      } catch (err) {
        logger.warn({ err }, 'captureSlaTimeline: failed for a message');
      }
    }
  }

  // Teto do registro de ids: a classificação do echo acontece em segundos, e
  // só a marca invisível importa depois disso. 500 cobre qualquer rajada sem
  // o Set crescer para sempre no processo, que fica meses de pé.
  private static readonly SENT_IDS_MAX = 500;

  private rememberSentId(id?: string | null): void {
    if (!id) return;
    if (this.sentIds.size >= WhatsAppChannel.SENT_IDS_MAX) {
      // Set preserva ordem de inserção: o primeiro do iterador é o mais antigo.
      this.sentIds.delete(this.sentIds.values().next().value as string);
    }
    this.sentIds.add(id);
  }

  private wasSentByUs(id?: string | null): boolean {
    return !!id && this.sentIds.has(id);
  }

  // Registra o id de cada mensagem que O BOT enviou por esta instância. O
  // monitor de SLA faz a diferença de conjuntos depois (minutos depois), então
  // não há corrida com o echo do messages.upsert.
  private recordBotSentId(jid: string, id?: string | null): void {
    const folder = this.opts.groupFolderOwner;
    if (!folder || !id) return;
    try {
      this.appendGroupJsonl(folder, 'atendimento_bot_sent.jsonl', {
        id,
        jid,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn({ err, jid, id }, 'recordBotSentId failed');
    }
  }

  private appendGroupJsonl(folder: string, file: string, entry: unknown): void {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, file);
    fs.appendFileSync(target, JSON.stringify(entry) + '\n');
    this.rotateJsonl(target, file);
  }

  // Rotação dos jsonl é feita AQUI, no host, e NUNCA dentro do container: o
  // container roda como `node` (uid 1000) e o processo do host roda com outro
  // usuário. Se o container reescrevesse o arquivo, o dono mudaria e o append
  // do host passaria a falhar — a captura morreria calada.
  private rotateJsonl(target: string, file: string): void {
    const counter = (this.jsonlAppends[file] =
      (this.jsonlAppends[file] ?? 0) + 1);
    if (counter % JSONL_ROTATE_CHECK_EVERY !== 0) return;
    try {
      if (fs.statSync(target).size < JSONL_ROTATE_MAX_BYTES) return;
      const cutoff = Date.now() - JSONL_RETENTION_MS;
      const kept = fs
        .readFileSync(target, 'utf-8')
        .split('\n')
        .filter((line) => {
          if (!line.trim()) return false;
          try {
            const ts = Date.parse(
              (JSON.parse(line) as { timestamp?: string }).timestamp || '',
            );
            return Number.isNaN(ts) ? false : ts >= cutoff;
          } catch {
            return false;
          }
        });
      // Reescreve NO LUGAR (não renomeia) pra preservar dono e permissões.
      fs.writeFileSync(target, kept.length ? kept.join('\n') + '\n' : '');
      logger.info({ file, kept: kept.length }, 'Rotated capture jsonl');
    } catch (err) {
      logger.warn({ err, file }, 'rotateJsonl failed (ignorado)');
    }
  }

  // Captura passiva de respostas de pacientes na instância outbound-only.
  // Grava {jid, phone, text, timestamp} em append no jsonl do grupo dono, pra o
  // pipeline de confirmação de consulta correlacionar depois. NUNCA responde,
  // NUNCA aciona o agente — é só um log.
  private async captureInboundReplies(
    messages: import('@whiskeysockets/baileys').WAMessage[],
  ): Promise<void> {
    const folder = this.opts.groupFolderOwner;
    if (!folder) return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;
        const chatJid = await this.translateJid(rawJid);
        if (!chatJid.endsWith('@s.whatsapp.net')) continue; // só individual
        const normalized = normalizeMessageContent(msg.message);
        const text =
          normalized?.conversation ||
          normalized?.extendedTextMessage?.text ||
          '';
        if (!text.trim()) continue;
        const entry = {
          jid: chatJid,
          phone: chatJid.split('@')[0],
          text: text.trim(),
          timestamp: new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString(),
        };
        const dir = path.join(GROUPS_DIR, folder);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          path.join(dir, 'lembrete_respostas.jsonl'),
          JSON.stringify(entry) + '\n',
        );
      } catch (err) {
        logger.warn({ err }, 'captureInboundReplies: failed for a message');
      }
    }
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
    origem?: string,
  ): Promise<void> {
    if (!this.podeSair(jid, 'imagem', origem)) return;
    const fs = await import('fs');
    if (!fs.existsSync(imagePath)) {
      logger.warn({ jid, imagePath }, 'sendImage: file not found');
      return;
    }
    const image = fs.readFileSync(imagePath);
    const msg = {
      image,
      caption: caption || '',
    } as import('@whiskeysockets/baileys').AnyMessageContent;
    if (!this.connected) {
      logger.warn({ jid, imagePath }, 'WA disconnected, image not sent');
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, msg);
      this.rememberSentId(sent?.key?.id);
      this.recordBotSentId(jid, sent?.key?.id);
      this.auditSecondaryDm(jid, 'image', caption || imagePath);
      logger.info({ jid, imagePath }, 'Image sent');
    } catch (err) {
      logger.warn({ jid, imagePath, err }, 'Failed to send image');
    }
  }

  // Resolve o JID canônico do destinatário via onWhatsApp. Corrige mismatch de
  // endereçamento (9º dígito BR, contato LID-primário) que faz o Baileys aceitar
  // o envio e descartá-lo silenciosamente. ESTRITAMENTE ADITIVO: qualquer erro,
  // timeout ou número não-registrado → devolve o jid original (comportamento de
  // antes), pra nunca regredir os envios que já funcionam.
  private async resolveWaJid(jid: string): Promise<string> {
    if (!jid.endsWith('@s.whatsapp.net')) return jid;
    try {
      const number = jid.slice(0, -'@s.whatsapp.net'.length);
      const results = await this.sock.onWhatsApp(number);
      const res = results?.[0];
      if (res?.exists && res.jid) {
        if (res.jid !== jid) {
          logger.info({ original: jid, resolved: res.jid }, 'Resolved WA JID');
        }
        return res.jid;
      }
      logger.warn({ jid }, 'Number not registered on WhatsApp (onWhatsApp)');
      return jid;
    } catch (err) {
      logger.warn({ jid, err }, 'onWhatsApp resolution failed, using original');
      return jid;
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    fileName?: string,
    caption?: string,
    origem?: string,
  ): Promise<void> {
    if (!this.podeSair(jid, 'documento', origem)) return;
    const fs = await import('fs');
    const path = await import('path');
    if (!fs.existsSync(filePath)) {
      logger.warn({ jid, filePath }, 'sendDocument: file not found');
      return;
    }
    const name = fileName || path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    const mimetype =
      ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
    const msg = {
      document: fs.readFileSync(filePath),
      mimetype,
      fileName: name,
      caption: caption || '',
    } as import('@whiskeysockets/baileys').AnyMessageContent;
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'WA disconnected, document not sent');
      return;
    }
    const target = await this.resolveWaJid(jid);
    try {
      const sent = await this.sock.sendMessage(target, msg);
      this.rememberSentId(sent?.key?.id);
      this.recordBotSentId(target, sent?.key?.id);
      this.auditSecondaryDm(target, 'document', caption || name);
      logger.info({ jid, target, filePath }, 'Document sent');
    } catch (err) {
      logger.warn({ jid, target, filePath, err }, 'Failed to send document');
    }
  }

  /**
   * ⛔ Ponto ÚNICO de egresso. Nada sai para um jid sem passar por aqui.
   *
   * Existe por causa de um incidente em produção (20/10/2026): com a observação
   * ligada, 13 mensagens "Só um instante." chegaram a 5 pacientes reais. A
   * política estava num PONTO do fluxo (`index.ts`) e os egressos estavam
   * espalhados antes e depois dele — e três enumerações minhas dos caminhos
   * deram três resultados diferentes.
   *
   * ⚠️ `sendImage`, `sendDocument` e o flush da fila chamavam
   * `sock.sendMessage` DIRETO, sem passar pelo `sendMessage` deste canal. Então
   * travar só o `sendMessage` deixaria imagem, PDF e texto atrasado abertos —
   * foi o achado que derrubou o primeiro desenho.
   */
  /**
   * O conteúdo de texto que vai ao socket, com a geração de preview DESLIGADA.
   *
   * ⛔ `linkPreview` é propriedade do CONTEÚDO, não das opções. Em
   * `generateWAMessageContent`: `let urlInfo = message.linkPreview`, e a
   * geração só roda quando ele é `undefined`. Passar como terceiro argumento do
   * `sendMessage` não teria efeito nenhum — foi o meu primeiro palpite e estava
   * errado.
   *
   * Sem isto o baileys tenta gerar preview para TODO texto com URL, e a Lara
   * manda link em sete lugares: os seis templates de endereço (Google Maps) e o
   * pedido de avaliação. A tentativa falha, porque `link-preview-js` é peer
   * dependency OPCIONAL do baileys e não está instalada — cada falha despejava
   * um `ERR_MODULE_NOT_FOUND` com stack trace inteiro no log, e a mensagem saía
   * sem card de todo jeito.
   *
   * ⚠️ A escolha foi SILENCIAR, não instalar (Thiago, 23/10/2026): instalar
   * faria os cards passarem a aparecer, e isso é mudança no que o paciente vê
   * em template que a Marina aprovou. Para ligar depois: instalar
   * `link-preview-js` e tirar o `linkPreview` daqui.
   */
  private textoParaOSocket(
    text: string,
  ): import('@whiskeysockets/baileys').AnyMessageContent {
    return {
      text,
      linkPreview: null,
    } as unknown as import('@whiskeysockets/baileys').AnyMessageContent;
  }

  private podeSair(
    alvo: string,
    tipo: 'texto' | 'imagem' | 'documento' | 'presenca',
    origem?: string,
  ): boolean {
    const ok = this.opts.podeEntregar?.({ alvo, origem, tipo }) ?? true;
    if (!ok) {
      logger.warn(
        { alvo, tipo, origem: origem ?? 'turno' },
        'egresso: RECUSADO pela política (observação)',
      );
    }
    return ok;
  }

  async sendMessage(
    jid: string,
    text: string,
    origem?: string,
  ): Promise<ResultadoDoEnvio> {
    if (!this.podeSair(jid, 'texto', origem)) return 'recusado';
    // Instância secundária tem número próprio, e ASSISTANT_HAS_OWN_NUMBER diz
    // que o bot tem o dele: nos dois casos fromMe já basta e nada é marcado.
    const prefixed =
      this.opts.groupFolderOwner || ASSISTANT_HAS_OWN_NUMBER
        ? text
        : `${BOT_MARK}${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed, origem });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return 'enfileirado';
    }
    const target = await this.resolveWaJid(jid);
    try {
      const sent = await this.sock.sendMessage(
        target,
        this.textoParaOSocket(prefixed),
      );
      this.rememberSentId(sent?.key?.id);
      this.recordBotSentId(target, sent?.key?.id);
      this.auditSecondaryDm(target, 'text', prefixed);
      logger.info({ jid, target, length: prefixed.length }, 'Message sent');
      return 'enviado';
    } catch (err) {
      this.outgoingQueue.push({ jid, text: prefixed, origem });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
      return 'enfileirado';
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Secondary instances (groupFolderOwner set) are outbound-only — don't claim inbound JIDs
    if (this.opts.groupFolderOwner) return false;
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  ownsGroup(folder: string): boolean {
    return this.opts.groupFolderOwner === folder;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    origem?: string,
  ): Promise<void> {
    // Desligar presença é sempre permitido: não revela atividade, e se algo
    // ligou por engano, desligar é o conserto.
    if (isTyping && !this.podeSair(jid, 'presenca', origem)) return;
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  /**
   * JID de quem mandou, preferindo o telefone ao LID.
   *
   * O WhatsApp passou a endereçar tudo por LID (`195421196562669@lid`), um
   * identificador de privacidade que NÃO é telefone — inclusive em conversa
   * individual. Em 05/10/2026 isso fez a marcação no iClinic recusar o próprio
   * paciente: `agendamento.ts` tirava o "telefone" do JID, o LID virava 15
   * dígitos quaisquer, e a conferência de identidade (nome + nascimento +
   * telefone) batia só no nascimento. O banco mostrava o sintoma de lado:
   * `chat_jid` = `558681512111@s.whatsapp.net` e `sender` = o LID, a mesma
   * pessoa.
   *
   * O telefone vem no próprio stanza: em grupo no `participantAlt`, em conversa
   * individual no `remoteJidAlt` (`decode-wa-message.js`). Esta é a mesma
   * precedência do `getKeyAuthor` do baileys. O `translateJid` fica como
   * segunda tentativa, para quando o servidor não anexa o PN.
   *
   * Pode sobrar um `@lid` mesmo assim — o servidor não garante o `senderAlt`.
   * Isso não é detalhe: quem conferir identidade com esse valor vai recusar
   * gente de verdade, então avisamos no log e `telefoneDoJid` (em
   * `agendamento.ts`) prefere não mandar telefone a mandar número inventado.
   */
  private async senderJid(
    msg: import('@whiskeysockets/baileys').WAMessage,
  ): Promise<string> {
    const alt = msg.key.participantAlt || msg.key.remoteJidAlt;
    if (alt) return alt;

    const bruto = msg.key.participant || msg.key.remoteJid || '';
    if (!bruto) return '';

    const traduzido = await this.translateJid(bruto);
    if (traduzido.endsWith('@lid')) {
      logger.warn(
        { sender: traduzido },
        'Sender ficou em LID: sem telefone, conferência de identidade não fecha',
      );
    }
    return traduzido;
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const target = await this.resolveWaJid(item.jid);
        // ⚠️ Reavalia AQUI, não no enfileiramento: a política pode ter mudado
        // enquanto o item esperava a reconexão, e item atrasado entregue depois
        // é o caso que nenhuma trava no fluxo pega.
        if (!this.podeSair(item.jid, 'texto', item.origem)) continue;
        const sent = await this.sock.sendMessage(
          target,
          this.textoParaOSocket(item.text),
        );
        this.rememberSentId(sent?.key?.id);
        this.recordBotSentId(target, sent?.key?.id);
        this.auditSecondaryDm(target, 'text:queued', item.text);
        logger.info(
          { jid: item.jid, target, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
