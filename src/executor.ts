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
import { buscaVagas, perfilDe, slotsDaVaga } from './vagas.js';

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

/**
 * O script aceita `--dia` só em ISO. O classificador extrai `dia_pedido` como o
 * paciente falou ("sábado", "amanhã"), que não é data, então só repassamos o
 * que já estiver em ISO. O resto vai sem `--dia`, e o script devolve o próximo
 * disponível, que é a resposta certa para "tem vaga?".
 */
function diaIso(dia_pedido?: string): string | undefined {
  return dia_pedido && /^\d{4}-\d{2}-\d{2}$/.test(dia_pedido)
    ? dia_pedido
    : undefined;
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
    logger.error(
      { groupFolder },
      'executor: templates.json ausente ou inválido',
    );
    return undefined;
  }

  const c = interpreta(bruto, tabela);
  if (c.rebaixou) {
    logger.warn(
      { groupFolder, motivo: c.rebaixou },
      'executor: saída do modelo rebaixada para DESCONHECIDO',
    );
  }

  // `dia` e `hora` não vêm do modelo, por proibição do parser. Então quando a
  // intenção exige esses slots, é o host que vai à agenda — senão o
  // renderizador rebaixa por slot ausente e NENHUMA oferta de horário seria
  // possível, que era o estado da primeira versão deste arquivo.
  let slots = c.slots;
  const exige = tabela.intencoes[c.intencao]?.slots_obrigatorios ?? [];
  if (exige.includes('dia') || exige.includes('hora')) {
    const perfil = perfilDe(c.slots.necessidade, c.slots.convenio);
    if (!perfil) {
      // "Não rode no chute" (F12): perfil errado é vaga inválida já prometida.
      logger.info(
        { groupFolder, intencao: c.intencao, slots: c.slots },
        'executor: sem perfil para a agenda, vai escalar',
      );
    } else {
      const vagas = await buscaVagas(groupFolder, perfil, {
        dia: diaIso(c.slots.dia_pedido),
      });
      if (vagas.length > 0) slots = { ...slots, ...slotsDaVaga(vagas[0]) };
    }
  }

  const r = renderiza(tabela, c.intencao, {
    confianca: c.confianca,
    slots,
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
        // O motivo da TABELA vem primeiro: é texto aprovado por humano e é ele
        // que enquadra o caso para quem atende. A observação do modelo entra
        // como detalhe, nunca no lugar do enquadramento.
        motivo:
          [r.motivoEscalada, c.observacao].filter(Boolean).join(' | ') ||
          `intenção ${r.intencao}`,
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
