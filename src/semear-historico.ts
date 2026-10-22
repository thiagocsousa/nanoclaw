/**
 * O passado de uma conversa que começou antes da captura.
 *
 * ⛔ Nasceu de um caso real do primeiro dia útil da semana de observação
 * (22/10/2026). Uma paciente perguntou pela TERCEIRA vez em dois dias se a
 * médica tinha dado retorno sobre o caso dela, e a Lara respondeu a regra do
 * retorno de consulta — "está incluído em até 30 dias". A resposta está certa
 * para a pergunta que ela VIU e errada para a que foi feita: o banco tinha 3
 * mensagens daquela conversa, e a conversa tinha 114.
 *
 * A causa não é defeito: o cursor nasce na mensagem que descobre a DM ("só
 * mensagens novas", Thiago, 19/10/2026), que é o certo para não varrer
 * histórico. O efeito colateral é que toda conversa anterior entra sem passado,
 * e a Lara parece pior justamente nas mais longas — as que já vinham com
 * assunto pendente.
 *
 * A fonte é o `atendimento_sla.jsonl`, que o core já grava passivamente nos
 * DOIS sentidos desde 01/10. Ver `docs/SEMEAR-HISTORICO.md`.
 */

import { BOT_MARK, LEGACY_BOT_PREFIX } from './config.js';

/** Um evento do `atendimento_sla.jsonl`. */
export interface EventoSla {
  id?: string;
  jid?: string;
  direction?: string;
  text?: string;
  timestamp?: string;
  push_name?: string;
}

export interface MensagemSemeada {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
}

export interface LimiteDaSemeadura {
  /** Quantos eventos, no máximo, contados do mais recente. */
  maximo: number;
  /** Nada mais velho que isto. */
  desde: string;
  /**
   * Nada a partir daqui, EXCLUSIVO.
   *
   * ⛔ É o teto que impede a semeadura de engolir a mensagem que descobriu a
   * DM. O `captureSlaTimeline` grava o MESMO lote no log, então o evento atual
   * já está lá: sem o teto, ele entraria no histórico, o cursor ficaria igual
   * ao timestamp dele e `getNewMessages` (que filtra `timestamp > ?`) o
   * excluiria. O paciente seria visto e NÃO respondido — falha silenciosa, do
   * tipo que só aparece quando alguém estranha o silêncio.
   */
  ate: string;
}

/**
 * Converte os eventos de UMA conversa em mensagens, do mais antigo ao mais
 * novo, respeitando o teto.
 *
 * ⚠️ `is_bot_message` é DEDUZIDO da marca invisível, não assumido falso. Parte
 * das mensagens `out` do log são da própria Lara — os "Só um instante." que
 * saíram antes da semana de observação —, e elas carregam o `BOT_MARK`.
 * Gravá-las como humanas faria o histórico atribuir à secretária uma fala do
 * bot, e `getNewMessages` só não as traria de volta por causa de um backstop
 * de conteúdo. Marcar certo não depende de backstop.
 */
export function mensagensDoHistorico(
  eventos: EventoSla[],
  chatJid: string,
  limite: LimiteDaSemeadura,
): MensagemSemeada[] {
  const daConversa = eventos
    .filter(
      (e) =>
        e.jid === chatJid &&
        typeof e.id === 'string' &&
        e.id &&
        typeof e.timestamp === 'string' &&
        typeof e.text === 'string' &&
        e.text.trim() !== '' &&
        e.timestamp >= limite.desde &&
        e.timestamp < limite.ate,
    )
    .sort((a, b) => (a.timestamp! < b.timestamp! ? -1 : 1));

  // Os MAIS RECENTES, e não os primeiros: numa conversa de 150 eventos o que
  // explica "tem algum retorno?" é o fim, não o começo.
  const recortados = daConversa.slice(-limite.maximo);

  return recortados.map((e) => {
    const daClinica = e.direction === 'out';
    const texto = e.text as string;
    const doBot =
      texto.startsWith(BOT_MARK) || texto.startsWith(LEGACY_BOT_PREFIX);
    return {
      id: e.id as string,
      chat_jid: chatJid,
      sender: daClinica ? 'clinica' : chatJid,
      sender_name: e.push_name || (daClinica ? 'Atendimento' : chatJid),
      content: texto,
      timestamp: e.timestamp as string,
      is_from_me: daClinica,
      is_bot_message: doBot,
    };
  });
}

/**
 * O cursor que tem de ser gravado ANTES de inserir qualquer linha.
 *
 * ⛔ É a parte perigosa do plano inteiro. Inserir com o cursor atrás faz o host
 * considerar o histórico todo "novo": o laço monta um prompt com a conversa
 * inteira e RESPONDE. Em observação encheria a fila de lixo; com a Lara
 * assumindo, iria ao paciente.
 *
 * Devolve `undefined` quando não há o que semear — e aí quem chama não deve
 * mexer no cursor, porque o piso de descoberta da DM já é o certo.
 */
export function cursorDepoisDeSemear(
  mensagens: MensagemSemeada[],
): string | undefined {
  if (mensagens.length === 0) return undefined;
  return mensagens[mensagens.length - 1].timestamp;
}
