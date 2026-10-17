/**
 * Tabela de templates: transforma uma intenção classificada em texto fixo.
 *
 * ## O ponto da arquitetura
 *
 * O modelo faz **uma** coisa, classificar. O texto que o paciente lê sai daqui,
 * e foi lido e aprovado antes de existir. Isso não torna invenção improvável:
 * torna impossível por construção. O modelo não tem como errar um preço se ele
 * nunca escreve o preço.
 *
 * O caminho até aqui justifica o desenho. Em 04/10/2026, com a agente redigindo
 * livremente, o Thiago encontrou ~25 defeitos lendo transcrição, e quase todos
 * eram o modelo preenchendo um buraco: "atende sim" para um plano que só cobre
 * cirurgia, "inclui o exame completo" quando os exames são à parte, "são dois
 * exames" quando há outros fora da clínica, um telefone que não existe.
 *
 * ## O que este módulo NÃO faz
 *
 * Não decide a intenção, não chama modelo e não fala com o WhatsApp. Recebe
 * intenção mais slots e devolve texto, ou diz que é para escalar. Tudo aqui é
 * determinístico e testável sem rede.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export type Acao =
  | 'responder'
  | 'escalar'
  | 'triagem'
  | 'recusar_e_triagem'
  /**
   * Marca no iClinic a oferta que o host registrou, e só então manda o texto.
   * Não existe `remarcar` nem `cancelar`: marcar é aditivo, os outros dois são
   * destrutivos e escalam.
   */
  | 'marcar';

export interface Intencao {
  bloco?: string;
  quando?: string;
  acao: Acao;
  urgente?: boolean;
  fecho?: boolean;
  textos?: string[];
  slots_obrigatorios?: string[];
  /**
   * Texto para quando os `slots_obrigatorios` NÃO puderam ser preenchidos.
   *
   * Existe porque havia resposta aprovada sendo jogada fora. "Tem como marcar
   * no sábado?" é `dia_sem_atendimento`, que pede `dia` e `hora` para emendar
   * o próximo horário livre. Só que a agenda só é consultada quando já se sabe
   * necessidade e convênio — e no começo da conversa não se sabe. Resultado: o
   * render rebaixava e ela escalava, quando tinha um "infelizmente não
   * atendemos sábado" pronto para dar. Quatro cenários da passada 6 caíram
   * aqui, e a clínica recebia caso que não precisava.
   *
   * Opcional de propósito: para `horario_oferta` não existe versão curta
   * aceitável — sem dia e hora não há o que oferecer, e aí escalar é o certo.
   *
   * ⚠️ **A versão curta não pode depender de slot nenhum.** O primeiro texto
   * que escrevi aqui era "Infelizmente {dia_pedido} não temos atendimento", e
   * ela continuou escalando: quando a agenda não dá `dia` e `hora`, em geral o
   * modelo não mandou slot algum, nem `dia_pedido`. O texto caía na checagem
   * seguinte, de slot aberto, e virava DESCONHECIDO do mesmo jeito. Versão
   * curta com chave dentro é versão curta que não serve.
   */
  textos_sem_slot?: string[];
  /**
   * Pendurar o pedido dos dados que faltam depois do texto, em vez de deixar o
   * texto convidar sozinho.
   *
   * Vem da revisão de tom do Thiago (17/10/2026). O documento dele traz 8 dos
   * 12 textos terminando em "Posso verificar os horários disponíveis para
   * você?" — e três coisas batiam nisso: a guarda, que marca pedir permissão
   * para fazer o próprio trabalho; a suíte, na regra `permissao`; e o próprio
   * documento, que em outros dois pontos manda evitar "terminar todas as
   * respostas com perguntas de agendamento" e preferir "Vou verificar para
   * você".
   *
   * Com a emenda, nada disso precisa de exceção: o texto responde e o HOST
   * decide se há abertura para o próximo passo. Quem monta o pedido é a
   * `fraseDeTriagem`, que já pede só o que falta e já abre com "Para eu já ver
   * um horário" — declarativo, como o Thiago pediu.
   *
   * É o mesmo caminho do `recusar_e_triagem`, que existia só para o desconto.
   * A diferença é que ali a emenda era obrigatória e aqui é oportunidade: sai
   * UMA vez por conversa, porque convidar a cada mensagem é o que o documento
   * chama de convite desnecessário.
   */
  emenda_triagem?: boolean;
  /**
   * Como o caso deve chegar à recepção, quando esta intenção escala. Escrito
   * por humano e aprovado, e por isso vale mais que a observação do modelo: é o
   * enquadramento que faz quem atende ver oportunidade em vez de problema. O
   * caso que motivou isto é a cobertura por hospital, que parece um "não" e é
   * uma bifurcação paga.
   */
  motivo_escalada?: string;
}

export interface Tabela {
  intencoes: Record<string, Intencao>;
  _niveis_de_confianca?: { limiar?: number };
}

/** Constantes de negócio. Não vêm do modelo, e mudá-las é editar uma linha. */
export const VALORES: Record<string, string> = {
  valor_consulta: '430,00',
  valor_desconto: '300,00',
};

export const FECHO = 'Ajudo em algo mais?';

const cache = new Map<string, Tabela>();

const ACOES_VALIDAS: ReadonlySet<string> = new Set<Acao>([
  'responder',
  'escalar',
  'triagem',
  'recusar_e_triagem',
  'marcar',
]);

/**
 * Ação desconhecida na tabela vira `escalar`.
 *
 * O carregamento é a fronteira de confiança: `JSON.parse(...) as Tabela` aceita
 * qualquer coisa, e uma intenção com `"acao": "cancelar"` carregaria, renderizaria
 * e devolveria uma ação que nenhum ramo do executor trata — o texto sairia ao
 * paciente sem nada ter sido feito. Checar aqui vale mais que o tipo, porque o
 * tipo protege o chamador compilado e não o arquivo editado por um humano.
 */
function sanitizaAcoes(t: Tabela, groupFolder: string): Tabela {
  for (const [nome, def] of Object.entries(t.intencoes)) {
    if (!ACOES_VALIDAS.has(def.acao)) {
      logger.error(
        { groupFolder, intencao: nome, acao: def.acao },
        'templates: ação desconhecida, rebaixada para escalar',
      );
      def.acao = 'escalar';
    }
  }
  return t;
}

export function carregaTabela(groupFolder: string): Tabela | undefined {
  if (cache.has(groupFolder)) return cache.get(groupFolder);
  try {
    const bruto = fs.readFileSync(
      path.join(GROUPS_DIR, groupFolder, 'templates.json'),
      'utf-8',
    );
    const t = sanitizaAcoes(JSON.parse(bruto) as Tabela, groupFolder);
    cache.set(groupFolder, t);
    return t;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'templates: não carregou a tabela');
    return undefined;
  }
}

/** Zera o cache. Usado pelo teste e após um deploy que mude a tabela. */
export function esqueceTabela(groupFolder?: string): void {
  if (groupFolder) cache.delete(groupFolder);
  else cache.clear();
}

export function limiarDeConfianca(t: Tabela): number {
  return t._niveis_de_confianca?.limiar ?? 0.75;
}

export interface Resultado {
  /** Texto pronto para enviar. Vazio quando a ação é escalar sem fala. */
  texto: string;
  acao: Acao;
  urgente: boolean;
  /** Intenção efetivamente usada: pode ser DESCONHECIDO por rebaixamento. */
  intencao: string;
  /** Por que rebaixou, quando rebaixou. */
  motivo?: string;
  /** `motivo_escalada` da intenção, quando ela define um. */
  motivoEscalada?: string;
}

function preenche(
  texto: string,
  slots: Record<string, string>,
): { texto: string; faltando: string[] } {
  const faltando: string[] = [];
  const cheio = texto.replace(/\{(\w+)\}/g, (_, nome: string) => {
    const v = slots[nome] ?? VALORES[nome];
    if (v === undefined) {
      faltando.push(nome);
      return `{${nome}}`;
    }
    return v;
  });
  return { texto: cheio, faltando };
}

/**
 * Escolhe o texto da intenção e preenche os slots.
 *
 * Rebaixa para DESCONHECIDO (escalar) em qualquer um destes casos, porque todos
 * significam que o sistema não sabe o que dizer:
 *   - intenção fora da tabela
 *   - confiança abaixo do limiar
 *   - slot obrigatório ausente (ex.: oferecer horário sem ter horário)
 *
 * `aleatorio` é injetável para o teste fixar a variante.
 */
export function renderiza(
  tabela: Tabela,
  intencao: string,
  opts: {
    confianca?: number;
    slots?: Record<string, string>;
    aleatorio?: () => number;
  } = {},
): Resultado {
  const { confianca = 1, slots = {}, aleatorio = Math.random } = opts;
  const desconhecido = tabela.intencoes.DESCONHECIDO;
  const escala = (motivo: string): Resultado => ({
    texto: desconhecido?.textos?.[0] ?? 'Só um instante.',
    acao: 'escalar',
    urgente: false,
    intencao: 'DESCONHECIDO',
    motivo,
  });

  const def = tabela.intencoes[intencao];
  if (!def) return escala(`intenção "${intencao}" não está na tabela`);

  const limiar = limiarDeConfianca(tabela);
  if (confianca < limiar) {
    return escala(
      `confiança ${confianca.toFixed(2)} abaixo do limiar ${limiar}`,
    );
  }

  const faltamSlots = (def.slots_obrigatorios ?? []).filter(
    (s) => !slots[s] && !VALORES[s],
  );
  // Sem os slots: usa a versão curta, se a tabela tiver uma. Senão escala —
  // oferecer horário sem dia e hora mandaria "Tenho {dia} às {hora}".
  const semSlot = faltamSlots.length > 0;
  if (semSlot && !(def.textos_sem_slot ?? []).length) {
    return escala(`slot obrigatório ausente: ${faltamSlots.join(', ')}`);
  }

  const opcoes = (semSlot ? def.textos_sem_slot : def.textos) ?? [];
  if (opcoes.length === 0) {
    return {
      texto: '',
      acao: def.acao,
      urgente: def.urgente === true,
      motivoEscalada: def.motivo_escalada,
      intencao,
    };
  }
  const escolhido =
    opcoes[Math.floor(aleatorio() * opcoes.length) % opcoes.length];
  const { texto, faltando } = preenche(escolhido, slots);
  if (faltando.length > 0) {
    return escala(`slot não preenchido no texto: ${faltando.join(', ')}`);
  }

  const comFecho =
    def.fecho === true && def.acao !== 'escalar'
      ? `${texto}\n\n${FECHO}`
      : texto;

  return {
    texto: comFecho,
    acao: def.acao,
    urgente: def.urgente === true,
    motivoEscalada: def.motivo_escalada,
    intencao,
  };
}

/** Lista de intenções válidas, para montar o prompt do classificador. */
export function intencoesValidas(t: Tabela): string[] {
  return Object.keys(t.intencoes).filter((k) => k !== 'DESCONHECIDO');
}
