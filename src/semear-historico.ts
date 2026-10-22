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

import fs from 'fs';

import { isBotText } from './config.js';
import type { NewMessage } from './types.js';

/** Um evento do `atendimento_sla.jsonl`. */
export interface EventoSla {
  id?: string;
  jid?: string;
  direction?: string;
  text?: string;
  timestamp?: string;
  push_name?: string;
}

/** Os campos que o filtro prova e o resto do módulo pode usar sem cast. */
type Obrigatorios = { id: string; text: string; timestamp: string };

/**
 * Uma linha pronta para `storeMessage`.
 *
 * ⚠️ DERIVADA de `NewMessage`, não redeclarada: era uma segunda cópia dos
 * mesmos oito campos, e a chamada pagava por isso com um `as never` que
 * desligava a checagem exatamente onde ela importa — nome de campo errado aqui
 * duplicaria a conversa inteira no banco. Se `messages` ganhar coluna, o
 * compilador avisa.
 */
export type MensagemSemeada = Required<
  Pick<
    NewMessage,
    | 'id'
    | 'chat_jid'
    | 'sender'
    | 'sender_name'
    | 'content'
    | 'timestamp'
    | 'is_from_me'
    | 'is_bot_message'
  >
>;

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
 * Os eventos do log de SLA que PODEM ser desta conversa.
 *
 * ⚠️ O recorte por `chatJid` acontece aqui, ANTES do `JSON.parse`, e não só no
 * filtro de `mensagensDoHistorico`. O arquivo tem ~900 KB e ~3.200 eventos de
 * ~200 conversas; parsear tudo para descartar 98% custava ~3 MB de lixo por
 * descoberta de DM, síncrono dentro do handler do WhatsApp — e as descobertas
 * vêm em RAJADA, porque o disparo do lembrete das 15h revela de uma vez toda DM
 * que ainda não estava acompanhada. O `includes` do arquivo inteiro resolve em
 * uma passada o caso mais comum daqui para frente: paciente novo, que não tem
 * nenhum evento no log.
 *
 * É superconjunto, não filtro final: uma linha pode citar o jid no texto. Quem
 * decide é o predicado de `mensagensDoHistorico`.
 */
export function leEventosSla(arquivo: string, chatJid: string): EventoSla[] {
  if (!fs.existsSync(arquivo)) return [];
  const bruto = fs.readFileSync(arquivo, 'utf-8');
  if (!bruto.includes(chatJid)) return [];
  const eventos: EventoSla[] = [];
  for (const linha of bruto.split('\n')) {
    if (!linha.includes(chatJid)) continue;
    try {
      eventos.push(JSON.parse(linha) as EventoSla);
    } catch {
      /* linha torta não impede o resto */
    }
  }
  return eventos;
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
    // ⚠️ Predicado de tipo, e não um `filter` solto: é ele que PROVA `id`,
    // `text` e `timestamp` para o `map` abaixo. Com um filtro comum o `map`
    // precisava reafirmar as três com `as string`, o que é a checagem
    // desligada exatamente onde o dado vem de fora.
    .filter((e): e is EventoSla & Obrigatorios => {
      if (e.jid !== chatJid) return false;
      if (typeof e.id !== 'string' || !e.id) return false;
      if (typeof e.timestamp !== 'string') return false;
      if (typeof e.text !== 'string' || e.text.trim() === '') return false;
      return e.timestamp >= limite.desde && e.timestamp < limite.ate;
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  // Os MAIS RECENTES, e não os primeiros: numa conversa de 150 eventos o que
  // explica "tem algum retorno?" é o fim, não o começo.
  const recortados = daConversa.slice(-limite.maximo);

  return recortados.map((e) => {
    const daClinica = e.direction === 'out';
    // `isBotText` do `config.ts`, e não a mesma comparação escrita de novo: já
    // houve um prefixo antigo (é o que `LEGACY_BOT_PREFIX` registra), e uma
    // cópia aqui deixaria de reconhecer o próximo.
    const doBot = isBotText(e.text);
    return {
      id: e.id,
      chat_jid: chatJid,
      sender: daClinica ? 'clinica' : chatJid,
      sender_name: e.push_name || (daClinica ? 'Atendimento' : chatJid),
      content: e.text,
      timestamp: e.timestamp,
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
