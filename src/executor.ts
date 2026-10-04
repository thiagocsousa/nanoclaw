/**
 * Executor da tabela de templates: o host escolhe o texto, não o modelo.
 *
 * ## O que muda em relação ao grupo de teste
 *
 * No grupo de teste a Lara redige livremente e a guarda de saída inspeciona o
 * texto depois. Isso pega o que é mecanicamente detectável e **não torna
 * invenção impossível**. Aqui a garantia é outra: o texto que chega ao paciente
 * foi lido e aprovado pela clínica **antes de existir**. O modelo só devolve um
 * rótulo, e um rótulo não pode conter um preço errado.
 *
 * ## Por que o host escala
 *
 * Decisão do Thiago em 04/10/2026. Até aqui a escalada era o agente chamando
 * `escalar.py`, e isso dependia de o modelo lembrar de chamar a ferramenta: em
 * 03/10 ele "escalou" 10 de 10 vezes e a clínica não soube de nenhuma. Com o
 * executor, `acao: 'escalar'` na tabela é o host agindo, e não existe caminho em
 * que a intenção seja de escalonamento e nada aconteça.
 *
 * ## Falha fecha
 *
 * Tudo que dá errado converge para escalonamento, nunca para silêncio nem para
 * texto improvisado: saída que não é JSON, intenção fora da tabela, confiança
 * abaixo do limiar, slot obrigatório ausente. Quem resolve é um humano, e o
 * paciente recebe "Só um instante." em vez de ficar esperando.
 */
import { readEnvFile } from './env.js';
import { escala, type EscalationSlaDeps } from './escalation-sla.js';
import { logger } from './logger.js';
import { interpreta } from './classify.js';
import { carregaTabela, renderiza, type Resultado } from './templates.js';

const envConfig = readEnvFile(['TEMPLATE_FOLDERS']);

const FOLDERS = new Set(
  (process.env.TEMPLATE_FOLDERS || envConfig.TEMPLATE_FOLDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * A pasta responde por tabela, em vez de redigir livre. Fica desligado por
 * padrão: o grupo de teste mede tom e invenção justamente sem templates, e
 * ligar os dois ao mesmo tempo apagaria a medição.
 */
export function wantsTemplates(groupFolder?: string): boolean {
  return !!groupFolder && FOLDERS.has(groupFolder);
}

export interface SaidaDoExecutor {
  /** O que enviar ao paciente. Vazio só se a tabela não tiver texto algum. */
  texto: string;
  intencao: string;
  acao: Resultado['acao'];
  /** Código do caso, quando escalou. */
  codigo?: string;
}

/**
 * Traduz a saída do modelo em texto aprovado, e age quando a ação é escalar.
 *
 * `bruto` é a saída crua do agente, não a limpa: o JSON pode vir cercado de
 * ruído, e é o parser que decide o que é válido.
 */
export async function executa(
  groupFolder: string,
  bruto: string,
  perguntaDoPaciente: string,
  deps: EscalationSlaDeps,
): Promise<SaidaDoExecutor | undefined> {
  const tabela = carregaTabela(groupFolder);
  if (!tabela) {
    // Sem tabela não há como responder por template, e improvisar seria
    // exatamente o que esta arquitetura evita.
    logger.error({ groupFolder }, 'executor: templates.json ausente ou inválido');
    return undefined;
  }

  const c = interpreta(bruto, tabela);
  if (c.rebaixou) {
    logger.warn(
      { groupFolder, motivo: c.rebaixou },
      'executor: saída do modelo rebaixada para DESCONHECIDO',
    );
  }

  const r = renderiza(tabela, c.intencao, {
    confianca: c.confianca,
    slots: c.slots,
  });

  const saida: SaidaDoExecutor = {
    texto: r.texto,
    intencao: r.intencao,
    acao: r.acao,
  };

  if (r.acao === 'escalar') {
    saida.codigo = await escala(
      {
        folder: groupFolder,
        // A observação do classificador é para humano e pode conter o porquê da
        // dúvida, que é o que a recepção precisa ler primeiro.
        motivo: c.observacao || `intenção ${r.intencao}`,
        pergunta: perguntaDoPaciente,
        urgente: r.urgente,
      },
      deps,
    );
  }

  logger.info(
    {
      groupFolder,
      intencao: r.intencao,
      acao: r.acao,
      confianca: c.confianca,
      codigo: saida.codigo,
    },
    'executor: respondeu por template',
  );
  return saida;
}
