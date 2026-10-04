/**
 * Leitura da saída do classificador.
 *
 * O modelo devolve um JSON numa linha. Este módulo o interpreta e **nunca
 * confia nele**: tudo que vier fora do contrato vira DESCONHECIDO, que escala.
 *
 * Por que a desconfiança é a parte importante: o único jeito de um texto não
 * aprovado chegar ao paciente nesta arquitetura seria o host aceitar um campo
 * inventado. Então o parser rejeita intenção fora da tabela, confiança fora de
 * 0..1, slot que o classificador não tem direito de preencher (dia, hora,
 * valor) e qualquer texto solto que ele tenha escrito junto.
 */
import { logger } from './logger.js';
import { type Tabela, intencoesValidas } from './templates.js';

export interface Classificacao {
  intencao: string;
  confianca: number;
  slots: Record<string, string>;
  observacao?: string;
  /** Por que o parser rebaixou, quando rebaixou. */
  rebaixou?: string;
}

/**
 * Slots que o classificador PODE preencher. Dia, hora e valor ficam de fora de
 * propósito: vêm da agenda e da tabela de preços. Se o modelo mandar um deles,
 * é descartado, porque é exatamente por aí que um preço inventado entraria.
 */
const SLOTS_PERMITIDOS = new Set([
  'nome',
  'nascimento',
  'cidade',
  'convenio',
  'dia_pedido',
  'idade',
  // `necessidade` é CATEGORIA, não valor: "cirurgia refrativa", "catarata",
  // "rotina", "retorno", "exame". Entra na lista porque errá-la não produz uma
  // informação falsa ao paciente, produz um perfil de agenda errado, e aí o
  // script devolve vaga que não serve e o caso escala. Diferente de preço e
  // horário, que o modelo nunca toca.
  'necessidade',
]);

const DESCONHECIDO = (motivo: string): Classificacao => ({
  intencao: 'DESCONHECIDO',
  confianca: 1,
  slots: {},
  rebaixou: motivo,
});

/** Extrai o último objeto JSON da saída, tolerando cerca de código e ruído. */
function achaJson(bruto: string): unknown | undefined {
  const limpo = bruto.replace(/```(?:json)?/gi, '');
  // Varre de trás para frente: se o modelo escreveu algo antes, o JSON é o fim.
  for (const linha of limpo.trim().split('\n').reverse()) {
    const t = linha.trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* tenta a linha anterior */
    }
  }
  // Último recurso: o maior bloco entre a primeira { e a última }
  const i = limpo.indexOf('{');
  const j = limpo.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(limpo.slice(i, j + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function interpreta(bruto: string, tabela: Tabela): Classificacao {
  const obj = achaJson(bruto);
  if (!obj || typeof obj !== 'object') {
    return DESCONHECIDO('saída não é JSON interpretável');
  }
  const o = obj as Record<string, unknown>;

  const intencao = typeof o.intencao === 'string' ? o.intencao.trim() : '';
  if (!intencao) return DESCONHECIDO('sem campo intencao');

  const validas = new Set([...intencoesValidas(tabela), 'DESCONHECIDO']);
  if (!validas.has(intencao)) {
    return DESCONHECIDO(`intenção "${intencao.slice(0, 40)}" não existe`);
  }

  // Tipo antes de valor: Number(null) é 0, que passaria como "confiança zero"
  // em vez de ser rejeitado. Campo malformado morre aqui, e não na camada
  // seguinte por acidente.
  const cru = o.confianca;
  const ehNumero =
    typeof cru === 'number' ||
    (typeof cru === 'string' &&
      cru.trim() !== '' &&
      Number.isFinite(Number(cru)));
  const bruta = ehNumero ? Number(cru) : NaN;
  if (!Number.isFinite(bruta) || bruta < 0 || bruta > 1) {
    return DESCONHECIDO(`confiança inválida: ${JSON.stringify(cru)}`);
  }

  const slots: Record<string, string> = {};
  const recusados: string[] = [];
  if (o.slots && typeof o.slots === 'object') {
    for (const [k, v] of Object.entries(o.slots as Record<string, unknown>)) {
      if (!SLOTS_PERMITIDOS.has(k)) {
        recusados.push(k);
        continue;
      }
      if (typeof v === 'string' && v.trim()) slots[k] = v.trim();
      else if (typeof v === 'number') slots[k] = String(v);
    }
  }
  if (recusados.length > 0) {
    // Não rebaixa: só descarta. O texto ainda vem da tabela, e o slot proibido
    // simplesmente não existe para o renderizador.
    logger.warn(
      { recusados, intencao },
      'classify: classificador tentou preencher slot que não é dele',
    );
  }

  return {
    intencao,
    confianca: bruta,
    slots,
    observacao:
      typeof o.observacao === 'string' && o.observacao.trim()
        ? o.observacao.trim().slice(0, 300)
        : undefined,
  };
}
