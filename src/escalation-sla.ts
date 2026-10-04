/**
 * Escada de cobrança dos escalonamentos.
 *
 * ## O problema
 *
 * `escalar.py` avisa uma vez e pronto. Se ninguém olhar, o paciente espera para
 * sempre e nada acontece: o escalonamento vira um registro num jsonl. Na rodada
 * 1 o agente "escalou" 10 de 10 vezes e a clínica não soube de nenhuma, e a
 * lição ali foi que frase não é ação. A lição aqui é a seguinte: **aviso que não
 * insiste também não é ação.**
 *
 * Regra do Thiago em 04/10/2026:
 *
 *   escalonamento aberto
 *     + 3 min sem baixa  → cobrança no WhatsApp do Thiago
 *     + 5 min sem baixa  → alarme sonoro (ntfy), **só se urgente**
 *
 * O alarme ficou restrito a `--urgente` em 04/10/2026: pedido de atestado e de
 * receita antiga também escalam e são comuns, e alarme que toca por burocracia
 * ensina a clínica a ignorá-lo.
 *
 * Cada degrau dispara **uma vez**. Alarme que repete vira ruído e, em pouco
 * tempo, ninguém olha mais, que é o mesmo fim de não ter alarme.
 *
 * ## Baixa pelo código
 *
 * Cada escalonamento recebe um código curto (ex. `E7K2`) que vai na cobrança.
 * Responder `ok E7K2` dá baixa. É explícito de propósito: dar baixa com
 * "qualquer mensagem sua" desligaria o alarme por acidente numa conversa sobre
 * outro assunto, e um alarme que não toca quando devia é pior que não existir.
 * Funciona igual quando o destino virar o grupo da recepção em produção.
 *
 * ## Por que no host
 *
 * Rodar isso como task agendada custaria um container por minuto. O host já tem
 * o canal para mandar a mensagem, já tem timer, e aqui a precisão é de minuto.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envConfig = readEnvFile([
  'ESCALATION_SLA_FOLDERS',
  'ESCALONAMENTO_JID',
  'ESCALONAMENTO_FOLDER',
  'NTFY_TOPIC',
  'NTFY_SERVIDOR',
]);

function env(key: string, fallback = ''): string {
  return process.env[key] || envConfig[key] || fallback;
}

/** Pastas com escada ligada. Vazio desliga, que é o default. */
const FOLDERS = env('ESCALATION_SLA_FOLDERS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DESTINO_JID = env('ESCALONAMENTO_JID', '558681512111@s.whatsapp.net');
const DESTINO_FOLDER = env('ESCALONAMENTO_FOLDER', 'whatsapp_main');
const NTFY_TOPIC = env('NTFY_TOPIC');
const NTFY_SERVIDOR = env('NTFY_SERVIDOR', 'https://ntfy.sh');

export const COBRANCA_MS = 3 * 60_000;
export const ALARME_MS = 5 * 60_000;
const TICK_MS = 30_000;
const ARQUIVO = 'escalonamentos_pendentes.json';

export interface Pendencia {
  codigo: string;
  /** epoch ms de quando foi escalado */
  quando: number;
  motivo: string;
  pergunta: string;
  urgente?: boolean;
  cobrado?: boolean;
  alarmado?: boolean;
}

function arquivo(folder: string): string {
  return path.join(GROUPS_DIR, folder, ARQUIVO);
}

export function lePendencias(folder: string): Pendencia[] {
  try {
    const dados = JSON.parse(fs.readFileSync(arquivo(folder), 'utf-8'));
    return Array.isArray(dados) ? (dados as Pendencia[]) : [];
  } catch {
    // Arquivo ausente é o caso normal: ninguém escalou ainda.
    return [];
  }
}

function gravaPendencias(folder: string, itens: Pendencia[]): void {
  try {
    const alvo = arquivo(folder);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    const tmp = `${alvo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(itens, null, 2));
    fs.renameSync(tmp, alvo);
  } catch (err) {
    logger.warn({ err, folder }, 'escalation-sla: não gravou pendências');
  }
}

/**
 * Decide o que fazer com uma pendência, dada a idade dela. Função pura, para o
 * teste poder cobrir a escada sem relógio nem rede.
 */
export function proximoDegrau(
  p: Pendencia,
  agora: number,
): 'nada' | 'cobrar' | 'alarmar' {
  const idade = agora - p.quando;
  // O alarme sonoro é SÓ para urgente. Pedido de atestado e de receita antiga
  // também escalam, e são comuns: se cada um tocasse alarme em 5 min, a clínica
  // aprenderia a ignorar o alarme em uma semana, e aí ele não guarda mais nada.
  // Mesmo critério que o escalar.py já aplica ao disparar o ntfy.
  if (p.urgente && idade >= ALARME_MS && !p.alarmado) return 'alarmar';
  if (idade >= COBRANCA_MS && !p.cobrado) return 'cobrar';
  return 'nada';
}

/** Extrai o código de uma mensagem de baixa, ex. "ok E7K2" ou "baixa e7k2". */
export function codigoDaBaixa(texto: string): string | undefined {
  const m = texto
    .trim()
    .match(/^(?:ok|okay|baixa|resolvido|feito)\s+([A-Za-z0-9]{4})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * Dá baixa pelo código, em qualquer pasta configurada. Devolve a pendência
 * baixada, ou undefined se o código não existir (digitação errada, ou baixa
 * repetida).
 */
export function baixaPorCodigo(codigo: string): Pendencia | undefined {
  for (const folder of FOLDERS) {
    const itens = lePendencias(folder);
    const i = itens.findIndex((p) => p.codigo === codigo);
    if (i === -1) continue;
    const [baixada] = itens.splice(i, 1);
    gravaPendencias(folder, itens);
    logger.info(
      { folder, codigo, motivo: baixada.motivo },
      'escalation-sla: baixa dada',
    );
    return baixada;
  }
  return undefined;
}

/** Para onde vai aviso de humano: mesmo destino do escalonamento. */
export function destinoDoAviso(): { jid: string; folder: string } {
  return { jid: DESTINO_JID, folder: DESTINO_FOLDER };
}

/**
 * Só quem recebe a cobrança pode dar baixa. Sem isso, qualquer pessoa num grupo
 * registrado desligaria o alarme digitando "ok XXXX" por acaso.
 */
export function podeDarBaixa(jid: string): boolean {
  return FOLDERS.length > 0 && jid === DESTINO_JID;
}

async function tocaAlarme(): Promise<void> {
  if (!NTFY_TOPIC) {
    logger.warn('escalation-sla: sem NTFY_TOPIC, alarme não disparou');
    return;
  }
  try {
    // ⚠️ ntfy.sh público é servidor de TERCEIRO e o tópico é legível por quem
    // souber o nome. O texto é genérico de propósito: sem nome, sem sintoma,
    // sem telefone, sem código de caso. Quem for atender abre o WhatsApp.
    // Dado de saúde não sai daqui. (Mesma decisão que já está no escalar.py.)
    await fetch(`${NTFY_SERVIDOR.replace(/\/+$/, '')}/${NTFY_TOPIC}`, {
      method: 'POST',
      body: 'Abra o WhatsApp da clinica',
      headers: {
        Title: 'ATENDIMENTO SEM RESPOSTA',
        Priority: 'urgent',
        Tags: 'rotating_light',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Alarme é canal A MAIS: a cobrança no WhatsApp já foi.
    logger.warn({ err }, 'escalation-sla: alarme falhou');
  }
}

// ---------------------------------------------------------------------------
// Abrir o escalonamento, do lado do host
//
// Decisão do Thiago em 04/10/2026: **quem escala é o host.** Até aqui era o
// agente, chamando `escalar.py` dentro do container, e isso tinha um furo que a
// arquitetura de templates existe justamente para fechar: a escalada dependia
// de o modelo lembrar de chamar a ferramenta. Em 03/10 ele "escalou" 10 de 10
// vezes e a clínica não soube de nenhuma.
//
// Com o executor, o host decide pela tabela (`acao: 'escalar'`) e age. Não há
// caminho em que a intenção seja de escalonamento e nada aconteça.
//
// O formato dos arquivos é o MESMO do escalar.py, de propósito: a escada de
// cobrança acima, a auditoria em escalonamentos.jsonl e a baixa por código
// continuam funcionando sem saber quem abriu o caso.

/**
 * Alfabeto do código do caso. Sem 0/O, 1/I/L, 5/S e 2/Z: o código é lido em voz
 * alta e digitado de volta às pressas ("ok E7K2"), então par ambíguo é baixa
 * que não acontece e alarme que toca sem motivo. Igual ao do escalar.py.
 */
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRTUVWXY34679';

function geraCodigo(usados: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) {
      c += ALFABETO_CODIGO[Math.floor(Math.random() * ALFABETO_CODIGO.length)];
    }
    if (!usados.has(c)) return c;
  }
  // 26^4 é folgado para o número de pendências abertas numa clínica; se os 50
  // sorteios colidirem, o relógio desempata em vez de devolver duplicata.
  return `Z${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

export interface PedidoDeEscalada {
  folder: string;
  motivo: string;
  /** O que o paciente escreveu. Vai no aviso ao humano, nunca ao ntfy. */
  pergunta: string;
  urgente?: boolean;
}

/**
 * Abre o escalonamento: pendência, auditoria, aviso ao humano e, se urgente,
 * alarme. Devolve o código do caso, ou undefined se nada pôde ser registrado.
 *
 * A ordem importa. A pendência vem primeiro porque é ela que sustenta a
 * cobrança: um aviso que sai sem pendência é um caso que ninguém cobra se a
 * recepção não vir a mensagem, e foi exatamente esse o furo original.
 */
export async function escala(
  pedido: PedidoDeEscalada,
  deps: EscalationSlaDeps,
): Promise<string | undefined> {
  const { folder, motivo, pergunta } = pedido;
  const urgente = pedido.urgente === true;

  const itens = lePendencias(folder);
  const codigo = geraCodigo(new Set(itens.map((p) => p.codigo)));
  itens.push({ codigo, quando: Date.now(), motivo, pergunta, urgente });
  gravaPendencias(folder, itens);

  // Auditoria: é por aqui que se confere se escalada é ação ou só frase.
  try {
    const log = path.join(GROUPS_DIR, folder, 'escalonamentos.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(
      log,
      `${JSON.stringify({
        quando: new Date().toISOString(),
        codigo,
        motivo,
        pergunta,
        urgente,
        origem: 'host',
      })}\n`,
    );
  } catch (err) {
    logger.warn({ err, folder, codigo }, 'escala: não gravou auditoria');
  }

  const cabecalho = urgente
    ? '🚨 *Atendimento URGENTE*'
    : '🙋 *Atendimento aguardando*';
  const texto =
    `${cabecalho}  \`${codigo}\`\n\n*Motivo:* ${motivo}\n` +
    `*Paciente perguntou:* ${pergunta}\n\n` +
    `Responda *ok ${codigo}* ao resolver. Sem baixa: cobrança em ` +
    `${COBRANCA_MS / 60_000} min, alarme em ${ALARME_MS / 60_000} min.`;

  try {
    await deps.sendMessage(DESTINO_JID, texto, DESTINO_FOLDER);
  } catch (err) {
    // O caso já está registrado e a escada vai cobrar. Perder o aviso imediato
    // é ruim, perder o registro seria pior.
    logger.error({ err, folder, codigo }, 'escala: aviso ao humano não saiu');
  }

  if (urgente) await tocaAlarme();

  logger.info({ folder, codigo, motivo, urgente }, 'escala: caso aberto');
  return codigo;
}

export interface EscalationSlaDeps {
  sendMessage: (
    jid: string,
    text: string,
    groupFolder?: string,
  ) => Promise<unknown> | unknown;
}

/** Roda um tick da escada. Exportado para o teste poder chamar direto. */
export async function tickEscalationSla(
  deps: EscalationSlaDeps,
  agora: number = Date.now(),
): Promise<void> {
  for (const folder of FOLDERS) {
    const itens = lePendencias(folder);
    if (itens.length === 0) continue;
    let mudou = false;

    for (const p of itens) {
      const degrau = proximoDegrau(p, agora);
      if (degrau === 'nada') continue;

      const minutos = Math.floor((agora - p.quando) / 60_000);
      if (degrau === 'cobrar') {
        p.cobrado = true;
        mudou = true;
        await deps.sendMessage(
          DESTINO_JID,
          `⏰ *${p.codigo}* sem baixa há ${minutos} min\n\n` +
            `*Motivo:* ${p.motivo}\n*Paciente perguntou:* ${p.pergunta}\n\n` +
            `Responda *ok ${p.codigo}* para dar baixa.` +
            (p.urgente
              ? ` Em ${Math.ceil(ALARME_MS / 60_000)} min do escalonamento o alarme toca.`
              : ''),
          DESTINO_FOLDER,
        );
        logger.info({ folder, codigo: p.codigo }, 'escalation-sla: cobrado');
      } else {
        // Marca as duas: passar direto para o alarme (processo parado entre os
        // degraus) não deve deixar a cobrança pendente para depois.
        p.alarmado = true;
        p.cobrado = true;
        mudou = true;
        await tocaAlarme();
        logger.warn({ folder, codigo: p.codigo }, 'escalation-sla: alarme');
      }
    }

    if (mudou) gravaPendencias(folder, itens);
  }
}

export function startEscalationSla(deps: EscalationSlaDeps): void {
  if (FOLDERS.length === 0) return;
  logger.info(
    { folders: FOLDERS, cobranca: COBRANCA_MS, alarme: ALARME_MS },
    'escalation-sla: escada de cobrança ativa',
  );
  setInterval(() => {
    tickEscalationSla(deps).catch((err) =>
      logger.warn({ err }, 'escalation-sla: tick falhou'),
    );
  }, TICK_MS);
}
