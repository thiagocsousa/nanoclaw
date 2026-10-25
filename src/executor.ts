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
import { necessidadeMencionada, respostaDoMenu } from './convenio.js';
import {
  SEPARA_MENSAGEM,
  VALORES,
  carregaTabela,
  limiarDeConfianca,
  renderiza,
  soDoHost,
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
import { emObservacao } from './revisao-humana.js';
import { dataLocal } from './expediente.js';
import {
  duasOpcoes,
  VOCABULARIO_REFRATIVO,
  ehParticular,
  slotsDasVagas,
  horaPedidaIso,
  vagaEscolhida,
  vagaNoPeriodo,
  buscaVagas,
  perfilDe,
  periodoPedido,
  necessidadeCirurgica,
  slotsDaVaga,
  soHumano,
  temDescontoDeConsulta,
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
  const temDireito = temDescontoDeConsulta(slots.necessidade, slots.convenio);

  // ⛔ VETO: o modelo rotulou `desconto` e o paciente NÃO tem direito.
  //
  // Esta metade faltava, e custou R$ 130 em produção duas vezes. Eu guardava só
  // a troca PARA desconto — então um `desconto` vindo direto do modelo passava
  // por cima da regra de dinheiro inteira, sem o gate rodar uma vez.
  //
  // Saiu na passada 18, no C01: "Carlos, Teresina, particular, nao tenho plano"
  // perguntou "tem desconto pra quem vai operar?", o modelo rotulou `desconto`
  // (defensável — ele perguntou isso!) e a Lara ofereceu R$ 300,00 a quem paga
  // R$ 430,00. Eu havia "consertado" o C01 duas vezes antes, as duas no
  // `temPlano`, e as duas vezes o gate certo nunca foi chamado.
  //
  // É o ponto cego da arquitetura: "rotular não é preencher", mas aqui o
  // RÓTULO sozinho decidia dinheiro. Agora o host decide, nos dois sentidos.
  if (intencao === 'desconto' && !temDireito) {
    return tabela.intencoes.preco_consulta ? 'preco_consulta' : intencao;
  }

  if (intencao !== 'preco_consulta' && intencao !== 'convenio_nao_atendido') {
    return intencao;
  }
  if (!tabela.intencoes.desconto) return intencao;
  return temDireito ? 'desconto' : intencao;
}

/**
 * ⚠️ Aqui vivia o `comOfertaDeHorario` — "triagem com os QUATRO dados completos
 * vira oferta de horário", decisão do Thiago em 17/10/2026 para o E08.
 *
 * Removido em 21/10/2026, com a inversão da ordem. O que ele fazia passou a ser
 * o caminho normal, e com precondição mais fraca: `triagemVaiAgenda` manda toda
 * triagem à agenda assim que o PERFIL fecha (necessidade e convênio), sem
 * esperar nome, nascimento e cidade. Ou seja, a troca nunca mais seria o que
 * decidia a oferta.
 *
 * E tinha virado defeito: ela promovia a intenção para `horario_oferta`, cujos
 * `slots_obrigatorios` incluem `dia` e `hora`, e isso entra no bloco da agenda
 * IGNORANDO a oferta pendente. No turno em que o paciente mandava nome e
 * nascimento para fechar o aceite, os quatro campos ficavam completos, a troca
 * disparava, e o host gastava outra busca de 18s para reofertar o horário que a
 * pessoa acabara de aceitar. O `!ultimaOferta` do portão novo não alcançava
 * isto, porque a troca acontece antes dele. Medido pelo teste da sequência.
 */

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
 * Qual dos dois planos parciais o PACIENTE nomeou.
 *
 * ⛔ Nasceu de um caso real de 23/10/2026. O paciente escreveu "vcs fazem pelo
 * plamta?" e recebeu o texto do IPMT — "a cirurgia pode ser pelo PLANTE". A
 * tabela está certa: `convenio_iaspi` cobre IASPI/IAPEP/PLAMTA e
 * `convenio_ipmt` cobre IPMT/PLANTE. Quem errou foi o classificador, e é fácil
 * ver por quê: PLAMTA e PLANTE diferem por uma letra no meio e ocupam o MESMO
 * papel nos dois pares — o plano que cobre a cirurgia.
 *
 * Por isso a escolha entre os dois não pode ser do modelo. "Rotular não é
 * preencher": o modelo diz que a pergunta é sobre plano parcial, e o host diz
 * QUAL, lendo o nome na mensagem do paciente. Mesmo arranjo do `comDesconto`.
 *
 * ⚠️ Mensagem que não nomeia plano nenhum (o paciente diz só "e pelo meu
 * convênio?" depois de ter dito o nome antes) mantém o rótulo do modelo: aí ele
 * tem contexto que esta função não tem. O host só corrige quando VÊ o nome.
 */
function corrigePlanoParcial(
  intencao: string,
  perguntaDoPaciente: string,
  tabela: Tabela,
): string {
  if (intencao !== 'convenio_iaspi' && intencao !== 'convenio_ipmt') {
    return intencao;
  }
  const alvo = PLANOS_PARCIAIS.find(([rx]) => rx.test(perguntaDoPaciente))?.[1];
  if (!alvo || alvo === intencao || !tabela.intencoes[alvo]) return intencao;
  logger.info(
    { de: intencao, para: alvo },
    'plano parcial: o host corrigiu o plano pelo texto do paciente',
  );
  return alvo;
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
/**
 * Os campos que a MARCAÇÃO exige, e que por isso são pedidos no aceite.
 *
 * Subconjunto de `CAMPOS`: cidade e convênio ou já vieram antes da oferta, ou
 * não entram em `marca()`. Vive aqui, e não em `triagem.ts`, porque é um
 * requisito do iClinic, não do formulário da clínica.
 */
const CAMPOS_DA_MARCACAO = ['nome', 'nascimento'] as const;

/**
 * Três vezes a mesma coisa é insistência: o host passa o caso à recepção.
 *
 * ⚠️ Função porque eram DUAS implementações com o limiar literal nas duas — a
 * do fim de `executa` e a do pedido de nome e nascimento, que nasceu em
 * 21/10/2026. Mudar a política (o limiar, ou desarmar a oferta ao escalar)
 * exigia achar as duas e notar que divergiam.
 *
 * Contar aqui, e não no classificador, é de propósito: insistência não é o
 * paciente escrever parecido, é o HOST ter escolhido o mesmo texto de novo — ou
 * seja, o texto não resolveu. Isso o host sabe sem a LLM julgar nada.
 *
 * Devolve `undefined` quando ainda não é hora de escalar, e aí quem chamou
 * segue o caminho normal.
 */
const LIMITE_DE_INSISTENCIA = 3;

async function escalaSeInsistiu(
  groupFolder: string,
  tabela: Tabela,
  chave: string,
  motivo: string,
  ctx: {
    perguntaDoPaciente: string;
    deps: EscalationSlaDeps;
    chatJid: string;
    rotulo?: string;
  },
  /** Roda só quando a escalada de fato acontece (ex.: desarmar a oferta). */
  antesDeEscalar?: () => void,
): Promise<SaidaDoExecutor | undefined> {
  const vezes = contaRepeticao(groupFolder, ctx.chatJid, chave);
  if (vezes < LIMITE_DE_INSISTENCIA) return undefined;
  logger.info(
    { groupFolder, chave, vezes },
    'executor: mesma coisa pela terceira vez, escala',
  );
  antesDeEscalar?.();
  return await escalaComo(
    groupFolder,
    tabela,
    motivo,
    ctx.perguntaDoPaciente,
    ctx.deps,
    ctx.rotulo,
  );
}

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
/**
 * O que a Lara precisa perguntar para poder IR À AGENDA.
 *
 * ⚠️ Decisão ÚNICA, usada no bloco da agenda e na emenda da triagem, porque
 * duas cópias divergiriam na hora. Nasceu em 21/10/2026, com a oferta vindo
 * antes da coleta (Thiago: "hoje a gente faz assim" na clínica): o que falta
 * para a agenda é necessidade e convênio, nunca nome e nascimento, que passaram
 * a ser pedidos no aceite.
 *
 * Quando eu apliquei a inversão só no bloco da agenda, a emenda ficou pedindo o
 * nascimento com a frase "Para eu já ver um horário, poderia me informar…" —
 * uma justificativa que a mudança tornou FALSA, porque o host não precisa do
 * nascimento para ver horário nenhum. Daí a função.
 *
 * A cidade não entra no perfil, então nunca é ela que trava a agenda: só decide
 * se a pergunta do convênio vai acompanhada. Quem já disse a cidade não pode
 * ouvir "você é de Teresina?" de novo.
 */
type PerguntaDaAgenda =
  /** Há o que perguntar, e o texto é este. */
  | { tipo: 'pergunta'; texto: string; intencao: string }
  /** O perfil já fecha: não há pergunta a fazer aqui. */
  | { tipo: 'nada' }
  /** Falta dado, mas a tabela do grupo não tem o texto — cai na rede antiga. */
  | { tipo: 'sem_texto' };

function perguntaQueLevaAAgenda(
  tabela: Tabela,
  dados: { necessidade?: string; convenio?: string; cidade?: string },
): PerguntaDaAgenda {
  const semNecessidade = !dados.necessidade?.trim();
  const semConvenio = !dados.convenio?.trim();
  const semCidade = !dados.cidade?.trim();
  // ⚠️ A CIDADE só trava a oferta no cirúrgico (decisão do Thiago, 21/10/2026).
  //
  // Ela não escolhe agenda — `perfilDe` não a usa — e `marca()` não a grava em
  // lugar nenhum. O único uso operacional é o arranjo de mesmo dia para quem
  // vem de fora, e esse só existe na avaliação cirúrgica. Mas aí ele é urgente:
  // descobrir que a pessoa mora em Floriano DEPOIS de prometer um horário
  // obriga a desmarcar, que é o que o `quando` do `pergunta_convenio_cidade` já
  // dizia. Na rotina, perguntar a cidade custaria um turno e não mudaria nada.
  const cidadeTrava = semCidade && necessidadeCirurgica(dados.necessidade);
  // Nada travando: ou o perfil fecha, ou a necessidade não casa com perfil
  // nenhum — e aí perguntar de novo o que ele já disse é o defeito que a
  // memória existe para matar. Quem decide o desfecho é quem chamou.
  if (!semNecessidade && !semConvenio && !cidadeTrava) return { tipo: 'nada' };
  // UMA fonte de texto para as quatro perguntas: a tabela.
  //
  // ⚠️ Até 21/10/2026 os ramos de dois campos liam a tabela e os de um campo
  // COMPUNHAM a frase pelo vocabulário de `triagem.ts`. Duas fontes na mesma
  // decisão, e o sintoma era a voz: a composta dizia "poderia me informar o
  // convênio (ou particular)" e a aprovada diz "Seria por convênio ou
  // particular?". O Thiago decidiu que fica o texto da Marina, então as quatro
  // vêm da tabela — e mexer no texto passa a ser mexer num lugar.
  const nome = semNecessidade
    ? semConvenio
      ? 'pergunta_necessidade_convenio'
      : 'pergunta_necessidade'
    : // Os dois faltando é uma pergunta só, e o texto é da Marina. Vale também
      // fora do cirúrgico: a cidade entra de graça na mesma mensagem, o que
      // não é o mesmo que travar a oferta por ela.
      semConvenio && semCidade
      ? 'pergunta_convenio_cidade'
      : semConvenio
        ? 'pergunta_convenio'
        : 'pergunta_cidade';
  const texto = tabela.intencoes[nome]?.textos?.[0];
  return texto
    ? { tipo: 'pergunta', texto, intencao: nome }
    : { tipo: 'sem_texto' };
}

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

  // ⛔ VETO das intenções SÓ DO HOST.
  //
  // Nove intenções da tabela trazem "NUNCA rotular isto" no `quando`, porque o
  // texto delas pressupõe um estado que só o host conhece. Nada impedia o modelo
  // de emiti-las, e o host renderizava de boa fé — virou laço de agendamento no
  // E08 da passada 18:
  //
  //   LARA: Só para confirmar: quarta, 17:40 ou 18:00?
  //   PAC : a primeira
  //   LARA: Só para confirmar: quarta, 17:40 ou 18:00?
  //
  // O modelo rotulou `qual_horario`, que é compreensível — é o que está
  // acontecendo na conversa — e `vaiMarcar` exige `acao: 'marcar'`, então o
  // `vagaEscolhida` nunca foi chamado. Tentei consertar duas vezes no `quando`
  // do `aceita_horario`; as duas no lugar errado.
  //
  // Mesma classe do veto do desconto, no mesmo dia: o RÓTULO decidindo o que só
  // o host pode decidir.
  if (soDoHost(tabela, c.intencao)) {
    // Se há oferta na mesa e a frase resolve UMA das vagas, isto é aceite — o
    // host sabe disso melhor que o rótulo.
    const pend = ultimaOferta(groupFolder, chatJid);
    const resolve =
      pend && vagaEscolhida(vagasDaOferta(pend), perguntaDoPaciente);
    const alvo =
      resolve && tabela.intencoes.aceita_horario
        ? 'aceita_horario'
        : 'DESCONHECIDO';
    logger.warn(
      { groupFolder, rotulo: c.intencao, alvo },
      'executor: intenção só do host rotulada pelo modelo, vetada',
    );
    c.intencao = alvo;
    c.confianca = 1;
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
  //
  // ⚠️ Antes de gravar, o host preenche `necessidade` quando o paciente
  // mencionou cirurgia e o modelo deixou o slot vazio. Sem isto, "voces fazem
  // cirurgia pelo PLAMTA?" saía R$ 430 e "voces atendem IPMT pra cirurgia de
  // catarata?" saía R$ 300 — a mesma pergunta, dois preços, com a regra do
  // desconto certa nos dois casos. Ver `necessidadeMencionada`, em
  // `convenio.ts`. Decisão do Thiago em 19/10/2026.
  // ⏳ O MENU DA BRUNA, temporário da semana de observação (ver
  // `necessidadeDoMenu`, em convenio.ts). Um "1" sozinho é a escolha de
  // "Avaliação para Cirurgia Refrativa" na resposta automática do WhatsApp
  // Business — e sem esta tradução o modelo vê um número órfão e `DESCONHECIDO`
  // é a classificação certa para o que ELE viu.
  //
  // O host preenche a necessidade e manda para a triagem, que é o passo certo:
  // o paciente já disse o que quer e falta o convênio. Desde 21/10/2026 a
  // triagem ali pergunta o que leva à AGENDA (convênio e cidade), não o
  // cadastro — nome e nascimento só depois de o horário estar na mesa.
  const doMenu = respostaDoMenu(perguntaDoPaciente);
  if (doMenu) {
    // "4 - Outros": o menu não disse o que ele quer, então a Lara PERGUNTA em
    // vez de escalar (Thiago, 19/10/2026) — escalada não gera material para
    // observar, e o texto aprovado existe.
    const alvo = doMenu.intencao ?? 'quer_horario';
    if (tabela.intencoes[alvo]) {
      const jaSabe = comLembrados(groupFolder, chatJid, c.slots).necessidade;
      logger.info(
        { groupFolder, opcao: perguntaDoPaciente.trim(), alvo },
        'menu: número traduzido',
      );
      // ⚠️ Não atropela o que a conversa já estabeleceu: num "1" mandado no
      // meio de uma conversa que já falava de catarata, o que vale é a catarata.
      if (doMenu.necessidade) {
        c.slots = {
          ...c.slots,
          necessidade: jaSabe?.trim() || doMenu.necessidade,
        };
      }
      c.intencao = alvo;
      c.confianca = 1;
    }
  }

  // Lê a memória, não só o slot do turno: senão uma menção nova a cirurgia
  // atropela o "cirurgia refrativa" ou o "retorno" que a conversa já
  // estabeleceu. Achado do Codex em 19/10/2026.
  const necessidadeDita = necessidadeMencionada(
    comLembrados(groupFolder, chatJid, c.slots).necessidade,
    perguntaDoPaciente,
  );
  if (necessidadeDita && necessidadeDita !== c.slots.necessidade) {
    logger.info(
      { groupFolder, necessidade: necessidadeDita },
      'executor: necessidade cirúrgica dita pelo paciente, slot estava vazio',
    );
    c.slots = { ...c.slots, necessidade: necessidadeDita };
  }
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

  // ⚠️ Iniciativa da Lara antes de oferecer horário para avaliação REFRATIVA.
  //
  // Decisão do Thiago em 19/10/2026, confirmada com a Marina: a lente de
  // contato muda o formato da córnea e a medida da avaliação sai errada. São 3
  // dias sem usar, de qualquer tipo.
  //
  // Perguntar por iniciativa custa um turno e evita a viagem perdida: sem
  // isso, a Lara oferece amanhã, a pessoa vem de Picos, faz o exame e o exame
  // não presta. Só na refrativa — catarata e rotina não dependem disso.
  const exige = tabela.intencoes[c.intencao]?.slots_obrigatorios ?? [];
  // ⛔ A OFERTA VEM ANTES DA COLETA (decisão do Thiago, 21/10/2026: "hoje a
  // gente faz assim" na clínica).
  //
  // O que a agenda precisa é só `perfilDe(necessidade, convenio)` — nome,
  // nascimento e cidade NÃO entram na busca. Antes disto o ramo da triagem
  // interceptava e devolvia o formulário de quatro campos, e a oferta só saía
  // depois. Observado em produção no mesmo dia: "Veja a disponibilidade de
  // horário, por favor!" recebeu "Para eu já ver um horário, poderia me
  // informar...".
  //
  // Nome e nascimento passam a ser cobrados no ACEITE, que é quando a marcação
  // de fato precisa deles (ver o ramo `marcar`).
  //
  // ⚠️ O custo, aceito pelo Thiago: mais gente vai ver horário e desaparecer
  // antes de dar nome, e a oferta não bloqueia a vaga na agenda — ela só vence
  // em 30 min. O formulário filtrava quem não estava decidido.
  // ⚠️ Lê a ação da TABELA, não da variável `acao`: ela só é computada 350
  // linhas abaixo, e aqui o que importa é o que a intenção pede.
  const acaoDaTabela = tabela.intencoes[c.intencao]?.acao;
  // ⚠️ OFERTA ANTES DA COLETA (Thiago, 21/10/2026: "hoje a gente faz assim").
  //
  // A triagem passa a ENTRAR na agenda: com perfil, para oferecer horário; sem
  // perfil, para perguntar o que falta para poder oferecer (necessidade,
  // convênio, cidade). Nome e nascimento saem da abertura e passam a ser
  // pedidos no ACEITE, que é o turno em que a marcação precisa deles.
  //
  // `!ultimaOferta` não é detalhe: com uma oferta de pé, o turno que RESPONDE
  // ao pedido de dados ainda chega rotulado como triagem, e sem esta condição o
  // host buscaria a agenda de novo e ofereceria um horário que o paciente
  // acabou de aceitar — a mesma classe do laço de 20/10/2026.
  //
  // ⚠️ E não entra para retorno/exame. Eles escalam de qualquer jeito, mas o
  // caminho de TRIAGEM lá embaixo escala melhor: ele busca os cadastros no
  // iClinic pelo telefone e manda à recepção o contexto do último atendimento
  // mais a regra da gratuidade. Deixar o bloco da agenda interceptar aqui
  // trocava aquele motivo por um genérico — regressão que o teste do retorno
  // pegou na hora.
  // ⚠️ UMA leitura da conversa e UM perfil para o turno INTEIRO.
  //
  // `comLembrados` é `readFileSync` + `JSON.parse` a cada chamada, e depois do
  // último `lembraSlots` (bem acima) nada mais muda o que ela devolve — então
  // toda leitura daqui para baixo devolveria o mesmo objeto. Antes da limpeza
  // de 21/10/2026 eram cinco leituras idênticas e dois `perfilDe` iguais, em
  // quatro nomes diferentes, e o comentário do gate da lente já celebrava a
  // consolidação ("as três devolviam o mesmo objeto") enquanto a duplicata
  // seguia 80 linhas abaixo. Quem precisar de um valor DEPOIS de um
  // `lembraSlots` novo tem de reler explicitamente, e dizer por quê.
  const daConversa = comLembrados(groupFolder, chatJid, c.slots);
  const perfilDaConversa = perfilDe(
    daConversa.necessidade,
    daConversa.convenio,
  );
  // Idem para a oferta pendente: `ultimaOferta` lê `ofertas_pendentes.json`, e
  // entre aqui e o aceite não há gravação nenhuma.
  const pendente = ultimaOferta(groupFolder, chatJid);
  const triagemVaiAgenda =
    acaoDaTabela === 'triagem' &&
    !pendente &&
    !(perfilDaConversa && soHumano(perfilDaConversa));
  // ⚠️ UMA pergunta só: "o host vai à agenda neste turno?".
  //
  // Eram três cópias — o `exigeHorario` do gate da lente, o `if` do bloco da
  // agenda e o `comOfertaDeHorario`. Em 21/10/2026 a terceira saiu e a primeira
  // ficou desatualizada no mesmo instante: `triagem_dados` com o perfil fechado
  // passou a ofertar, e o gate da lente, que só olhava `slots_obrigatorios`,
  // deixou de perguntar da lente antes de oferecer horário para refrativa.
  // Resultado: a Lara oferecia terça para quem precisa de 3 dias sem lente.
  // Três testes pegaram, e a resposta certa não era consertar a cópia.
  const vaiAAgenda =
    exige.includes('dia') || exige.includes('hora') || triagemVaiAgenda;

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
  if (
    vaiAAgenda &&
    !!perfilDaConversa &&
    !soHumano(perfilDaConversa) &&
    VOCABULARIO_REFRATIVO.test(daConversa.necessidade ?? '') &&
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
  /**
   * A intenção que o HOST decidiu, sobrepondo o rótulo do classificador.
   *
   * ⚠️ Chamava-se `intencaoDoHost` e o nome deixou de ser verdade em
   * 21/10/2026: além das trocas do bloco da agenda (o convênio com hora pedida,
   * a oferta antes da coleta), ela passou a carregar também `aceita_horario`,
   * atribuída FORA daquele bloco, pelo turno que completa o aceite. Nome que
   * mente sobre quem escreve é como a próxima sobreposição vai para o lugar
   * errado.
   *
   * Fica aqui, e é lida bem depois, porque o render acontece depois do bloco da
   * agenda — a troca precisa do resultado da busca.
   */
  let intencaoDoHost: string | undefined;
  /**
   * O que falta para a Lara poder IR à agenda, quando falta.
   *
   * ⚠️ Não é um `return` aqui dentro, de propósito. A primeira versão
   * respondia direto do bloco da agenda e passava na frente da confirmação de
   * identidade ("É para você, Thiago, ou para outra pessoa?"), que fica ~550
   * linhas abaixo: quem tinha cadastro no telefone deixava de ser perguntado e
   * ia direto para o convênio. Três testes pegaram, e é a mesma classe do
   * contexto cruzado entre pacientes. Então o bloco só ANOTA, e quem pergunta
   * é o ramo da triagem, que já roda na ordem certa.
   */
  let perguntaParaAgenda:
    | Extract<PerguntaDaAgenda, { tipo: 'pergunta' }>
    | undefined;
  if (vaiAAgenda) {
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
    const perfil = perfilDaConversa;
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
    // ⚠️ UM portão só para "posso ir à agenda?".
    //
    // Até a primeira versão de 21/10/2026 esta pergunta vivia DENTRO do
    // `if (!perfil)`, e isso bastava enquanto o que faltava era necessidade ou
    // convênio — sem eles não há perfil. Quando a cidade entrou na conta
    // (decisão do Thiago no mesmo dia: ela trava a oferta no cirúrgico), a
    // regra ficou inalcançável, porque "catarata + particular" JÁ tem perfil e
    // ia direto ofertar. O teste novo passou sem medir nada.
    //
    // Agora o portão é único: `perguntaQueLevaAAgenda` decide, com perfil ou
    // sem. Sem perfil E sem pergunta é escalonamento ("não rode no chute",
    // F12: perfil errado é vaga inválida já prometida).
    const q = perguntaQueLevaAAgenda(tabela, daConversa);
    if (q.tipo === 'pergunta') {
      logger.info(
        {
          groupFolder,
          intencao: c.intencao,
          pergunta: q.intencao,
          triagemVaiAgenda,
        },
        'executor: falta dado para ir à agenda',
      );
      if (triagemVaiAgenda) {
        // Caminho da TRIAGEM: anota e segue. Ver `perguntaParaAgenda`.
        perguntaParaAgenda = q;
      } else {
        // Caminho de dia/hora: a ação da intenção é `responder`, o ramo da
        // triagem não roda, então é aqui mesmo que a pergunta sai.
        return { texto: q.texto, intencao: q.intencao, acao: 'responder' };
      }
    } else if (!perfil) {
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
      // PERÍODO ("pela manhã", "de tarde"), quando ele não nomeou a hora.
      //
      // A Marina decidiu em 19/10/2026 que a Lara não informa os dias de
      // atendimento. Sem isto, "atende na quarta pela manhã?" recebia "tenho
      // quarta às 17:40": não revela a grade, mas ignora metade da pergunta.
      //
      // Com o período, a resposta passa a ser o `horario_pedido_indisponivel`
      // — "nesse horário não consigo encaixar, mas tenho X" — que responde sem
      // dizer POR QUE não dá, que é exatamente o recorte que ela pediu.
      const periodo = horaAlvo
        ? undefined
        : (periodoPedido(c.slots.hora_pedida) ??
          periodoPedido(perguntaDoPaciente));
      // 3 dias sem lente antes da avaliação (Marina, 19/10/2026). Vai para o
      // script, que é a fonte única da aritmética de agenda, em vez de filtrar
      // aqui: assim a busca já nasce no primeiro dia possível.
      // ⚠️ Só na refrativa. O "sim" fica na memória da conversa, e sem este
      // recorte ele atrasaria também as buscas de catarata e de rotina, onde o
      // preparo não existe. Achado do Codex, 19/10/2026.
      const antecedencia =
        lenteLembrada(groupFolder, chatJid) === 'sim' &&
        VOCABULARIO_REFRATIVO.test(daConversa.necessidade ?? '')
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

      // Período pedido: filtra o que a agenda deu. Se sobrar vazio, o `horaNegada`
      // abaixo é o que produz "nesse horário não consigo encaixar, mas tenho X".
      let periodoNegado = false;
      if (periodo && vagas.length > 0) {
        // ⚠️ Decide DENTRO do dia pedido, quando ele pediu um dia.
        //
        // Filtrar a lista inteira pelo período derrubava o dia pedido e ficava
        // com outro que casasse: quem perguntou "quarta pela manhã" recebia
        // "sexta, às 09:20" sem nenhuma explicação de que a quarta não deu.
        // Achado medindo a saída real, depois de o Thiago apontar que eu tinha
        // composto um exemplo à mão em vez de medir.
        const doDia = diaAlvo ? vagas.filter((v) => v.data === diaAlvo) : vagas;
        const noPeriodo = doDia.filter((v) => vagaNoPeriodo(v, periodo));
        if (noPeriodo.length > 0) {
          vagas = noPeriodo;
        } else {
          // Nada no período pedido: o `horario_pedido_indisponivel` abaixo diz
          // "não consigo encaixar, mas tenho X" — sem dizer POR QUE não dá.
          periodoNegado = true;
          logger.info(
            { groupFolder, periodo, dia: diaAlvo, vagas: vagas.length },
            'executor: período pedido sem vaga, oferecendo o que existe',
          );
        }
      }

      // Terceira busca: o DIA inteiro não serve, não só a hora.
      //
      // O W03 saiu assim na passada 16: Unimed pedindo "sexta às 10h", e a
      // sexta estava dentro dos 7 dias de antecedência do convênio. As duas
      // buscas acima voltaram vazias — a primeira com dia+hora, a segunda com o
      // dia — e o host escalou, mandando "Só um instante." a quem nomeou dia e
      // hora, o paciente mais decidido da fila.
      //
      // `horario_pedido_indisponivel` já existe e diz exatamente isto: "nesse
      // horário eu não consigo encaixar, mas tenho {dia} às {hora}". Faltava
      // procurar o que oferecer. Mesmo raciocínio da segunda busca, um degrau
      // acima: solta o dia também.
      if (diaAlvo && vagas.length === 0) {
        vagas = await buscaVagas(groupFolder, perfil, {
          ...(antecedencia ? { antecedencia } : {}),
        });
        if (vagas.length > 0) {
          horaNegada = true;
          logger.info(
            { groupFolder, dia: diaAlvo, perfil },
            'executor: dia pedido não serve, oferecendo o próximo que serve',
          );
        }
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
        // Duas opções em DIAS DISTINTOS (Thiago, 19/10/2026): "as duas opções
        // disponíveis de horários deveriam ser em dias distintos". Ver
        // `duasOpcoes`, em vagas.ts — o fallback para o mesmo dia está lá.
        const oferecidas = duasOpcoes(vagas);
        slots = { ...slots, ...slotsDasVagas(oferecidas) };
        // Guardada para registrar DEPOIS, se o texto realmente for produzido.
        // Registrar aqui gravaria uma oferta que o paciente pode nunca ver —
        // o render ainda pode rebaixar — e aí um "pode ser" marcaria um
        // horário que ele não viu, que é a falha que este módulo impede.
        // Guarda também QUEM é o paciente: no turno do aceite ("pode ser") os
        // slots vêm vazios, e sem isto a marcação recusa por dado faltando.
        if (
          (horaNegada || periodoNegado) &&
          tabela.intencoes.horario_pedido_indisponivel
        ) {
          logger.info(
            { groupFolder, hora: horaAlvo },
            'executor: hora pedida indisponível, oferecendo alternativa',
          );
          intencaoDoHost = 'horario_pedido_indisponivel';
        } else if (
          explicaConvenio &&
          tabela.intencoes.horario_pedido_convenio
        ) {
          logger.info(
            { groupFolder, perfil },
            'executor: hora pedida no convênio, explicando em vez de ignorar',
          );
          intencaoDoHost = 'horario_pedido_convenio';
        } else if (triagemVaiAgenda && tabela.intencoes.horario_oferta) {
          // A intenção que chegou é de triagem, e sem esta troca o bloco acima
          // monta a oferta e o texto final volta a pedir nome: o host tinha o
          // horário na mão e perguntava dado.
          logger.info(
            { groupFolder, intencao: c.intencao, perfil },
            'executor: perfil conhecido, oferece horário antes de coletar dados',
          );
          intencaoDoHost = 'horario_oferta';
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
          nome: daConversa.nome,
          nascimento: daConversa.nascimento,
          convenio: daConversa.convenio,
        };
      }
    }
  }

  // Aceite de horário: os valores vêm da oferta que o HOST registrou, e entram
  // em `slots` ANTES de renderizar. A primeira versão preenchia depois, com um
  // segundo substituidor — e o `preenche` original, que é a trava contra texto
  // com chave aberta, disparava antes e rebaixava o turno. O caminho inteiro
  // era inalcançável, e nenhum teste cobria.
  // O turno que COMPLETA o aceite.
  //
  // Com a oferta vindo antes da coleta, o aceite ("pode ser esse") chega sem
  // nome nem nascimento, e o host os PEDE. A resposta — "Thiago Costa,
  // 01/06/1980" — volta rotulada `triagem_dados`, não `aceita_horario`: para o
  // classificador ela é cadastro, e está certo. Quem sabe que aquilo fecha uma
  // marcação é o host, porque foi ele que perguntou.
  //
  // ⚠️ Exige `aguardaDados`, e não só "tem oferta pendente": sem a marca, um
  // "qual o endereço?" com nome e nascimento na memória marcaria consulta.
  //
  // ⚠️ `cadastro` existe para a precedência "a oferta vence a memória" ser
  // escrita UMA vez. Ela estava em três cópias — aqui, no pedido de nome e
  // nascimento e na carga de `marca()` —, e uma delas usava `||` onde as outras
  // usavam `??`. Quem fosse inverter a precedência tinha de achar as três e
  // notar que uma era diferente. Quem diz o que falta é `faltamNaTriagem`, a
  // função que responde exatamente isso e que este mesmo diff estendeu com o
  // parâmetro dos campos.
  const cadastro = {
    nome: (pendente?.nome ?? daConversa.nome ?? '').trim(),
    nascimento: (pendente?.nascimento ?? daConversa.nascimento ?? '').trim(),
  };
  const faltaCadastro = faltamNaTriagem(cadastro, CAMPOS_DA_MARCACAO);
  /**
   * Este turno é a RESPOSTA ao pedido de cadastro?
   *
   * ⚠️ Entrou em 21/10/2026, do review adversarial do Codex, e o defeito era
   * meu: eu tratava a oferta marcada como ativa só quando os DOIS campos
   * chegavam. Com o cadastro em duas mensagens — que é como as pessoas
   * escrevem — o turno do primeiro campo tinha `completaOAceite` falso, logo
   * `vaiMarcar` falso, logo `oferta` undefined, logo o ramo que pediria o campo
   * que falta era INALCANÇÁVEL. O turno caía na triagem, que não tinha o que
   * perguntar, e escalava: quem respondia certo recebia "Só um instante.".
   *
   * Pior: a escalada não desarmava a oferta, então a segunda mensagem fechava a
   * marcação SOZINHA, depois de o caso já ter ido para a recepção. Medido nos
   * três turnos antes de consertar.
   *
   * `acaoDaTabela === 'triagem'` e não `!== 'marcar'`: um turno de FAQ ("qual o
   * endereço?") no meio da coleta tem de receber o endereço, não o pedido de
   * dados outra vez — ignorar o que a pessoa perguntou é o "parece máquina" que
   * esta arquitetura existe para evitar. A oferta fica de pé e o próximo turno
   * de cadastro continua de onde parou.
   */
  const respondeAoPedido =
    !!pendente?.aguardaDados && acaoDaTabela === 'triagem';
  const completaOAceite = respondeAoPedido && faltaCadastro.length === 0;
  if (completaOAceite) {
    // A intenção da TABELA passa a ser o aceite: é ela que carrega
    // `acao: 'marcar'` e o texto de confirmação.
    intencaoDoHost = 'aceita_horario';
  }
  const vaiMarcar = completaOAceite || acaoDaTabela === 'marcar';
  // A oferta também fica visível para o turno que respondeu PELA METADE: é ele
  // que precisa chegar ao ramo do pedido, logo abaixo.
  const oferta = vaiMarcar || respondeAoPedido ? pendente : undefined;
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
  // ⚠️ Uma vez, não cinco. `vagasDaOferta` (em agendamento.ts) existe porque
  // "o executor desdobrava o fallback inline em quatro lugares"; este é o mesmo
  // fallback, um nível acima, e tinha chegado a cinco cópias.
  const vagaDoAceite = escolhida ?? oferta?.vaga;
  if (vaiMarcar && oferta && !escolhida && oferecidas.length > 1) {
    const rq = renderiza(tabela, 'qual_horario', {
      confianca: 1,
      slots: { ...slots, ...slotsDasVagas(oferecidas) },
    });
    if (rq.texto && rq.intencao === 'qual_horario') {
      // ⚠️ Loga o TEXTO e as vagas. Sem isso, um laço aqui é indepurável: eu
      // perdi duas tentativas de conserto no E08 raciocinando sobre o que
      // DEVIA estar chegando, enquanto o log só dizia que a decisão aconteceu.
      logger.info(
        {
          groupFolder,
          opcoes: oferecidas.length,
          texto: perguntaDoPaciente.slice(0, 120),
          vagas: oferecidas.map((v) => `${v.data} ${v.inicio}`),
        },
        'executor: aceite não disse qual horário, perguntando',
      );
      return { texto: rq.texto, intencao: 'qual_horario', acao: 'responder' };
    }
  }

  // Aceitou o horário e falta o cadastro: aí o host PEDE nome e nascimento.
  //
  // É a outra metade da oferta-antes-da-coleta. A marcação exige os dois
  // (`iclinic_marcar.py`), e antes de 21/10/2026 eles vinham da triagem, que
  // acontecia antes da oferta. Invertida a ordem, este é o turno em que eles
  // fazem falta — e pedir aqui é o que a clínica faz hoje.
  if (oferta && faltaCadastro.length > 0) {
    const v = vagaDoAceite ?? oferta.vaga;
    const pedido = fraseDeTriagem(cadastro, {
      apenas: CAMPOS_DA_MARCACAO,
      proposito: 'Perfeito! Para eu confirmar o agendamento, ',
    });
    if (!pedido) return undefined;
    // ⚠️ Conta a insistência AQUI, porque este `return` passa por fora do
    // contador do fim da função. Sem isto, quem responde à pergunta com
    // qualquer outra coisa ouve a mesma pergunta para sempre: a oferta continua
    // de pé, `aguardaDados` continua marcado, e nada escala. É o sintoma das
    // três perguntas idênticas que o Thiago viu em 20/10/2026, num caminho novo.
    const insistiu = await escalaSeInsistiu(
      groupFolder,
      tabela,
      'pergunta_dados_para_marcar',
      `aceitou ${v.dia_semana}, dia ${v.data}, às ${v.inicio}, mas o nome e o ` +
        'nascimento não vieram em três pedidos; complete o cadastro e ' +
        'confirme com o paciente',
      { perguntaDoPaciente, deps, chatJid, rotulo: c.intencao },
      // ⚠️ Desarma a oferta ao escalar, como faz a trava da observação. Sem
      // isto, `aguardaDados` e a oferta continuam de pé depois de o caso ir
      // para a recepção: o paciente manda o nome mais tarde, o caminho do
      // aceite fecha sozinho, e a Lara marca um horário que a secretária pode
      // já ter resolvido à mão. Escalar é transferir a dona do caso; quem
      // transfere não guarda o gatilho.
      () => esqueceOferta(groupFolder, chatJid),
    );
    if (insistiu) return insistiu;
    // ⚠️ Regrava a oferta ESTREITADA na vaga escolhida, e marcada.
    //
    // Estreitar porque o turno seguinte traz "Thiago, 01/06/1980", que não
    // desambigua nada: com as duas opções ainda de pé, o host perguntaria
    // "qual horário?" depois de a pessoa já ter escolhido. Marcar porque é a
    // marca que autoriza o turno seguinte a fechar a marcação.
    //
    // Guarda também o cadastro parcial: a regravação substitui a oferta
    // inteira, e sem isto o dado já coletado sumiria justamente no turno que
    // pede o que falta.
    registraOferta(groupFolder, chatJid, {
      ...oferta,
      vaga: v,
      vagas: [v],
      nome: cadastro.nome || undefined,
      nascimento: cadastro.nascimento || undefined,
      aguardaDados: true,
    });
    logger.info(
      { groupFolder, data: v.data, hora: v.inicio, falta: faltaCadastro },
      'executor: aceite sem cadastro, pedindo o que falta',
    );
    return {
      texto: pedido,
      intencao: 'pergunta_dados_para_marcar',
      acao: 'responder',
    };
  }

  if (vaiMarcar && oferta) {
    slots = {
      ...slots,
      ...slotsDaVaga(vagaDoAceite ?? oferta.vaga),
      // `primeiroNome` normaliza a caixa: o cadastro do iClinic guarda em
      // CAIXA ALTA, e sem isto a confirmação saía "Pronto, THIAGO, está
      // agendado" (16/10/2026). Caixa alta soa a grito e não é como a clínica
      // escreve.
      // ⚠️ Do `cadastro`, que já funde oferta + memória. Com `c.slots` o turno
      // que fechava o aceite mandando SÓ o nascimento produzia "Pronto, ,
      // está agendado" — vírgula dupla, nome vazio — e a guarda de saída deixa
      // passar, porque a marcação de fato aconteceu. Achado ao verificar o
      // review do Codex, 21/10/2026.
      paciente: primeiroNome(cadastro.nome || oferta.nome || ''),
    };
  }

  const lembrados = comLembrados(groupFolder, chatJid, slots);
  // ⚠️ `corrigePlanoParcial` fica FORA de `TROCAS` porque lê outra coisa: as
  // trocas decidem pelos slots, e esta decide pelo texto do paciente. Ela vem
  // depois, para também corrigir o que `comPlanoParcial` acabou de escolher a
  // partir do slot `convenio` — que é o mesmo campo que o modelo preencheu
  // errado quando confundiu PLAMTA com PLANTE.
  const intencaoFinal = intencaoDoHost
    ? intencaoDoHost
    : corrigePlanoParcial(
        TROCAS.reduce((i, troca) => troca(i, lembrados, tabela), c.intencao),
        perguntaDoPaciente,
        tabela,
      );
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
  const temEmenda =
    acao === 'responder' && !!tabela.intencoes[entregou]?.emenda_triagem;
  // Uma leitura, e fatorado: repetir o `!jaConvidou` no `conviteLeve` obrigava
  // o leitor a desdobrar `convidavel` para descobrir que não era redundante.
  const naoConvidou = !jaConvidou(groupFolder, chatJid);
  const convidavel = temEmenda && naoConvidou;

  // ⚠️ `necessidade` NÃO conta como compromisso. Ela é preenchida por qualquer
  // pergunta ("quanto custa a catarata?" já define necessidade), e usá-la aqui
  // faria o convite leve nunca acontecer.
  // Usa `faltamNaTriagem`, e não uma lista própria: `CAMPOS` em triagem.ts é a
  // lista única dos quatro dados do formulário.
  const seIdentificou =
    faltamNaTriagem(lembrados as Record<string, string>).length < CAMPOS.length;

  // COMO emendar depende do que falta para a AGENDA.
  //
  // ⚠️ Esta decisão foi reescrita em 21/10/2026, quando o Thiago pediu que as
  // emendas também fossem invertidas. O critério anterior era `seIdentificou`
  // — "a pessoa já deu algum dos quatro dados?" —, que vinha da decisão de
  // 19/10 ("vamos tentar o melhor dos dois": convite leve para quem pesquisa,
  // pedido de dados para quem se identifica).
  //
  // Esse critério deixou de descrever o fluxo. Com a oferta vindo antes da
  // coleta, ter dito o nome não aproxima ninguém de um horário: o que aproxima
  // é necessidade e convênio. Quem perguntou o preço dizendo "sou o Marcos"
  // recebia "poderia me informar a data de nascimento", com a justificativa
  // "Para eu já ver um horário" — e o host não precisa do nascimento para ver
  // horário nenhum. A frase era falsa e o pedido, inútil.
  //
  // Agora a emenda PEDE o que falta para a agenda (necessidade, convênio), e
  // nunca o cadastro — nome e nascimento são pedidos no aceite, e só lá.
  const faltaParaAgenda: PerguntaDaAgenda =
    perguntaParaAgenda ?? perguntaQueLevaAAgenda(tabela, lembrados);

  // ⚠️ O que a inversão NÃO muda: QUEM recebe pergunta.
  //
  // `seIdentificou` continua decidindo isso, e é decisão de 19/10/2026 — quem
  // só pesquisava preço recebe o convite LEVE, porque pedir dado para informar
  // valor é o que o manual chama de exigir cadastro. Na primeira tentativa eu
  // troquei este gate pelo "falta algo para a agenda" e desfiz aquela decisão
  // de passagem: "quanto custa a consulta?" passou a receber "Seria para
  // avaliação de cirurgia ou consulta de rotina?" em vez do convite. Dois
  // testes pegaram.
  //
  // O que mudou é o SEGUNDO caso do convite: quem já se identificou E não tem
  // nada pendente para a agenda. Antes esse turno pedia o cadastro que falta
  // ("a data de nascimento"); agora não há o que pedir, e sem o convite a
  // resposta ficaria sem próximo passo, contra o F04.
  //
  // E a RECUSA de convênio entra no convite. Até 20/10/2026 ela ficava sozinha
  // quando não havia dado a pedir, e isso era coerente: com os quatro campos
  // preenchidos, qualquer pergunta ali repetiria algo já dito. Invertida a
  // emenda, "não havia dado a pedir" passou a ser o caso NORMAL — a recusa
  // conhece o convênio por definição —, e a mensagem de maior conversão da
  // clínica ("seria particular, R$ 430" / "sai por R$ 300") terminaria sem
  // próximo passo nenhum, contra o F04. O convite é o passo, e é texto
  // aprovado. ⚠️ Isto reverte a decisão de que a recusa não pendura pergunta;
  // o que a decisão protegia — não pedir o que a pessoa já deu — continua de
  // pé, porque com tudo conhecido não sai pedido, sai convite.
  const conviteLeve =
    (temEmenda || acao === 'recusar_e_triagem') &&
    naoConvidou &&
    (!seIdentificou || faltaParaAgenda.tipo === 'nada') &&
    !!tabela.intencoes.convite_horario;
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
    const n = daConversa.necessidade ?? '';
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
    // ⚠️ A MESMA decisão dos dois outros pontos, inclusive na recusa de
    // convênio: o que emenda a resposta é o que leva à agenda, não o cadastro.
    // Nome e nascimento são pedidos no aceite, e só lá.
    const pedido =
      faltaParaAgenda.tipo === 'pergunta'
        ? faltaParaAgenda.texto
        : faltaParaAgenda.tipo === 'sem_texto'
          ? // A rede: o formulário de quatro campos, como era até 20/10/2026.
            // Vale quando a tabela do grupo não tem os textos novos.
            fraseDeTriagem(lembrados, { textoCompleto: formulario })
          : '';

    // ⚠️ Era aqui que ficava o fallback do `pergunta_necessidade` — "os quatro
    // dados completos e ainda assim triagem, então o que falta é a
    // NECESSIDADE". Virou código morto em 21/10/2026: `perguntaQueLevaAAgenda`
    // já devolve essa pergunta, e por isso `pedido` nunca chega vazio com a
    // necessidade faltando. Verificado por sabotagem — trocar aquele texto por
    // uma string reconhecível não mudava nenhum dos 176 testes.

    if (acao === 'triagem') {
      // ⚠️ Cadastro ESPONTÂNEO depois da oferta.
      //
      // Com um horário na mesa, dar os dados é o reflexo natural do paciente —
      // e até 21/10/2026, à tarde, isso levava "Só um instante.". O
      // `!ultimaOferta` que eu pus no `triagemVaiAgenda` (para matar o laço de
      // reoferta) é largo demais: com oferta de pé a triagem não vai à agenda,
      // nada falta para perguntar, e a escalada de "nada a perguntar" dispara.
      // Apareceu na passada dirigida, em DOIS cenários (W01 e W03), e foi
      // reproduzido localmente antes deste conserto.
      //
      // O certo é repetir a oferta QUE JÁ ESTÁ DE PÉ — sem nova busca de 18s —,
      // porque o texto dela é "Tenho {dia}, dia {data}, às {hora}. Esse horário
      // funciona para você?", que é exatamente o que se diz a quem acabou de
      // mandar o cadastro. Não é aceite: o paciente ainda não disse sim, e
      // tratar como sim marcaria consulta sem confirmação.
      if (!pedido && pendente && !pendente.aguardaDados) {
        const insistiu = await escalaSeInsistiu(
          groupFolder,
          tabela,
          'horario_oferta_repetida',
          'mandou dados de cadastro três vezes com a mesma oferta na mesa e ' +
            'nunca aceitou o horário; veja o que o paciente quer',
          { perguntaDoPaciente, deps, chatJid, rotulo: c.intencao },
          () => esqueceOferta(groupFolder, chatJid),
        );
        if (insistiu) return insistiu;
        const ro = renderiza(tabela, 'horario_oferta', {
          confianca: 1,
          slots: { ...slots, ...slotsDasVagas(vagasDaOferta(pendente)) },
        });
        if (ro.texto && ro.intencao === 'horario_oferta') {
          logger.info(
            { groupFolder, vagas: vagasDaOferta(pendente).length },
            'executor: cadastro espontâneo, repete a oferta de pé',
          );
          return {
            texto: ro.texto,
            intencao: 'horario_oferta',
            acao: 'responder',
          };
        }
      }
      if (!pedido) {
        // Nada a perguntar e ainda assim triagem: é rótulo errado. Escalar é
        // melhor que repetir formulário ou adivinhar o que ele quer.
        //
        // ⚠️ Desarma a oferta de passagem. Era por AQUI que o cadastro em duas
        // mensagens escalava, e a oferta ficava armada para marcar sozinha no
        // turno seguinte. O ramo acima agora impede a escalada; isto é a rede,
        // para nenhum caminho novo herdar o mesmo buraco.
        if (pendente?.aguardaDados) esqueceOferta(groupFolder, chatJid);
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
    // ⛔ TRAVA DA OBSERVAÇÃO: não escreve no iClinic.
    //
    // ⚠️ Este era um BURACO real na semana de observação, e foi o Thiago que
    // perguntou (20/10/2026): "mesmo não enviando mensagem pro paciente, a Lara
    // marca no iClinic?". Marcava. `emObservacao` só era consultado em
    // `index.ts`, DEPOIS de `executa` ter rodado inteiro — e a escrita acontece
    // aqui dentro.
    //
    // A sequência que isso produzia é provável, não hipotética: o paciente
    // pergunta horário (o host busca a agenda e REGISTRA a oferta, mesmo com o
    // texto retido), depois diz "pode ser" para a SECRETÁRIA HUMANA no mesmo
    // DM, e a Lara gravava a consulta. Resultado: consulta fantasma na agenda
    // da Marina, ou dupla quando a secretária marcasse também — e o paciente
    // sem confirmação nenhuma, porque o texto nunca saiu.
    //
    // Escala em vez de produzir o texto de confirmação, de propósito: aquele
    // texto afirma "está agendado", e numa semana em que ele vai para um grupo
    // de revisão humana, afirmação falsa pode ser copiada para o paciente. O
    // que a observação precisa julgar é a DECISÃO, e ela está no motivo.
    if (emObservacao(groupFolder, chatJid)) {
      const v = escolhida ?? oferta.vaga;
      logger.warn(
        { groupFolder, chatJid, data: v.data, hora: v.inicio },
        'observação: NÃO marquei na agenda; a decisão foi para a revisão',
      );
      esqueceOferta(groupFolder, chatJid);
      return await escalaComo(
        groupFolder,
        tabela,
        `EM OBSERVAÇÃO, nada foi gravado: a Lara marcaria ${v.dia_semana}, ` +
          `dia ${v.data}, às ${v.inicio} para ${oferta.nome || 'este paciente'}` +
          ' — quem marca de verdade nesta semana é a secretária',
        perguntaDoPaciente,
        deps,
        c.intencao,
      );
    }
    const res = await marca(groupFolder, {
      operacao: 'marcar',
      // A oferta vem primeiro: ela carrega o que foi coletado na triagem. O
      // turno do aceite normalmente não repete nome nem nascimento.
      // ⚠️ `daConversa` é `comLembrados`, não `c.slots`: no turno que fecha
      // o aceite o nome pode ter vindo DOIS turnos antes (o paciente responde
      // "Thiago Costa" e só depois a data), e `c.slots` só tem o turno atual.
      // Com `c.slots` aqui, a marcação recusava por `dado_faltando: paciente`
      // exatamente no caminho novo.
      paciente: cadastro.nome || oferta.nome || '',
      pedidoPor: remetenteJid || chatJid,
      nascimento: oferta.nascimento ?? daConversa.nascimento,
      convenio: oferta.convenio ?? daConversa.convenio,
      data: (escolhida ?? oferta.vaga).data,
      hora: (escolhida ?? oferta.vaga).inicio,
      perfil: oferta.perfil,
      // ⛔ A necessidade decide QUAL avaliação cirúrgica vai para a agenda da
      // Marina (catarata / refrativa / pterígio). O perfil não diz — ele só
      // separa particular de convênio. Ver `necessidade` em agendamento.ts.
      necessidade: daConversa.necessidade,
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
  // ⚠️ `perguntaParaAgenda` entra na conta, e a triagem crua continua fora.
  //
  // A distinção deixou de ser a mesma em 21/10/2026: antes a triagem repetia
  // variando (um campo por mensagem, o caso bom do comentário acima); agora,
  // enquanto o convênio não vem, o texto que sai é IDÊNTICO. Repetir três
  // vezes a mesma pergunta é insistência igual à de qualquer resposta pronta —
  // e o paciente que não responde ao convênio é justamente quem a recepção
  // precisa ver.
  const perguntaRepetida =
    acao === 'triagem' ? perguntaParaAgenda?.intencao : undefined;
  if (
    acao === 'responder' ||
    acao === 'recusar_e_triagem' ||
    perguntaRepetida
  ) {
    const insistiu = await escalaSeInsistiu(
      groupFolder,
      tabela,
      perguntaRepetida ?? r.intencao,
      `respondeu "${r.intencao}" ${LIMITE_DE_INSISTENCIA} vezes seguidas e o ` +
        'paciente continua no mesmo assunto; a resposta pronta não está ' +
        'resolvendo',
      { perguntaDoPaciente, deps, chatJid, rotulo: c.intencao },
    );
    if (insistiu) return insistiu;
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
