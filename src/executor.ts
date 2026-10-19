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
import {
  candidatosLembrados,
  comLembrados,
  contaRepeticao,
  lembraLente,
  lenteLembrada,
  esqueceQuemEra,
  jaConvidou,
  jaPerguntouPaciente,
  lembraCandidatos,
  lembraPacienteConfirmado,
  lembraSlots,
  marcaConvidou,
  marcaPerguntouPaciente,
  pacienteConfirmado,
} from './memoria-conversa.js';
import { pacientesComTelefone, primeiroNome } from './paciente.js';
import { interpreta } from './classify.js';
import {
  SEPARA_MENSAGEM,
  VALORES,
  carregaTabela,
  limiarDeConfianca,
  renderiza,
  type Resultado,
  type Tabela,
} from './templates.js';
import {
  esqueceOferta,
  vagasDaOferta,
  marca,
  type OfertaPendente,
  registraOferta,
  telefoneDoJid,
  ultimaOferta,
} from './agendamento.js';
import { CAMPOS, faltamNaTriagem, fraseDeTriagem } from './triagem.js';
import { resolveDiaPedido } from './dia-pedido.js';
import { contextoDoRetorno } from './retorno-contexto.js';
import { dataLocal } from './expediente.js';
import {
  VOCABULARIO_REFRATIVO,
  ehParticular,
  slotsDasVagas,
  horaPedidaIso,
  vagaEscolhida,
  buscaVagas,
  perfilDe,
  slotsDaVaga,
  soHumano,
  temDescontoDeConsulta,
  type Vaga,
} from './vagas.js';

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
 * A lista de intenções, para o HOST pôr no prompt.
 *
 * ## Por que o host injeta em vez de o agente ler o arquivo
 *
 * O `CLAUDE.md` mandava ler `templates.json`, e em 04/10/2026, no primeiro teste
 * em produção, o agente **não leu**: devolveu `endereco_clinica`, que não existe
 * (o nome é `endereco`), o parser rejeitou e o caso escalou. Ele inventou o nome
 * exatamente como o prompt avisava que aconteceria.
 *
 * Isso também expôs um furo na medição: o avaliador SEMPRE injetava a lista no
 * prompt, então os 92,1% foram medidos com ela e produção não a tinha. Pedir ao
 * modelo que leia um arquivo é depender de ele fazer a coisa certa, que é o que
 * esta arquitetura existe para não fazer. Agora é o host que põe.
 */
export function listaDeIntencoes(groupFolder: string): string | undefined {
  const tabela = carregaTabela(groupFolder);
  if (!tabela) return undefined;
  const linhas = Object.entries(tabela.intencoes)
    .filter(([nome]) => nome !== 'DESCONHECIDO')
    .map(([nome, d]) => `- **${nome}**: ${d.quando ?? ''}`);
  return [
    '## Intenções disponíveis',
    '',
    'Esta é a lista COMPLETA e os nomes são exatos. Nome fora desta lista é',
    'tratado como DESCONHECIDO e escala, então não invente nem abrevie.',
    '',
    ...linhas,
    '- **DESCONHECIDO**: nada acima serve, ou confiança abaixo do limiar',
  ].join('\n');
}

/**
 * Troca a intenção quando o desconto da consulta se aplica.
 *
 * `preco_consulta` e `convenio_nao_atendido` citam R$ 430. Para quem tem
 * intenção de cirurgia E plano não aceito, o valor é R$ 300, e quem sabe disso
 * é o host (ver `temDescontoDeConsulta`). O modelo continua rotulando o que o
 * paciente perguntou; só o texto escolhido muda.
 */
function comDesconto(
  intencao: string,
  slots: Record<string, string | undefined>,
  tabela: Tabela,
): string {
  if (intencao !== 'preco_consulta' && intencao !== 'convenio_nao_atendido') {
    return intencao;
  }
  if (!tabela.intencoes.desconto) return intencao;
  return temDescontoDeConsulta(slots.necessidade, slots.convenio)
    ? 'desconto'
    : intencao;
}

/**
 * Triagem que se completou vira oferta de horário.
 *
 * Decisão do Thiago em 17/10/2026, com as três opções na mesa, depois que a
 * passada 11 reprovou o E08 no turno "Teresina, particular. tem horario?".
 *
 * Aquela mensagem faz as DUAS coisas: entrega os dados que faltavam e pede
 * horário. O classificador rotulou `triagem_dados`, que é defensável, e aí o
 * bloco da agenda não rodava — ele só roda quando a intenção exige `dia` e
 * `hora`. O host tinha os quatro dados e a necessidade na mão e respondia "Só
 * um instante.".
 *
 * É o host decidindo com o que ele SABE, em vez de depender de o rótulo ter
 * caído do lado certo — mesmo arranjo do `comDesconto`. E era a única saída
 * honesta: pedir ao modelo que acertasse o rótulo é devolver a decisão a quem
 * errou.
 *
 * A troca acontece ANTES do bloco da agenda de propósito; depois dele seria
 * trocar o texto sem ter ido buscar a vaga. E retorno/exame continuam
 * protegidos: quem barra é o `soHumano` dentro do bloco, não esta função.
 */
function comOfertaDeHorario(
  intencao: string,
  lembrados: Record<string, string | undefined>,
  tabela: Tabela,
): string {
  if (tabela.intencoes[intencao]?.acao !== 'triagem') return intencao;
  if (!tabela.intencoes.horario_oferta) return intencao;
  if (!lembrados.necessidade?.trim()) return intencao;
  if (faltamNaTriagem(lembrados as Record<string, string>).length > 0) {
    return intencao;
  }
  return 'horario_oferta';
}

/**
 * O valor da avaliação que ESTE paciente paga, em todo texto que o cita.
 *
 * Achado do review do Codex em 17/10/2026, e metade dele é do código que eu
 * acabei de escrever. O `comDesconto` troca a INTENÇÃO quando o desconto se
 * aplica, e isso resolve `preco_consulta` e `convenio_nao_atendido`, que têm um
 * texto de desconto para onde ir. Mas `preco_cirurgia` e
 * `preco_cirurgia_refrativa` também citam `{valor_consulta}` e não têm — então
 * o mesmo paciente, na mesma conversa, ouvia R$ 300 ao perguntar o preço da
 * consulta e R$ 430 ao perguntar o da cirurgia. Sem erro nenhum do
 * classificador, e passando pela guarda.
 *
 * Trocar essas duas pelo texto do desconto perderia a resposta sobre a
 * cirurgia, que é o que foi perguntado. Então o que muda é o VALOR, não o
 * texto: a regra já decidiu que esta pessoa paga R$ 300, e todo texto que cita
 * a avaliação tem de dizer R$ 300.
 *
 * A exceção se reconhece sozinha: um texto que cita os DOIS valores está
 * contrastando-os ("fica R$ 300, em vez de R$ 430"), e sobrescrever ali faria
 * "R$ 300 em vez de R$ 300". Citar só `valor_consulta` é cobrar; citar os dois
 * é comparar.
 */
function comValorDaAvaliacao(
  intencao: string,
  slots: Record<string, string>,
  lembrados: Record<string, string | undefined>,
  tabela: Tabela,
): Record<string, string> {
  if (slots.valor_consulta?.trim()) return slots;
  if (!temDescontoDeConsulta(lembrados.necessidade, lembrados.convenio)) {
    return slots;
  }
  const textos = [
    ...(tabela.intencoes[intencao]?.textos ?? []),
    ...(tabela.intencoes[intencao]?.textos_sem_slot ?? []),
  ].join(' ');
  if (!textos.includes('{valor_consulta}')) return slots;
  if (textos.includes('{valor_desconto}')) return slots;
  return { ...slots, valor_consulta: VALORES.valor_desconto };
}

/**
 * Troca `preco_cirurgia` pelo enquadramento refrativo quando a necessidade já
 * disse que é disso que se trata.
 *
 * Mesmo arranjo do `comDesconto`: o modelo continua rotulando o que o paciente
 * perguntou, e quem escolhe o texto é o host. Existe porque o documento de tom
 * do Thiago (17/10/2026) pede, no item 09, que a resposta de preço reconheça o
 * desejo de diminuir a dependência dos óculos — e, na própria orientação,
 * limita isso a "somente quando o interesse em cirurgia refrativa estiver
 * claro".
 *
 * Sem a troca, o texto refrativo teria de virar variante sorteada de
 * `preco_cirurgia`, que é o que o host faz com textos múltiplos. Aí um
 * paciente de CATARATA ouviria, em metade das vezes, que a cirurgia serve para
 * "diminuir a dependência dos óculos". As duas variantes que existiam ali eram
 * genéricas justamente por isso; nenhuma era de catarata.
 */
function comEnquadramentoRefrativo(
  intencao: string,
  slots: Record<string, string | undefined>,
  tabela: Tabela,
): string {
  if (intencao !== 'preco_cirurgia') return intencao;
  if (!tabela.intencoes.preco_cirurgia_refrativa) return intencao;
  return VOCABULARIO_REFRATIVO.test(slots.necessidade ?? '')
    ? 'preco_cirurgia_refrativa'
    : intencao;
}

/**
 * As trocas de intenção que o host faz antes de renderizar, NA ORDEM.
 *
 * As três têm a mesma assinatura e compõem num só ponto. Estavam aninhadas, o
 * que lia ao contrário da ordem de execução e ganhava um nível por troca nova.
 * Como lista, a ordem é o que se lê, e a quarta é uma linha.
 *
 * ⚠️ Funciona porque os conjuntos de entrada são DISJUNTOS: `comDesconto` olha
 * `preco_consulta`/`convenio_nao_atendido`, `comPlanoParcial` olha
 * `exames_convenio`/`exames_preco`, `comEnquadramentoRefrativo` olha
 * `preco_cirurgia`. Uma troca nova que pegue a saída de outra passa a depender
 * da posição aqui.
 *
 * `comOfertaDeHorario` e `comValorDaAvaliacao` NÃO entram: o primeiro roda antes
 * do bloco da agenda, e o segundo devolve slots, não intenção.
 */
const TROCAS = [comDesconto, comPlanoParcial, comEnquadramentoRefrativo];

/**
 * Planos parciais e a intenção que responde cada um.
 *
 * Os cinco nomes, e qual texto cada um recebe, são UM fato — antes eram dois
 * regexes complementares (a pertinência com os cinco nomes, e o desempate
 * `/IPMT|PLANTE/` escrito como positivo), então o ramo do IASPI significava "um
 * dos nomes que listei acima e não repeti aqui". Acrescentar um sexto plano ao
 * primeiro regex o mandava calado para `convenio_iaspi`.
 *
 * ⚠️ A guarda tem a própria noção disso (`RX_PLANO_PARCIAL_TEXTO`, em
 * `output-guard.ts`), porque lá o que casa é o TEXTO que sai, não o slot
 * `convenio`. São jobs diferentes de propósito; o que elas não podem é discordar
 * sobre QUAIS planos são parciais. Mexendo aqui, olhe lá.
 */
const PLANOS_PARCIAIS: Array<[RegExp, string]> = [
  // IPMT primeiro: um texto com os dois nomes cai em IPMT, como antes.
  [/\b(?:IPMT|PLANTE)\b/i, 'convenio_ipmt'],
  [/\b(?:IASPI|IAPEP|PLAMTA)\b/i, 'convenio_iaspi'],
];

/**
 * Pergunta de EXAME por IASPI/IAPEP/IPMT: responde com o texto do plano.
 *
 * `exames_convenio` fala da Unimed — "os exames não saem pelo convênio" — que
 * é o oposto do que vale nesses três: por eles o exame SAI, e o que não sai é
 * a consulta. Sem a troca, quem tem IASPI ouvia o inverso da verdade.
 *
 * Mesmo arranjo do `comDesconto`: o modelo rotula o que o paciente perguntou e
 * o host escolhe o texto que diz a verdade para ele.
 *
 * ⚠️ MARCAR exame avulso continua escalando, e por regra anterior a esta:
 * `exame` é perfil `soHumano` (PERFIS_SO_HUMANO, em vagas.ts). A distinção que
 * o Thiago fez em 19/10/2026 é essa — a exceção que não pode ser dita ao
 * paciente é sobre a MARCAÇÃO avulsa, não sobre falar de exame. Por algumas
 * horas eu escalei a pergunta também, o que negava ao paciente uma informação
 * que ele pode ter.
 */
function comPlanoParcial(
  intencao: string,
  slots: Record<string, string | undefined>,
  tabela: Tabela,
): string {
  if (intencao !== 'exames_convenio' && intencao !== 'exames_preco') {
    return intencao;
  }
  const conv = slots.convenio ?? '';
  const alvo = PLANOS_PARCIAIS.find(([rx]) => rx.test(conv))?.[1];
  if (!alvo) return intencao;
  return tabela.intencoes[alvo] ? alvo : intencao;
}

/**
 * Dias sem lente de contato antes da avaliação refrativa.
 *
 * Três, para QUALQUER tipo de lente — o manual trazido pelo Thiago separava
 * gelatinosa comum das demais, e a Marina unificou em 19/10/2026. A lente muda
 * o formato da córnea e a medida sai errada; é o único número clínico que a
 * Lara pode dizer, por exceção aprovada no mesmo dia.
 */
const DIAS_SEM_LENTE = 3;

/**
 * "sim" | "nao" | undefined. Undefined é resposta AMBÍGUA, e não libera nada.
 *
 * O slot vinha do modelo como string livre e era gravado literalmente: "às
 * vezes" ou "SIM" passavam pelo teste de presença e falhavam na comparação com
 * 'sim', então a agenda rodava sem prazo nenhum. Achado do Codex, 19/10/2026.
 */
export function normalizaLente(v?: string): 'sim' | 'nao' | undefined {
  const t = (v ?? '').toLowerCase().trim();
  if (!t) return undefined;
  if (/^(n[ãa]o|nao|nunca|jamais|n)\b/.test(t)) return 'nao';
  if (/^(sim|uso|s|positivo|isso|aham|claro)\b/.test(t)) return 'sim';
  if (/\bn[ãa]o\s+uso\b/.test(t)) return 'nao';
  if (/\buso\b/.test(t) && !/\bn[ãa]o\b/.test(t)) return 'sim';
  return undefined;
}

/** A data é cedo demais para quem precisa de 3 dias sem lente? */
function cedoDemaisSemLente(dataIso: string): boolean {
  const [ano, mes, dia] = dataLocal();
  const limite = Date.UTC(ano, mes - 1, dia + DIAS_SEM_LENTE);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dataIso || '');
  if (!m) return false;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) < limite;
}

/** `1980-06-01` -> `01/06/1980`. O iClinic devolve ISO; o resto do fluxo usa BR. */
function isoParaBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Escala com um motivo próprio, devolvendo o texto de DESCONHECIDO. */
async function escalaComo(
  groupFolder: string,
  tabela: Tabela,
  motivo: string,
  pergunta: string,
  deps: EscalationSlaDeps,
  /**
   * O rótulo que o modelo deu, quando existe. Serve só para decidir o SILÊNCIO:
   * se aquela intenção é `sem_resposta`, o paciente não recebe nada.
   *
   * O texto continua sendo o de `DESCONHECIDO` nos outros casos, de propósito —
   * aqui a escalada acontece porque o host NÃO confia no rótulo (confiança
   * abaixo do limiar, agenda que não respondeu, marcação que não saiu), então
   * responder pela intenção suspeita seria pior.
   */
  rotuloSuspeito?: string,
): Promise<SaidaDoExecutor> {
  const r = renderiza(tabela, 'DESCONHECIDO', { confianca: 1, slots: {} });
  const codigo = await escala(
    { folder: groupFolder, motivo, pergunta, urgente: false },
    deps,
  );
  // ⚠️ `sem_resposta` era honrado só na saída de baixo da `executa`, e havia
  // nove escaladas que retornam antes dela. Então "você é um robô?" rotulado com
  // confiança 0,70 escalava por AQUI e o paciente recebia "Só um instante." —
  // exatamente a frase que o Thiago mandou não dizer nesse caso, porque ali ela
  // soa a confissão. O flag virou incondicional em vez de depender da posição.
  //
  // Achado pela revisão de altitude do /simplify em 19/10/2026; o conserto é
  // decisão do Thiago no mesmo dia.
  const calado =
    !!rotuloSuspeito && tabela.intencoes[rotuloSuspeito]?.sem_resposta === true;
  if (calado) {
    logger.info(
      { groupFolder, rotulo: rotuloSuspeito, codigo },
      'executor: escalada calada, o rótulo suspeito é sem_resposta',
    );
  }
  return {
    texto: calado ? '' : r.texto,
    intencao: 'DESCONHECIDO',
    acao: 'escalar',
    codigo,
  };
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
  chatJid: string,
  /**
   * JID de quem ESCREVEU a última mensagem. Em DM é o mesmo que `chatJid`; em
   * grupo, não — e é dele que sai o telefone do paciente. Passar o `chatJid` de
   * um grupo mandava o id do grupo como telefone.
   */
  remetenteJid = '',
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

  // ⚠️ O limiar de confiança é aplicado AQUI, antes de qualquer gravação,
  // consulta ou retorno antecipado.
  //
  // Ele morava só no `renderiza`, no fim da função, e a promessa "classificação
  // abaixo de 0,75 escala" era falsa: no caminho até lá o host já gravava os
  // slots na memória e já chamava `lembraPacienteConfirmado`. Um
  // `paciente_confirmado` com confiança 0,1 fixava o cadastro da conversa, e o
  // ramo do convênio dirigido ainda renderizava com `confianca: 1` e retornava
  // sem escalar — ou seja, o rebaixamento nunca acontecia. Achado do review
  // adversarial do Codex em 17/10/2026.
  //
  // Confiança baixa não é só "não responda com este texto": é "não acredite nos
  // slots". Gravar o que veio num rótulo que não se confia contamina os turnos
  // seguintes, que leem a memória como fato.
  //
  // Os `renderiza(..., { confianca: 1 })` espalhados abaixo continuam em 1 de
  // propósito: aqueles são decisão do HOST, não do modelo, e não têm confiança
  // a medir.
  const limiar = limiarDeConfianca(tabela);
  if (c.intencao !== 'DESCONHECIDO' && c.confianca < limiar) {
    logger.warn(
      { groupFolder, intencao: c.intencao, confianca: c.confianca, limiar },
      'executor: confiança abaixo do limiar, escala sem gravar nada',
    );
    return await escalaComo(
      groupFolder,
      tabela,
      `classificou "${c.intencao}" com confiança ${c.confianca.toFixed(2)}, ` +
        `abaixo do limiar ${limiar}; veja o que o paciente quer`,
      perguntaDoPaciente,
      deps,
      c.intencao,
    );
  }

  // Lente de contato: grava ANTES de qualquer decisão que leia a memória.
  //
  // ⚠️ A primeira versão gravava depois do gate que pergunta da lente, e o
  // resultado era laço: o paciente respondia "não uso lente", o gate consultava
  // a memória ainda vazia e devolvia a MESMA pergunta. Para sempre. Reproduzido
  // pelo review adversarial do Codex em 19/10/2026; meu teste não pegou porque
  // respondia antes de a triagem completar, e aí o gate nem rodava.
  //
  // `normalizaLente` devolve undefined para resposta ambígua ("às vezes", "de
  // vez em quando"): estado desconhecido NÃO libera a agenda, porque liberar
  // sem prazo é mandar a pessoa fazer um exame que não vai prestar.
  const lenteDoTurno =
    c.intencao === 'usa_lente'
      ? 'sim'
      : c.intencao === 'nao_usa_lente'
        ? 'nao'
        : normalizaLente(c.slots.usa_lente);
  if (lenteDoTurno) {
    const antes = lenteLembrada(groupFolder, chatJid);
    lembraLente(groupFolder, chatJid, lenteDoTurno);
    // Mudou para "usa" com oferta viva: a oferta pode ser de amanhã, e os 3
    // dias só valiam para buscas NOVAS. Sem isto, um "pode ser" seguinte marca
    // a vaga que a orientação acabou de proibir.
    if (lenteDoTurno === 'sim' && antes !== 'sim') {
      const o = ultimaOferta(groupFolder, chatJid);
      if (o && cedoDemaisSemLente(o.vaga.data)) {
        logger.info(
          { groupFolder, data: o.vaga.data },
          'executor: passou a usar lente, oferta incompatível descartada',
        );
        esqueceOferta(groupFolder, chatJid);
      }
    }
  }

  // `dia` e `hora` não vêm do modelo, por proibição do parser. Então quando a
  // intenção exige esses slots, é o host que vai à agenda — senão o
  // renderizador rebaixa por slot ausente e NENHUMA oferta de horário seria
  // possível, que era o estado da primeira versão deste arquivo.
  // Guarda o que este turno trouxe ANTES de qualquer decisão que leia a
  // memória: agenda e desconto consultam logo abaixo.
  lembraSlots(groupFolder, chatJid, c.slots);

  // A pessoa respondeu de quem é a consulta.
  //
  // `paciente_confirmado`: os dados vêm do CADASTRO, não do que ela digitou, e
  // guardamos o id para a marcação ir com `--paciente-id`. Sem isso a
  // conferência de três fatores do script compararia o cadastro consigo mesmo.
  //
  // `paciente_outro`: esquece os candidatos. O cadastro do titular não serve
  // para a filha, e deixá-lo na memória faria a próxima pergunta errar de novo.
  if (c.intencao === 'paciente_confirmado' || c.intencao === 'paciente_outro') {
    const { candidatos } = candidatosLembrados(groupFolder, chatJid);
    if (c.intencao === 'paciente_confirmado' && candidatos[0]) {
      const cad = candidatos[0];
      lembraPacienteConfirmado(groupFolder, chatJid, cad.id);
      c.slots = {
        ...c.slots,
        nome: c.slots.nome?.trim() || cad.nome,
        nascimento: c.slots.nascimento?.trim() || isoParaBr(cad.nascimento),
      };
      // A CIDADE também vem do cadastro, quando está preenchida. Costuma estar
      // vazia (a do Thiago está), e aí a triagem pergunta, como antes.
      if (cad.cidade?.trim() && !c.slots.cidade?.trim()) {
        c.slots = { ...c.slots, cidade: cad.cidade.trim() };
      }
      // Guardar, não só usar neste turno: a oferta de horário costuma vir dois
      // turnos depois, quando o modelo já não repete nome nem nascimento. Sem
      // isto a oferta é registrada sem nome e a marcação morre com
      // "faltou: paciente" (E08, 16/10/2026).
      lembraSlots(groupFolder, chatJid, {
        nome: c.slots.nome,
        nascimento: c.slots.nascimento,
      });

      // Convênio do cadastro: pergunta DIRIGIDA em vez de genérica.
      //
      // "O convênio continua sendo Unimed?" responde-se com um sim; "é
      // particular ou convênio?" obriga a pessoa a digitar o nome do plano que
      // a clínica já tem. Escolha do Thiago em 17/10/2026. Confirmar em vez de
      // assumir porque plano muda, e o cadastro pode ter anos.
      //
      // ⚠️ O texto NÃO leva artigo antes do nome do plano, e isso é o mesmo
      // motivo do "de Zulmira" em `triagem.ts`: artigo exige saber o gênero.
      // O Thiago apontou que "Continua pelo Unimed" devia ser "pela Unimed", e
      // está certo — mas `convenio_cadastro` é o campo `health_insurances` do
      // iClinic, que guarda o plano do PACIENTE, não o que a clínica atende.
      // Chega gente com IASPI, IPMT, Intermed, Hapvida e Humana (há template
      // para cada um), e "pela IASPI" erraria igual. Sem artigo acerta sempre.
      if (
        cad.convenio?.trim() &&
        !c.slots.convenio?.trim() &&
        tabela.intencoes.confirma_convenio
      ) {
        const rc = renderiza(tabela, 'confirma_convenio', {
          confianca: 1,
          slots: { ...c.slots, convenio_cadastro: primeiroNome(cad.convenio) },
        });
        if (rc.texto) {
          lembraSlots(groupFolder, chatJid, { convenio: '' });
          logger.info(
            { groupFolder, intencao: 'confirma_convenio' },
            'executor: respondeu por template',
          );
          return {
            texto: rc.texto,
            intencao: 'confirma_convenio',
            acao: 'responder',
          };
        }
      }
    } else {
      // É para outra pessoa: esquece o cadastro inteiro, não só os candidatos.
      // `lembraCandidatos(..., [])` deixava `pacienteId`, nome e nascimento do
      // titular no registro, e a marcação seguinte vinculava a consulta da
      // filha a ele (Codex, 17/10/2026).
      esqueceQuemEra(groupFolder, chatJid);
      // A oferta pendente foi calculada para o perfil do titular e carrega o
      // nome dele. Trocar de paciente sem apagá-la deixaria um "pode ser esse
      // horário" marcar em nome de quem não é.
      esqueceOferta(groupFolder, chatJid);
    }
  }

  // "Sim, continua": o convênio vem do CADASTRO, não do que ela digitou.
  if (c.intencao === 'convenio_confirmado' && !c.slots.convenio?.trim()) {
    const { candidatos } = candidatosLembrados(groupFolder, chatJid);
    const doCadastro = candidatos[0]?.convenio?.trim();
    if (doCadastro) {
      c.slots = { ...c.slots, convenio: doCadastro };
      lembraSlots(groupFolder, chatJid, { convenio: doCadastro });
    }
  }

  // ⚠️ Este bloco vem ANTES da agenda e do render de propósito. Ele estava
  // depois dos dois, então os dados do cadastro chegavam tarde: a oferta era
  // registrada sem nome e a marcação morria com "faltou: paciente".

  let slots = c.slots;
  // A triagem completa passa a pedir horário. Tem de vir antes do bloco abaixo,
  // porque é ele que vai à agenda (ver `comOfertaDeHorario`).
  const completa = comOfertaDeHorario(
    c.intencao,
    comLembrados(groupFolder, chatJid, c.slots),
    tabela,
  );
  if (completa !== c.intencao) {
    logger.info(
      { groupFolder, de: c.intencao, para: completa },
      'executor: triagem completa, host vai à agenda',
    );
    c.intencao = completa;
  }

  // ⚠️ Iniciativa da Lara antes de oferecer horário para avaliação REFRATIVA.
  //
  // Decisão do Thiago em 19/10/2026, confirmada com a Marina: a lente de
  // contato muda o formato da córnea e a medida da avaliação sai errada. São 3
  // dias sem usar, de qualquer tipo.
  //
  // Perguntar por iniciativa custa um turno e evita a viagem perdida: sem
  // isso, a Lara oferece amanhã, a pessoa vem de Picos, faz o exame e o exame
  // não presta. Só na refrativa — catarata e rotina não dependem disso.
  const exigeHorario = (
    tabela.intencoes[c.intencao]?.slots_obrigatorios ?? []
  ).some((x) => x === 'dia' || x === 'hora');
  // ⚠️ Só para quem a Lara de fato agenda, e por DOIS motivos independentes.
  //
  // "Retorno da cirurgia refrativa" casa com o vocabulário refrativo, e um
  // teste já existente pegou a pergunta da lente atrasando um escalonamento que
  // tem de sair na hora.
  //
  // E o motivo clínico, do Thiago em 19/10/2026, que vale mesmo se um dia a
  // Lara passar a agendar retorno: **quem volta de cirurgia refrativa não usa
  // mais lente**. A pergunta não é só inoportuna ali, é sem sentido.
  // Uma leitura para as três perguntas: `comLembrados` vai ao disco
  // (`slots_conversa.json`), e não há escrita entre elas — as três devolviam o
  // mesmo objeto por três leituras. Reler é certo DEPOIS de um `lembraSlots`,
  // que é o motivo de os outros pontos da função relerem; aqui não é o caso.
  const paraLente = comLembrados(groupFolder, chatJid, c.slots);
  const perfilParaLente = perfilDe(paraLente.necessidade, paraLente.convenio);
  if (
    exigeHorario &&
    !!perfilParaLente &&
    !soHumano(perfilParaLente) &&
    VOCABULARIO_REFRATIVO.test(paraLente.necessidade ?? '') &&
    !lenteLembrada(groupFolder, chatJid) &&
    tabela.intencoes.pergunta_lente
  ) {
    const rl = renderiza(tabela, 'pergunta_lente', { confianca: 1, slots });
    if (rl.texto && rl.intencao === 'pergunta_lente') {
      logger.info({ groupFolder }, 'executor: refrativa, perguntando da lente');
      return {
        texto: rl.texto,
        intencao: 'pergunta_lente',
        acao: 'responder',
      };
    }
  }

  let ofertaAOferecer: Omit<OfertaPendente, 'quando'> | undefined;
  // Quando a agenda decide trocar o texto (hoje só o caso do convênio com hora
  // pedida). Fica aqui porque o render acontece bem depois do bloco da agenda.
  let intencaoDaAgenda: string | undefined;
  const exige = tabela.intencoes[c.intencao]?.slots_obrigatorios ?? [];
  if (exige.includes('dia') || exige.includes('hora')) {
    // O perfil sai do que a CONVERSA disse, não só deste turno.
    //
    // Quando criei a memória em 07/10 escopei só ao desconto, escrevendo que
    // aqui "a falha é escalar, que é segura". Era verdade sobre segurança e
    // errado sobre utilidade: o E08 provou em 16/10 que escalar sempre
    // significa que a marcação NUNCA roda. O log mostrou o turno pedindo
    // horário com nome, nascimento, cidade e convênio, sem `necessidade` — e a
    // memória, no mesmo instante, com `necessidade: catarata`.
    //
    // O risco de marcar com convênio velho segue pequeno: o turno atual vence
    // o lembrado e a validade é de 4 horas. Sem isto, não há marcação alguma.
    const paraPerfil = comLembrados(groupFolder, chatJid, c.slots);
    const perfil = perfilDe(paraPerfil.necessidade, paraPerfil.convenio);
    if (perfil && soHumano(perfil)) {
      // Retorno e exame a Lara não agenda (regra do Thiago, 06/10/2026). Escala
      // ANTES de ir à agenda: consultar vaga aqui gastaria 18s para descobrir um
      // horário que ela não pode oferecer.
      logger.info(
        { groupFolder, intencao: c.intencao, perfil },
        'executor: perfil só humano, escala sem consultar a agenda',
      );
      return await escalaComo(
        groupFolder,
        tabela,
        `pedido de ${perfil.startsWith('retorno') ? 'RETORNO' : 'EXAME'}: a Lara não agenda esses dois; veja o que foi solicitado na consulta anterior e responda ao paciente`,
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
    if (!perfil) {
      // "Não rode no chute" (F12): perfil errado é vaga inválida já prometida.
      //
      // Mas se o que falta é SÓ a necessidade, perguntar é melhor que escalar.
      // Isso ficou mais comum quando a abertura deixou de ser menu em
      // 17/10/2026: sem o "1, 2, 3, 4" a necessidade nem sempre vem no
      // primeiro turno, e escalar aí mandaria para a recepção um caso que uma
      // pergunta resolve.
      const faltaSoNecessidade =
        !paraPerfil.necessidade?.trim() && !!paraPerfil.convenio?.trim();
      if (faltaSoNecessidade && tabela.intencoes.pergunta_necessidade) {
        const rn = renderiza(tabela, 'pergunta_necessidade', {
          confianca: 1,
          slots,
        });
        if (rn.texto) {
          logger.info(
            { groupFolder, intencao: c.intencao },
            'executor: falta só a necessidade, pergunta em vez de escalar',
          );
          return {
            texto: rn.texto,
            intencao: 'pergunta_necessidade',
            acao: 'responder',
          };
        }
      }
      logger.info(
        { groupFolder, intencao: c.intencao, slots: c.slots },
        'executor: sem perfil para a agenda, vai escalar',
      );
    } else {
      // O dia pedido vira data de verdade no HOST (ver dia-pedido.ts). Antes
      // de 19/10/2026 só passava o que já estivesse em ISO, e o modelo manda
      // "sexta": o pedido de dia era descartado em silêncio.
      const diaAlvo = resolveDiaPedido(c.slots.dia_pedido);
      // A hora pedida só vale no PARTICULAR (regra do Thiago, 19/10/2026).
      // No convênio a agenda manda, e o host EXPLICA em vez de ignorar.
      const horaAlvo = horaPedidaIso(c.slots.hora_pedida);
      const filtraPelaHora = !!horaAlvo && !!diaAlvo && ehParticular(perfil);
      // 3 dias sem lente antes da avaliação (Marina, 19/10/2026). Vai para o
      // script, que é a fonte única da aritmética de agenda, em vez de filtrar
      // aqui: assim a busca já nasce no primeiro dia possível.
      // ⚠️ Só na refrativa. O "sim" fica na memória da conversa, e sem este
      // recorte ele atrasaria também as buscas de catarata e de rotina, onde o
      // preparo não existe. Achado do Codex, 19/10/2026.
      const antecedencia =
        lenteLembrada(groupFolder, chatJid) === 'sim' &&
        VOCABULARIO_REFRATIVO.test(
          comLembrados(groupFolder, chatJid, c.slots).necessidade ?? '',
        )
          ? DIAS_SEM_LENTE
          : 0;
      let vagas = await buscaVagas(groupFolder, perfil, {
        dia: diaAlvo,
        ...(filtraPelaHora ? { hora: horaAlvo } : {}),
        ...(antecedencia ? { antecedencia } : {}),
      });

      // ⚠️ O filtro duro FABRICAVA escalonamento, e no pior paciente.
      //
      // Com `--hora`, o script devolve a vaga pedida ou NADA (iclinic_vagas.py:
      // "horário ocupado" / "fora da janela"). Zero vagas faz `horario_oferta`
      // rebaixar e escalar — então quem pedia "sexta às 10h" com as 10h
      // ocupadas ouvia "Só um instante.", enquanto quem pedia só "sexta"
      // recebia duas opções. Nomear o horário piorava a resposta, e quem nomeia
      // horário é o paciente mais decidido da fila. Achado da revisão de
      // altitude em 19/10/2026.
      //
      // A segunda busca só roda nesse caso, que é raro, e é o que permite dizer
      // "nesse horário não dá, mas tenho X" em vez de calar.
      let horaNegada = false;
      if (filtraPelaHora && vagas.length === 0) {
        vagas = await buscaVagas(groupFolder, perfil, {
          dia: diaAlvo,
          ...(antecedencia ? { antecedencia } : {}),
        });
        horaNegada = vagas.length > 0;
      }

      // Pediu hora e a oferta NÃO é a hora pedida: aí há o que explicar.
      //
      // A condição antiga não comparava nada, e o convênio que pedia 10h e
      // recebia 10h ouvia "não consigo reservar um horário específico. O que
      // tenho é às 10:00" — negando o que acabava de conceder.
      const naoAtendeuAHora = !!horaAlvo && vagas[0]?.inicio !== horaAlvo;
      const explicaConvenio =
        naoAtendeuAHora && !ehParticular(perfil) && vagas.length > 0;
      // Particular que pediu hora SEM dizer o dia: o script exige os dois, e
      // descartar a hora em silêncio é a falha que `hora_pedida` veio consertar.
      const faltaODia = !!horaAlvo && !diaAlvo && ehParticular(perfil);
      if (faltaODia && tabela.intencoes.pergunta_dia) {
        const rp = renderiza(tabela, 'pergunta_dia', { confianca: 1, slots });
        if (rp.texto && rp.intencao === 'pergunta_dia') {
          logger.info(
            { groupFolder, hora: horaAlvo },
            'executor: hora pedida sem dia, perguntando o dia',
          );
          return {
            texto: rp.texto,
            intencao: 'pergunta_dia',
            acao: 'responder',
          };
        }
      }
      if (vagas.length > 0) {
        // Duas opções quando a agenda deu duas: poupa uma ida e volta se a
        // primeira não servir (manual trazido pelo Thiago, 19/10/2026).
        const oferecidas = vagas.slice(0, 2);
        slots = { ...slots, ...slotsDasVagas(oferecidas) };
        // Guardada para registrar DEPOIS, se o texto realmente for produzido.
        // Registrar aqui gravaria uma oferta que o paciente pode nunca ver —
        // o render ainda pode rebaixar — e aí um "pode ser" marcaria um
        // horário que ele não viu, que é a falha que este módulo impede.
        // Guarda também QUEM é o paciente: no turno do aceite ("pode ser") os
        // slots vêm vazios, e sem isto a marcação recusa por dado faltando.
        if (horaNegada && tabela.intencoes.horario_pedido_indisponivel) {
          logger.info(
            { groupFolder, hora: horaAlvo },
            'executor: hora pedida indisponível, oferecendo alternativa',
          );
          intencaoDaAgenda = 'horario_pedido_indisponivel';
        } else if (
          explicaConvenio &&
          tabela.intencoes.horario_pedido_convenio
        ) {
          logger.info(
            { groupFolder, perfil },
            'executor: hora pedida no convênio, explicando em vez de ignorar',
          );
          intencaoDaAgenda = 'horario_pedido_convenio';
        }
        ofertaAOferecer = {
          vaga: oferecidas[0],
          // As duas, para o aceite poder dizer qual. Sem isto, "pode ser" com
          // duas na mesa marcaria a primeira por omissão — e mandaria a pessoa
          // à clínica no dia errado.
          vagas: oferecidas,
          perfil,
          // Da CONVERSA, não só deste turno: no turno que pede horário o
          // modelo raramente repete nome e nascimento, e eles costumam ter
          // vindo do cadastro dois turnos antes.
          nome: paraPerfil.nome,
          nascimento: paraPerfil.nascimento,
          convenio: paraPerfil.convenio,
        };
      }
    }
  }

  // Aceite de horário: os valores vêm da oferta que o HOST registrou, e entram
  // em `slots` ANTES de renderizar. A primeira versão preenchia depois, com um
  // segundo substituidor — e o `preenche` original, que é a trava contra texto
  // com chave aberta, disparava antes e rebaixava o turno. O caminho inteiro
  // era inalcançável, e nenhum teste cobria.
  const vaiMarcar = tabela.intencoes[c.intencao]?.acao === 'marcar';
  const oferta = vaiMarcar ? ultimaOferta(groupFolder, chatJid) : undefined;
  // O caminho acima impede a oferta de nascer para retorno/exame, então isto é
  // rede: oferta gravada antes da regra, ou perfil que passe a existir depois.
  if (oferta && soHumano(oferta.perfil)) {
    logger.warn(
      { groupFolder, perfil: oferta.perfil },
      'executor: aceite de oferta só humana, não marca',
    );
    return await escalaComo(
      groupFolder,
      tabela,
      `aceitou um horário de ${oferta.perfil}, que a Lara não marca; confirme com o paciente`,
      perguntaDoPaciente,
      deps,
      c.intencao,
    );
  }
  // Qual das vagas ele aceitou?
  //
  // Com uma só, qualquer aceite serve. Com duas, "pode ser" não diz nada — e
  // escolher a primeira por omissão manda a pessoa à clínica no dia errado,
  // que é a mesma classe de erro de marcar no paciente errado. Quando o texto
  // não desambigua, o host PERGUNTA.
  const oferecidas = oferta ? vagasDaOferta(oferta) : [];
  const escolhida = oferta
    ? vagaEscolhida(oferecidas, perguntaDoPaciente)
    : undefined;
  if (vaiMarcar && oferta && !escolhida && oferecidas.length > 1) {
    const rq = renderiza(tabela, 'qual_horario', {
      confianca: 1,
      slots: { ...slots, ...slotsDasVagas(oferecidas) },
    });
    if (rq.texto && rq.intencao === 'qual_horario') {
      logger.info(
        { groupFolder, opcoes: oferecidas.length },
        'executor: aceite não disse qual horário, perguntando',
      );
      return { texto: rq.texto, intencao: 'qual_horario', acao: 'responder' };
    }
  }

  if (vaiMarcar && oferta) {
    slots = {
      ...slots,
      ...slotsDaVaga(escolhida ?? oferta.vaga),
      // `primeiroNome` normaliza a caixa: o cadastro do iClinic guarda em
      // CAIXA ALTA, e sem isto a confirmação saía "Pronto, THIAGO, está
      // agendado" (16/10/2026). Caixa alta soa a grito e não é como a clínica
      // escreve.
      paciente: primeiroNome(oferta.nome ?? c.slots.nome ?? ''),
    };
  }

  const lembrados = comLembrados(groupFolder, chatJid, slots);
  const intencaoFinal = intencaoDaAgenda
    ? intencaoDaAgenda
    : TROCAS.reduce((i, troca) => troca(i, lembrados, tabela), c.intencao);
  const r = renderiza(tabela, intencaoFinal, {
    confianca: c.confianca,
    slots: comValorDaAvaliacao(intencaoFinal, slots, lembrados, tabela),
  });

  // O texto do desconto já recusa o convênio, mas a ação dele é `responder` e
  // isso perderia o pedido dos dados que faltam. Quando o desconto substitui a
  // recusa, mantemos a emenda: o F04 manda não gastar um turno só recusando.
  // ⚠️ As duas decisões abaixo olham `r.intencao`, não `intencaoFinal`.
  //
  // `intencaoFinal` é o que o host PEDIU; `r.intencao` é o que o render
  // ENTREGOU, e ele rebaixa para DESCONHECIDO quando falta slot. Com
  // `intencaoFinal`, a troca pelo desconto forçava `recusar_e_triagem` mesmo
  // sobre um texto rebaixado para escalonamento — o rebaixamento era desfeito
  // de passagem. Achado do review do Codex em 17/10/2026.
  const entregou = r.intencao;
  let acao =
    entregou === intencaoFinal &&
    intencaoFinal !== c.intencao &&
    c.intencao === 'convenio_nao_atendido'
      ? ('recusar_e_triagem' as Resultado['acao'])
      : r.acao;

  // O convite de agendamento é emenda do HOST, não fim de texto (ver
  // `emenda_triagem` em templates.ts). Uma vez por conversa: na primeira é
  // iniciativa, na segunda é a insistência que o documento de tom proíbe.
  //
  // `acao === 'responder'` não é redundante com o `jaConvidou`: o caminho do
  // desconto, logo acima, já forçou `recusar_e_triagem`, e sem essa condição a
  // emenda entraria duas vezes no mesmo texto.
  const convidavel =
    acao === 'responder' &&
    !!tabela.intencoes[entregou]?.emenda_triagem &&
    !jaConvidou(groupFolder, chatJid);

  // COMO convidar depende do quanto a conversa já se comprometeu.
  //
  // Decisão do Thiago em 19/10/2026, depois da análise do manual que ele
  // trouxe de outra IA: "vamos tentar o melhor dos dois". O manual convida com
  // uma pergunta leve e só pede os dados depois do sim; a nossa versão pede os
  // três dados junto com a resposta. A dele tem menos atrito com quem só
  // pesquisava preço; a nossa é mais rápida com quem já quer marcar.
  //
  // O host escolhe pelo que SABE: se a pessoa já deu algum dado PESSOAL (nome,
  // nascimento, cidade, convênio), ela está se identificando, e aí pedir o que
  // falta é o passo útil. Se só sabemos o assunto, ela ainda está pesquisando,
  // e três campos de cara é o que o próprio manual chama de exigir cadastro
  // para informar valor.
  //
  // ⚠️ `necessidade` NÃO conta como compromisso. Ela é preenchida por qualquer
  // pergunta ("quanto custa a catarata?" já define necessidade), e usá-la aqui
  // faria o convite leve nunca acontecer.
  // Usa `faltamNaTriagem`, e não uma lista própria: `CAMPOS` em triagem.ts é a
  // lista única dos quatro dados do formulário. Com uma cópia aqui, mexer lá
  // mudaria o que a Lara PEDE sem mudar o gate que decide se ela pede — e o
  // sintoma seria o convite leve indo para quem já se identificou.
  const seIdentificou =
    faltamNaTriagem(lembrados as Record<string, string>).length < CAMPOS.length;
  const conviteLeve =
    convidavel && !seIdentificou && !!tabela.intencoes.convite_horario;
  if (convidavel && !conviteLeve) {
    acao = 'recusar_e_triagem' as Resultado['acao'];
  }

  // Triagem: pedir só o que falta. O texto da tabela é o formulário de quatro
  // tópicos, que só serve a quem não deu nada ainda; com qualquer dado na mão a
  // frase vira corrida. Pedir de novo o que a pessoa acabou de responder é o
  // jeito mais rápido de parecer máquina.
  let texto = r.texto;

  // ⚠️ A orientação dos 3 dias é EXCEÇÃO à regra de não dar preparo clínico.
  // Escala só quando se SABE que o contexto não é refrativo.
  //
  // As duas metades vêm de instruções diferentes e eu tinha obedecido só uma.
  // O Codex apontou que "minha consulta é de rotina, uso lente, preciso parar?"
  // não está coberto pela exceção — verdade. Eu então exigi contexto refrativo,
  // e isso passou a escalar QUALQUER pergunta direta sobre lente, o que
  // contradiz a regra 2 do Thiago no mesmo dia: "Lara pode dizer, é exceção".
  // Também contradizia a própria tabela, cujo `quando` de `usa_lente` diz "ou
  // pergunta se precisa parar antes da consulta" com ação `responder` — prosa
  // discordando do código, outra vez.
  //
  // O recorte que honra as duas: necessidade REFRATIVA responde, necessidade
  // desconhecida responde (a pessoa perguntou, e a informação é aprovada),
  // necessidade sabidamente OUTRA escala. Saiu na passada 15, no Z05.
  if (c.intencao === 'usa_lente') {
    const n = comLembrados(groupFolder, chatJid, c.slots).necessidade ?? '';
    if (n.trim() && !VOCABULARIO_REFRATIVO.test(n)) {
      return await escalaComo(
        groupFolder,
        tabela,
        'pergunta de preparo com lente de contato FORA da avaliação ' +
          'refrativa; os 3 dias são a exceção aprovada para a refrativa, e ' +
          'preparo de outro contexto é orientação clínica',
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
  }

  // Retorno e exame a Lara não agenda, e a regra vale antes de QUALQUER
  // pergunta — inclusive a de identidade logo abaixo.
  //
  // `soHumano` existia e estava certo, mas só era consultado dentro do bloco da
  // agenda — que roda DEPOIS da triagem. Medido em 19/10/2026, a pedido do
  // Thiago: "quero marcar meu retorno" sem dados virava `triagem_dados`, o
  // paciente digitava nome, nascimento, cidade e convênio, e só então ouvia
  // "Só um instante.". Justamente quem a clínica já tem no cadastro.
  //
  // ⚠️ E a PRIMEIRA versão deste conserto, no mesmo dia, ficou depois do
  // `confirma_paciente` logo abaixo — que dispara com a mesma condição e
  // devolve "é você, Thiago?". O conserto era inalcançável no turno 1
  // justamente para quem tem cadastro, que é toda a população do retorno. O
  // teste passava porque o fixture não tinha candidato nenhum.
  //
  // ⚠️ Só no caminho de `triagem`, que existe para COLETAR e marcar. Em
  // `recusar_e_triagem` a resposta já saiu (preço, convênio) e é aprovada:
  // escalar ali engoliria uma resposta correta. "Quanto custa o retorno?"
  // continua sendo respondido.
  if (acao === 'triagem') {
    const perfilAlvo = perfilDe(lembrados.necessidade, lembrados.convenio);
    if (perfilAlvo && soHumano(perfilAlvo)) {
      // Chega com a resposta pronta: hoje a recepção recebe "quer marcar
      // retorno" e vai procurar no iClinic (Thiago, 19/10/2026).
      //
      // Usa o que a conversa já buscou; só vai ao iClinic se ainda não foi.
      // Custa ~10 s de Playwright, e o paciente está ouvindo "Só um instante"
      // de qualquer jeito.
      const mem = candidatosLembrados(groupFolder, chatJid);
      let cands = mem.candidatos;
      if (!mem.buscou) {
        const tel = telefoneDoJid(remetenteJid || chatJid);
        if (tel) {
          cands = await pacientesComTelefone(groupFolder, tel);
          lembraCandidatos(groupFolder, chatJid, cands);
        }
      }
      const contexto = contextoDoRetorno(cands);
      logger.info(
        { groupFolder, perfil: perfilAlvo, cadastros: cands.length },
        'executor: retorno/exame não passa pelo formulário, escala direto',
      );
      return await escalaComo(
        groupFolder,
        tabela,
        `quer marcar ${perfilAlvo}, que a Lara não agenda` +
          (contexto ? ` · ${contexto}` : '') +
          '; o retorno só é gratuito quando completa a MESMA avaliação, ' +
          'então queixa nova é consulta',
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
  }

  // Antes de pedir os quatro dados: a clínica já conhece este telefone?
  //
  // Trocar o formulário por UMA pergunta é o conserto do "parecer máquina"
  // (Thiago, 04/10/2026). O host NUNCA decide quem é — telefone identifica uma
  // casa, não uma pessoa (medido: um número devolve pai e filha). Ele nomeia o
  // candidato mais velho, que tende a ser o titular, e a pessoa confirma.
  if (
    acao === 'triagem' &&
    !slots.nome?.trim() &&
    tabela.intencoes.confirma_paciente &&
    !jaPerguntouPaciente(groupFolder, chatJid)
  ) {
    const tel = telefoneDoJid(remetenteJid || chatJid);
    const mem = candidatosLembrados(groupFolder, chatJid);
    let candidatos = mem.candidatos;
    if (tel && !mem.buscou) {
      candidatos = await pacientesComTelefone(groupFolder, tel);
      lembraCandidatos(groupFolder, chatJid, candidatos);
    }
    if (candidatos.length > 0) {
      const rc = renderiza(tabela, 'confirma_paciente', {
        confianca: 1,
        slots: { ...slots, paciente: primeiroNome(candidatos[0].nome) },
      });
      if (rc.texto) {
        marcaPerguntouPaciente(groupFolder, chatJid);
        // Loga aqui porque este `return` pula o log do fim da função. Sem
        // isto a pergunta some do log: em 07/10/2026 eu via o turno antes e o
        // depois, e um buraco no meio onde ela tinha falado.
        logger.info(
          {
            groupFolder,
            intencao: 'confirma_paciente',
            acao: 'responder',
            candidatos: candidatos.length,
          },
          'executor: respondeu por template',
        );
        return {
          texto: rc.texto,
          intencao: 'confirma_paciente',
          acao: 'responder',
        };
      }
    }
  }

  if (acao === 'triagem' || acao === 'recusar_e_triagem') {
    const formulario = tabela.intencoes.triagem_dados?.textos?.[0] ?? r.texto;
    // ⚠️ Sobre os dados ACUMULADOS da conversa, não só os deste turno.
    //
    // `slots` é o que o classificador extraiu da mensagem atual, e ele extrai
    // só dela — isso é projeto, não defeito. Então numa conversa em que cada
    // mensagem traz um campo ("Marcos" / "12/03/1980" / "Teresina"), a triagem
    // voltava a pedir o que já havia sido respondido: pedir de novo o que a
    // pessoa acabou de dizer é o jeito mais rápido de parecer máquina, que é
    // exatamente o que esta função existe para evitar.
    //
    // A memória já era consultada para perfil e desconto. Ficar de fora aqui
    // fazia a coleta depender de a LLM reconstruir o formulário inteiro a cada
    // turno — o oposto da separação que esta arquitetura promete. Achado do
    // review do Codex em 17/10/2026.
    let pedido = fraseDeTriagem(comLembrados(groupFolder, chatJid, slots), {
      textoCompleto: formulario,
    });

    // Os quatro dados completos e ainda assim triagem: o que falta é a
    // NECESSIDADE, que não é um dos quatro campos, e quem pergunta isso é o
    // menu da abertura.
    //
    // Antes, `pedido` vinha vazio e o fallback era `r.texto` — o formulário
    // INTEIRO. Na passada 6 (E08) o paciente mandou nome, nascimento, cidade e
    // convênio numa tacada e levou os quatro de volta; nenhuma oferta saiu, e o
    // "pode ser esse horário" seguinte escalou por falta de oferta. O comentário
    // da própria `fraseDeTriagem` já avisava que string vazia significa "não há
    // pergunta a fazer", e era justamente aí que se repetia tudo.
    // Só no caminho de TRIAGEM. Na recusa não: já existe decisão de que, com
    // tudo preenchido, a recusa não pendura pergunta no fim, e emendar o menu
    // ali seria desfazê-la de passagem.
    // ⚠️ A necessidade também vem da CONVERSA, não só deste turno.
    //
    // Eu consertei a `fraseDeTriagem` logo acima para ler a memória (achado 5
    // do Codex) e deixei esta linha vizinha lendo só `slots`. A passada 11
    // cobrou na hora, no E08: o paciente disse "é pra cirurgia de catarata" no
    // turno 2 e, no turno 4, "Teresina, particular. tem horario?" recebeu de
    // volta "Você está procurando cirurgia, ou uma consulta de rotina?" — com
    // `necessidade: catarata` gravado na memória no mesmo instante. Perguntar o
    // que o host já sabe é o defeito que a memória existe para matar.
    if (
      acao === 'triagem' &&
      !pedido &&
      !comLembrados(groupFolder, chatJid, slots).necessidade?.trim()
    ) {
      // Pergunta, não menu. A abertura deixou de listar opções numeradas em
      // 17/10/2026 ("fica muito bot", Thiago), e quem pergunta a necessidade
      // quando ela falta passou a ser este texto.
      pedido = tabela.intencoes.pergunta_necessidade?.textos?.[0] ?? '';
    }

    if (acao === 'triagem') {
      if (!pedido) {
        // Nada a perguntar e ainda assim triagem: é rótulo errado. Escalar é
        // melhor que repetir formulário ou adivinhar o que ele quer.
        return await escalaComo(
          groupFolder,
          tabela,
          'triagem sem nada a perguntar: os quatro dados e a necessidade já vieram; veja o que o paciente quer',
          perguntaDoPaciente,
          deps,
          c.intencao,
        );
      }
      texto = pedido;
    } else {
      // A recusa vem primeiro e o pedido emenda, na mesma mensagem: o F04
      // manda não gastar um turno só perguntando. Sem nada faltando, só a
      // recusa, sem pergunta pendurada no fim.
      // Duas MENSAGENS, não dois parágrafos: a resposta e, em seguida, o
      // pedido dos dados. Ver SEPARA_MENSAGEM em templates.ts.
      texto = [r.texto, pedido].filter(Boolean).join(SEPARA_MENSAGEM);
      // Só conta como convite o que virou pergunta de fato. Sem `pedido` não
      // saiu convite nenhum, e marcar aqui gastaria a única chance da conversa
      // num turno que não convidou.
      if (pedido) marcaConvidou(groupFolder, chatJid);
    }
  }

  // Marcação: o paciente aceitou o horário que o HOST ofereceu e registrou.
  // O modelo não participa disto — ele só disse "ele aceitou".
  if (acao === 'marcar') {
    if (!oferta) {
      // Sem oferta registrada (ou vencida) não há o que marcar, e marcar "o
      // próximo livre" seria marcar algo que o paciente não viu.
      return await escalaComo(
        groupFolder,
        tabela,
        'aceitou um horário, mas não há oferta registrada ou ela venceu; confirme com o paciente',
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
    const res = await marca(groupFolder, {
      operacao: 'marcar',
      // A oferta vem primeiro: ela carrega o que foi coletado na triagem. O
      // turno do aceite normalmente não repete nome nem nascimento.
      paciente: oferta.nome || c.slots.nome || '',
      pedidoPor: remetenteJid || chatJid,
      nascimento: oferta.nascimento ?? c.slots.nascimento,
      convenio: oferta.convenio ?? c.slots.convenio,
      data: (escolhida ?? oferta.vaga).data,
      hora: (escolhida ?? oferta.vaga).inicio,
      perfil: oferta.perfil,
      pacienteId: pacienteConfirmado(groupFolder, chatJid),
    });
    if (!res.ok) {
      logger.warn(
        { groupFolder, motivo: res.motivo, detalhe: res.detalhe },
        'executor: marcação recusada, vai escalar',
      );
      return await escalaComo(
        groupFolder,
        tabela,
        `${r.motivoEscalada ?? 'marcação não saiu'} | ${res.motivo}: ${res.detalhe}`,
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
    // Some com a oferta: um "sim" repetido não deve marcar de novo. A
    // idempotência de `marca()` já cobriria, mas duas travas custam nada.
    esqueceOferta(groupFolder, chatJid);
  }

  // Só agora, com o texto da oferta de fato produzido, o host registra o que
  // ofereceu.
  if (ofertaAOferecer && acao === 'responder') {
    registraOferta(groupFolder, chatJid, ofertaAOferecer);
  }

  // Insistência: a MESMA resposta saindo pela terceira vez.
  //
  // O FAQ manda "escalar: se insistir" em quatro blocos e nada contava.
  // Contar aqui, e não no classificador, é de propósito: insistência não é o
  // paciente escrever parecido, é o host ter escolhido o mesmo texto de novo —
  // ou seja, o texto não resolveu. Isso o host sabe sem a LLM julgar nada.
  //
  // Três, não duas: reformular uma vez é normal, e escalar na segunda mandaria
  // à recepção metade das conversas. Na terceira a resposta pronta já teve duas
  // chances.
  //
  // Conta `responder` E `recusar_e_triagem`. A segunda entrou depois da passada
  // 13: o Q01 repetiu o mesmo texto de preço três vezes e NÃO escalou, porque
  // `preco_cirurgia` tem `emenda_triagem` e o primeiro turno virou
  // `recusar_e_triagem` — que eu não contava. A conta nunca chegava a três.
  //
  // Faz sentido contar: `recusar_e_triagem` é resposta mais pedido, e repetir a
  // mesma RESPOSTA três vezes é insistência, tenha ou não pedido junto.
  //
  // `triagem` pura fica de fora porque repete de propósito enquanto coleta (um
  // campo por mensagem é o caso bom), e marcar e escalar já têm desfecho.
  if (acao === 'responder' || acao === 'recusar_e_triagem') {
    const vezes = contaRepeticao(groupFolder, chatJid, r.intencao);
    if (vezes >= 3) {
      logger.info(
        { groupFolder, intencao: r.intencao, vezes },
        'executor: mesma resposta pela terceira vez, escala',
      );
      return await escalaComo(
        groupFolder,
        tabela,
        `respondeu "${r.intencao}" ${vezes} vezes seguidas e o paciente ` +
          `continua no mesmo assunto; a resposta pronta não está resolvendo`,
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
  }

  // O convite leve é uma SEGUNDA mensagem, como a emenda dos dados: a resposta
  // termina e o convite vem depois, não grudado no fim do parágrafo.
  if (conviteLeve) {
    const t = tabela.intencoes.convite_horario?.textos?.[0];
    if (t) {
      texto = [texto, t].filter(Boolean).join(SEPARA_MENSAGEM);
      marcaConvidou(groupFolder, chatJid);
    }
  }

  // Escalar calado: o caso vai para a recepção e o paciente não recebe nada.
  // Hoje só a pergunta de robô (Thiago, 19/10/2026). Ver `sem_resposta`.
  const calado =
    acao === 'escalar' && !!tabela.intencoes[r.intencao]?.sem_resposta;
  const saida: SaidaDoExecutor = {
    texto: calado ? '' : texto,
    intencao: r.intencao,
    acao,
  };

  if (acao === 'escalar') {
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
      // Quando o host trocou a intenção (desconto), o log tem de mostrar as
      // duas: a que o modelo deu e a que o paciente recebeu.
      intencaoDoModelo: c.intencao !== r.intencao ? c.intencao : undefined,
      acao,
      confianca: c.confianca,
      codigo: saida.codigo,
    },
    'executor: respondeu por template',
  );
  return saida;
}
