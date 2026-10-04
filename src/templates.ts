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

export type Acao = 'responder' | 'escalar' | 'triagem' | 'recusar_e_triagem';

export interface Intencao {
  bloco?: string;
  quando?: string;
  acao: Acao;
  urgente?: boolean;
  fecho?: boolean;
  textos?: string[];
  slots_obrigatorios?: string[];
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

export function carregaTabela(groupFolder: string): Tabela | undefined {
  if (cache.has(groupFolder)) return cache.get(groupFolder);
  try {
    const bruto = fs.readFileSync(
      path.join(GROUPS_DIR, groupFolder, 'templates.json'),
      'utf-8',
    );
    const t = JSON.parse(bruto) as Tabela;
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
  if (faltamSlots.length > 0) {
    // Caso concreto: oferecer horário sem ter dia e hora. Melhor escalar que
    // mandar "Tenho {dia} às {hora}".
    return escala(`slot obrigatório ausente: ${faltamSlots.join(', ')}`);
  }

  const opcoes = def.textos ?? [];
  if (opcoes.length === 0) {
    return {
      texto: '',
      acao: def.acao,
      urgente: def.urgente === true,
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
    intencao,
  };
}

/** Lista de intenções válidas, para montar o prompt do classificador. */
export function intencoesValidas(t: Tabela): string[] {
  return Object.keys(t.intencoes).filter((k) => k !== 'DESCONHECIDO');
}
