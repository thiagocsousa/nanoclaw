import { Channel, NewMessage, ResultadoDoEnvio } from './types.js';
import { formatLocalTime } from './timezone.js';
import { idCurto } from './db.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  /**
   * O que já foi tratado, abaixo do cursor. Entra como contexto e sem id.
   * Ver `bloco` e `contextoAnterior` em `db.ts`.
   */
  anteriores: NewMessage[] = [],
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    // ⚠️ `id` existe para o agente poder DEVOLVER qual mensagem ele leu.
    //
    // Sem isso o host consultava a linha mais nova do banco no momento do
    // resultado, e com container vivo uma mensagem nova podia chegar no meio —
    // a intenção velha era executada contra a mensagem nova, e o remetente
    // dela virava o contato da consulta. É curto de propósito: ver
    // `idCurto`/`TAMANHO_DO_ID_CURTO` em db.ts.
    return `<message id="${escapeXml(idCurto(m.id))}" sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}${bloco(anteriores, timezone)}<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * O bloco de histórico: o que explica a pergunta, e que NÃO deve ser respondido.
 *
 * ⛔ Sem `id`, de propósito, e é a trava que importa. `mensagemPorIdCurto` acha
 * a mensagem por sufixo em TODA a conversa, sem piso — se o agente devolvesse o
 * id de uma linha do histórico, o host responderia a uma mensagem velha. Não dar
 * id a elas é o que torna isso estruturalmente impossível: não há o que citar.
 *
 * Bound o resolver pelo cursor seria o conserto errado: ele existe justamente
 * para a corrida em que uma mensagem nova chega com o resultado da anterior em
 * voo, e aí o cursor já andou.
 */
function bloco(anteriores: NewMessage[], timezone: string): string {
  if (anteriores.length === 0) return '';
  const linhas = anteriores.map((m) => {
    const hora = formatLocalTime(m.timestamp, timezone);
    const quem = m.is_bot_message
      ? 'assistente'
      : m.is_from_me
        ? 'clinica'
        : 'paciente';
    return `<anterior de="${quem}" sender="${escapeXml(m.sender_name)}" time="${escapeXml(hora)}">${escapeXml(m.content)}</anterior>`;
  });
  return `<historico_da_conversa nota="contexto do que já foi dito; NÃO responda a estas, elas já foram tratadas">\n${linhas.join('\n')}\n</historico_da_conversa>\n`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<ResultadoDoEnvio> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

export function findChannelForGroup(
  channels: Channel[],
  folder: string,
): Channel | undefined {
  return channels.find((c) => c.ownsGroup?.(folder));
}
