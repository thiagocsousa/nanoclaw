import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  mensagemPorIdCurto,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  runInTransaction,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  findChannelForGroup,
  formatMessages,
  formatOutbound,
} from './router.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { idMensagemDe } from './classify.js';
import { readEnvFile } from './env.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { recordAgentMarking } from './agent-marking.js';
import {
  baixaPorCodigo,
  codigoDaBaixa,
  destinoDoAviso,
  podeDarBaixa,
  startEscalationSla,
  tocaAlarme,
} from './escalation-sla.js';
import { executa, listaDeIntencoes, wantsTemplates } from './executor.js';
import {
  inspecionaSaida,
  resumoDoAviso,
  wantsOutputGuard,
} from './output-guard.js';
import { humanDelayMs, sleep, wantsHumanCadence } from './human-cadence.js';
import { mensagensDe } from './templates.js';
import {
  dentroDoExpediente,
  podeResponder,
  wantsExpediente,
} from './expediente.js';
import { abreConversa, conversaAbertaEm } from './memoria-conversa.js';
import {
  chaveDaSessao,
  algumaPastaEmObservacao,
  emObservacao,
  soFalaDaClinica,
  podeMostrarPresenca,
  retemResposta,
  lePendentes,
  type OrigemDeEgresso,
  pastaDeObservacaoDeDm,
  podeEntregar,
  aprovaEmQualquerPasta,
  concluiEnvio,
  destinoDaRevisao,
  devolveAFila,
  pastasComRevisao,
  tickRevisaoSla,
  podeAprovar,
  registraParaRevisao,
  textoDaRevisao,
} from './revisao-humana.js';
import { logger } from './logger.js';
import {
  type PipelineDoChat,
  podaPipelines,
  soEcoDePipeline,
} from './resposta-pipeline.js';
import {
  type MensagemSemeada,
  cursorDepoisDeSemear,
  leEventosSla,
  mensagensDoHistorico,
} from './semear-historico.js';
import {
  type DmsObservadas,
  anotaDm,
  chatsAcompanhados,
  grupoDaDm,
  podaDms,
} from './dm-observada.js';
import {
  avisoDeCapturaParada,
  type EstadoDaVigia,
  textoDoAviso,
} from './vigia-captura.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

/**
 * O último pipeline que falou com cada chat. Ver `resposta-pipeline.ts`.
 *
 * ⛔ Existe porque a origem se perdia na gravação: `messages` não tem coluna
 * para ela. É isto que permite saber que um "SIM" às 15h é resposta ao
 * lembrete, e não uma conversa começando.
 */
let pipelinePorChat: Record<string, PipelineDoChat> = {};

/**
 * A pasta do canal de atendimento.
 *
 * ⚠️ É a pasta de `groupFolderOwner` daquele canal, que é quem GRAVA o
 * `atendimento_sla.jsonl` (`captureSlaTimeline`) — e não a pasta de observação
 * que `registraDmEmObservacao` recebe: essa pode ser outra (hoje há
 * `whatsapp_atendimento-teste`), e semear a partir dela leria um arquivo que
 * não existe e devolveria silêncio.
 */
const PASTA_DO_SLA = 'whatsapp_atendimento-dra-marina';

/** Estado da vigia da captura. Ver `vigia-captura.ts`. */
const vigia: EstadoDaVigia = { ultimaCaptura: Date.now() };
let lastAgentTimestamp: Record<string, string> = {};

/**
 * As DMs de paciente acompanhadas. Ver `dm-observada.ts` e
 * `docs/DM-SEM-REGISTRO.md`: elas NÃO vão para `registered_groups`, porque
 * registrar apagaria o grupo de atendimento (pasta é UNIQUE) e desarmaria o
 * gate de DM do IPC.
 */
let dmsObservadas: DmsObservadas = {};

/** Quanto tempo sem sinal até a DM sair do registro. */
const VALIDADE_DA_DM_MS = 7 * 24 * 3600 * 1000;

/**
 * O teto da semeadura. Ver `docs/SEMEAR-HISTORICO.md`.
 *
 * 50 e 30 dias porque a maior conversa medida tinha 150 eventos, e prompt com
 * 150 mensagens é caro e provavelmente pior que com as 50 mais recentes — o que
 * explica "tem algum retorno?" é o fim da conversa, não o começo.
 */
const SEMEADURA = { maximo: 50, dias: 30 };

/**
 * O passado de uma conversa que começou antes da captura: as linhas e o cursor
 * que elas implicam. NÃO grava nada.
 *
 * ⛔ Separar "ler" de "gravar" é o que permite UMA transação só lá em cima, em
 * `registraDmEmObservacao`. Antes esta função tinha a sua própria, e entre o
 * commit dela e o `saveState` do registro da DM existia um estado incoerente:
 * cursor e histórico gravados, chat FORA de `dmsObservadas` — semeado e não
 * acompanhado. Achado do review adversarial do Codex em 22/10/2026.
 *
 * ⚠️ Falha de LEITURA devolve `undefined` e não derruba a descoberta da DM:
 * sem passado é pior, mas é o estado de antes, e perder a DM seria pior ainda.
 * Falha de ESCRITA é problema de quem chama, e cancela as duas coisas juntas.
 */
function historicoParaSemear(
  chatJid: string,
  ate: string,
): { mensagens: MensagemSemeada[]; cursor: string } | undefined {
  try {
    const arquivo = path.join(
      resolveGroupFolderPath(PASTA_DO_SLA),
      'atendimento_sla.jsonl',
    );
    const eventos = leEventosSla(arquivo, chatJid);
    const desde = new Date(
      Date.now() - SEMEADURA.dias * 24 * 3600 * 1000,
    ).toISOString();
    const mensagens = mensagensDoHistorico(eventos, chatJid, {
      maximo: SEMEADURA.maximo,
      desde,
      // ⛔ O teto é o piso da descoberta: tudo ANTES da mensagem que revelou a
      // DM. Sem ele a própria mensagem entraria no histórico e o cursor a
      // excluiria de `getNewMessages` — vista e não respondida.
      ate,
    });
    const cursor = cursorDepoisDeSemear(mensagens);
    if (!cursor) return undefined;
    return { mensagens, cursor };
  } catch (err) {
    logger.warn({ err, chatJid }, 'semeadura falhou; segue sem passado');
    return undefined;
  }
}
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

/**
 * Um blob JSON do `router_state`, ou o vazio quando não dá para ler.
 *
 * ⚠️ Três estados usam o mesmo par carrega/`JSON.parse`/zera, e a cerimônia
 * repetida escondia a única diferença que importa entre eles: quem é podado.
 */
function carregaJson<T>(chave: string, vazio: T): T {
  const cru = getRouterState(chave);
  if (!cru) return vazio;
  try {
    return JSON.parse(cru) as T;
  } catch {
    logger.warn({ chave }, 'router_state corrompido, zerando');
    return vazio;
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  lastAgentTimestamp = carregaJson('last_agent_timestamp', {});
  dmsObservadas = podaDms(
    carregaJson('dms_observadas', {}),
    Date.now(),
    VALIDADE_DA_DM_MS,
  );
  pipelinePorChat = podaPipelines(
    carregaJson('pipeline_por_chat', {}),
    Date.now(),
  );
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
/**
 * Envio para um destino interno (recepção, aviso de guarda, escalonamento).
 * Mesma resolução de canal que o SLA e o IPC já fazem, num lugar só: três
 * cópias da mesma lógica é onde uma delas fica atrás das outras.
 */
function enviaParaDestino(
  jid: string,
  text: string,
  groupFolder?: string,
): Promise<unknown> | unknown {
  const channel =
    (groupFolder && findChannelForGroup(channels, groupFolder)) ||
    findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid, groupFolder }, 'sem canal para o destino interno');
    return;
  }
  // `alerta`: destino INTERNO (aviso a humano, grupo de revisão), nunca paciente.
  return channel.sendMessage(jid, text, 'alerta');
}

function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

/**
 * ⚠️ Uma transação, e não quatro commits. `saveState` é chamado algumas
 * centenas de vezes por dia (uma por lote, e uma por mensagem em DM observada),
 * e cada `setRouterState` solto é uma transação implícita própria.
 */
function saveState(): void {
  runInTransaction(() => {
    setRouterState('last_timestamp', lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
    setRouterState('dms_observadas', JSON.stringify(dmsObservadas));
    setRouterState('pipeline_por_chat', JSON.stringify(pipelinePorChat));
  });
}

/**
 * O grupo deste chat: o registrado OU a DM acompanhada.
 *
 * ⚠️ UM resolvedor, e não `registeredGroups[chatJid]` espalhado. Quem precisa
 * enxergar DM observada chama isto; quem NÃO pode — o gate de DM do `ipc.ts`,
 * que se desarma com chat registrado — continua lendo o mapa cru, de propósito.
 */
function grupoDoChat(chatJid: string): RegisteredGroup | undefined {
  const registrado = registeredGroups[chatJid];
  if (registrado) return registrado;
  const dm = dmsObservadas[chatJid];
  if (!dm) return undefined;
  return grupoDaDm(chatJid, dm, DEFAULT_TRIGGER) as RegisteredGroup;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
/**
 * O expediente segura este lote? Se sim, as mensagens ficam PENDENTES.
 *
 * ⚠️ Chamado nas DUAS portas. O laço principal tem um caminho que NÃO passa por
 * `processGroupMessages`: quando já existe container vivo, as mensagens são
 * canalizadas direto para ele. Esse caminho não consultava horário nenhum, então
 * bastava um container aberto para a Lara responder de madrugada — e era o furo
 * que sobrava depois de apertar a regra. Uma definição, dois portões.
 *
 * ⛔ Devolver `true` NÃO pode avançar cursor nenhum. É o que faz a varredura da
 * manhã pegar a conversa inteira em vez de marcá-la como vista e perdida.
 */
function expedienteSegura(
  group: RegisteredGroup,
  chatJid: string,
  pendentes: number,
): boolean {
  if (!wantsExpediente(group.folder)) return false;
  const abertaEm = conversaAbertaEm(group.folder, chatJid);
  if (podeResponder(abertaEm)) {
    // Dentro do horário: marca o início, se ainda não houver. `abreConversa`
    // devolve o valor existente quando já há um válido, então a conversa das
    // 17h55 não vira "aberta às 18h20" no turno seguinte — e é esse valor que
    // decide se ela segue sendo atendida na meia hora final.
    abreConversa(group.folder, chatJid);
    return false;
  }
  logger.info(
    { group: group.name, dentro: dentroDoExpediente(), abertaEm, pendentes },
    'expediente: fora do horário, a Lara não responde (mensagens ficam pendentes)',
  );
  return true;
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = grupoDoChat(chatJid);
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Na pasta que responde por TABELA, o classificador precisa ver o que a Lara
  // disse: ele só emitiu `{"intencao":"abertura"}` e quem produziu o texto do
  // menu foi o host. Sem isso um "2" chega sem menu à vista, e DESCONHECIDO
  // passa a ser a classificação CORRETA para o que ele viu — foi o que escalou
  // no primeiro teste real, e é o mesmo bug que fabricou 10 dos 12 erros da
  // primeira medição do classificador.
  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
    wantsTemplates(group.folder),
  );

  if (missedMessages.length === 0) return true;

  // Expediente: 7h30 às 18h30, segunda a sexta (Thiago, 17 e 19/10/2026).
  // A janela de verdade está em `expediente.ts`, e é configurável por env;
  // este comentário já ficou um dia desatualizado por ser uma quarta cópia.
  //
  // Fora disso a Lara fica CALADA, porque quem responde é a mensagem de
  // ausência do WhatsApp Business, que é nativa. Duas respostas automáticas
  // para a mesma mensagem é pior que uma.
  //
  // Quem iniciou ANTES das 18h continua até encerrar ou escalar: o corte é no
  // início da conversa, e quem está no meio da triagem às 17h55 não pode levar
  // silêncio às 18h01.
  //
  // ⚠️ Isto vem ANTES de o cursor avançar, de propósito. Devolvendo aqui, as
  // mensagens da noite continuam PENDENTES, e a primeira varredura das 8h as
  // pega todas de uma vez, com o fio inteiro da conversa no prompt. Na primeira
  // versão eu pus este bloco depois do cursor e as mensagens da madrugada
  // seriam marcadas como vistas e perdidas — o Thiago perguntou justamente se a
  // Lara retoma o que chegou entre 18h e 8h, e com o gate no lugar errado a
  // resposta seria não.
  if (expedienteSegura(group, chatJid, missedMessages.length)) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  let prompt = formatMessages(missedMessages, TIMEZONE);

  // Na pasta que responde por tabela, a lista de intenções vai NO PROMPT. O
  // CLAUDE.md mandava o agente ler `templates.json` e no primeiro teste em
  // produção ele não leu: inventou `endereco_clinica`, que não existe, e o caso
  // escalou. Depender de o modelo abrir um arquivo é depender de ele fazer a
  // coisa certa, e é isso que esta arquitetura existe para não fazer.
  if (wantsTemplates(group.folder)) {
    const lista = listaDeIntencoes(group.folder);
    if (lista) prompt = `${lista}\n\n${prompt}`;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // ⛔ Presença É egresso: o paciente vê "digitando…" vindo do número da
  // clínica. Esta linha dispara 169 linhas ANTES da trava de texto, então em
  // observação ela vazava atividade mesmo quando nada era enviado. Não é
  // mensagem, é presença, e passava por fora de toda trava de texto.
  if (podeMostrarPresenca(group.folder, chatJid)) {
    await channel.setTyping?.(chatJid, true);
  }
  // Marco do turno: a cadência humana é um ALVO de tempo total percebido, e o
  // tempo que o container gasta pensando já foi silêncio para quem espera.
  const inicioDoTurno = Date.now();
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      // Telemetria do teste de tom: o agente anota intenção e fonte dentro de
      // <internal>, que já é removido acima. Antes isso era uma chamada de
      // script no fim do turno, e em 04/10/2026 o agente rodou o script e
      // terminou SEM responder (result: null): a chamada obrigatória virou o
      // turno. Carona numa saída que ele já produz não tem esse caminho.
      recordAgentMarking(group.folder, raw);

      // Guarda de saída: última inspeção antes de o paciente ler. Bloqueio não
      // vira silêncio: vira aviso para humano, com o texto e o motivo, senão o
      // paciente espera por uma resposta que ninguém sabe que foi barrada.
      let paraEnviar = text;
      let agendouNesteTurno = false;
      let intencaoDoTurno = '';
      let acaoDoTurno = '';
      let perguntaDoTurno = '';

      // Executor da tabela: quando a pasta responde por template, o texto vem
      // da tabela e o modelo só entregou um rótulo. A guarda abaixo continua
      // rodando, agora sobre texto aprovado: é defesa em profundidade, e o
      // teste estrutural dela garante que nenhum texto aprovado é bloqueado.
      if (wantsTemplates(group.folder)) {
        const ultima = missedMessages[missedMessages.length - 1];
        // ⚠️ A pergunta vem do BANCO, não da janela.
        //
        // `missedMessages[length - 1]` é a última da JANELA, e nos turnos 2+ a
        // janela está velha: com container vivo, as mensagens novas vão pelo
        // caminho de canalização e o cursor avança lá. O classificador vê o
        // certo (daí os rótulos corretos) e o host lia a PRIMEIRA mensagem da
        // conversa. Virou laço de agendamento, e motivo de escalonamento errado
        // em todo caso aberto. Ver `ultimaMensagemDoPaciente`.
        //
        // ⚠️ Texto e remetente vêm SEMPRE da mesma fonte. Misturar os dois —
        // texto do banco, remetente da janela — fazia num grupo o aceite de uma
        // pessoa ser atribuído ao JID de outra, e esse JID vira busca de
        // cadastro e telefone de contato da consulta.
        //
        // ⚠️ E a amarração do TURNO: o agente devolve o id curto da mensagem
        // que ele leu, e é ESSA linha que o host consulta.
        //
        // Sem isso o host pegava a linha mais nova do banco no momento do
        // resultado. Com container vivo, uma mensagem nova pode chegar
        // enquanto o resultado da anterior está em voo — e aí a intenção
        // VELHA era executada contra a mensagem NOVA, com o remetente dela
        // virando `pedidoPor` na marcação: num grupo, o aceite de um
        // participante marcava consulta com o telefone de outro. O conserto do
        // par texto/remetente garantiu que os dois vêm da MESMA linha; não
        // garantiu que é a linha certa. (Codex, 20/10/2026.)
        //
        // ⛔ E FALHA FECHADO: sem id que resolva, o turno NÃO executa.
        //
        // O fallback para "a mensagem mais nova" era o comportamento antigo, e
        // medido em produção em 21/10/2026 ele colava rótulo de um turno na
        // pergunta de outro. Dois casos reais no mesmo dia:
        //
        //   - "Quanto custa a cirurgia refrativa?" recebeu o texto de
        //     `menor_de_idade`, e o id devolvido apontava para mensagem de
        //     OUTRO paciente;
        //   - "Pertinho de minha casa. Grato!" apareceu em TRÊS propostas
        //     seguidas com três respostas diferentes, porque três turnos leram
        //     a mesma mensagem mais nova.
        //
        // Falhar aberto aqui é pior que não responder: produz resposta
        // plausível para a pergunta errada, e em observação isso enche o grupo
        // de revisão de pares que não existem. O Codex apontou isto como alto
        // em 20/10/2026 e eu mantive o fallback com log — foi o erro.
        const idDito = idMensagemDe(raw);
        const doId = idDito
          ? mensagemPorIdCurto(chatJid, idDito, ASSISTANT_NAME)
          : undefined;
        // ⚠️ LOGA SEMPRE, com os três desfechos distinguíveis.
        //
        // A primeira versão só avisava quando o id vinha e não resolvia. Mas o
        // caso que importa medir é o agente NÃO devolver o campo: ali `idDito`
        // é undefined, nenhum aviso saía, e o host caía no comportamento antigo
        // CALADO. Resultado: zero avisos significava "funcionou" ou "o contrato
        // novo não pegou", indistinguíveis — e foi exatamente assim que a
        // primeira medição no ar não concluiu nada (20/10/2026).
        logger.info(
          {
            chatJid,
            amarracao: doId ? 'ok' : idDito ? 'nao_resolveu' : 'sem_campo',
            idDito: idDito ?? null,
          },
          'executor: amarração do turno',
        );
        if (!doId) {
          // Sem par confiável o host não improvisa: avisa humano e cala. É o
          // mesmo princípio de "sem tabela não há texto aprovado" — aqui não há
          // PERGUNTA confiável, e responder a pergunta errada é pior que o
          // silêncio com aviso.
          const { jid, folder } = destinoDoAviso();
          enviaParaDestino(
            jid,
            '⛔ *Turno sem amarração*\n\nO agente não devolveu um ' +
              '`id_mensagem` que resolvesse nesta conversa, então eu não sei a ' +
              'QUAL mensagem a classificação se refere. Nada foi respondido.\n\n' +
              `Conversa: \`${chatJid}\`\nid devolvido: \`${idDito ?? '(nenhum)'}\``,
            folder,
          );
          return;
        }
        const doBanco = doId;
        const perguntaReal = doBanco?.content ?? ultima?.content ?? '';
        const remetenteReal = doBanco?.sender ?? ultima?.sender ?? '';
        const r = await executa(
          group.folder,
          raw,
          perguntaReal,
          { sendMessage: enviaParaDestino },
          chatJid,
          remetenteReal,
        );
        if (!r) {
          // Sem tabela não há texto aprovado, e improvisar é o que esta
          // arquitetura existe para impedir. Avisa humano e cala.
          const { jid, folder } = destinoDoAviso();
          enviaParaDestino(
            jid,
            '⛔ *Executor sem tabela*\n\nA pasta está configurada para ' +
              `responder por template e \`${group.folder}/templates.json\` não ` +
              'carregou. Nenhuma resposta foi enviada ao paciente.',
            folder,
          );
          return;
        }
        paraEnviar = r.texto;
        // Todo caminho de falha da marcação retorna antes com 'escalar',
        // então a ação já carrega o fato: não precisa de campo próprio.
        agendouNesteTurno = r.acao === 'marcar';
        intencaoDoTurno = r.intencao;
        acaoDoTurno = r.acao;
        perguntaDoTurno = perguntaReal;
      }

      // A guarda roda nos DOIS caminhos. No de template ela inspeciona texto
      // já aprovado, o que parece redundante e não é: quem aprova é humano, e
      // o teste estrutural existe justamente porque um texto novo pode trazer
      // um travessão ou um valor trocado. Defesa em profundidade só vale se a
      // segunda camada não for pulada pela primeira.
      if (paraEnviar && wantsOutputGuard(group.folder)) {
        // `agendouDeVerdade` só é verdadeiro quando a marcação foi confirmada
        // pela releitura da agenda. Sem o fato, a guarda bloqueia "está
        // agendado" — e deve bloquear.
        const veredito = inspecionaSaida(paraEnviar, {
          agendouDeVerdade: agendouNesteTurno,
          intencao: intencaoDoTurno,
        });
        const precisaAvisar = veredito.achados.some(
          (a) => a.nivel !== 'sanitize',
        );
        if (veredito.bloqueado || precisaAvisar) {
          const { jid, folder } = destinoDoAviso();
          const canalAviso =
            findChannelForGroup(channels, folder) || findChannel(channels, jid);
          canalAviso
            ?.sendMessage(jid, resumoDoAviso(veredito, paraEnviar))
            .catch((err) =>
              logger.warn({ err }, 'output-guard: aviso não saiu'),
            );
        }
        if (veredito.bloqueado) {
          logger.warn(
            { group: group.name, achados: veredito.achados },
            'output-guard: resposta BLOQUEADA',
          );
          paraEnviar = '';
        } else {
          if (veredito.achados.length > 0) {
            logger.info(
              { group: group.name, achados: veredito.achados },
              'output-guard: achados',
            );
          }
          paraEnviar = veredito.texto;
        }
      }

      if (paraEnviar) {
        // Revisão humana: a resposta vai ao GRUPO antes do paciente.
        //
        // Escalonamento passa direto: o caso já está com um humano, e pedir que
        // ele aprove a mensagem que diz "olha isto" é uma volta inútil.
        //
        // ⛔ MENOS EM OBSERVAÇÃO, e isto custou um incidente em produção
        // (20/10/2026): 13 mensagens "Só um instante." chegaram a 5 pacientes
        // reais a partir do número principal, uma delas seis vezes para quem
        // tinha escrito que o olho estava doendo.
        //
        // A exclusão acima está CERTA para o modo revisão — o humano já vai ver
        // o caso. Em observação a premissa inverte: o objetivo é que NADA chegue
        // ao paciente, e "Só um instante." é uma mensagem ao paciente. E
        // escalonamento é o desfecho mais comum de uma DM desconhecida, então
        // era o caminho principal, não borda.
        //
        // O humano continua sendo notificado: quem avisa é `escala()`, dentro do
        // executor, que não passa por aqui. O que esta linha recusa é a ENTREGA.
        if (retemResposta(group.folder, chatJid, acaoDoTurno)) {
          const partes = mensagensDe(paraEnviar);
          if (partes.length > 0) {
            const alvo = destinoDaRevisao();
            const pendente = registraParaRevisao(group.folder, {
              chatJid,
              partes,
              intencao: intencaoDoTurno,
              pergunta: perguntaDoTurno.slice(0, 200),
              // A marcação no iClinic já aconteceu: segurar o texto não desfaz.
              jaMarcou: acaoDoTurno === 'marcar',
            });
            // Fallback pelo JID, como o escalonamento faz. Sem ele, um
            // REVISAO_FOLDER errado faria a revisão sumir EM SILÊNCIO: a
            // pendência existiria, ninguém veria, e o paciente esperaria —
            // inclusive a cobrança de 3 min, que vai pelo mesmo caminho.
            const canalRevisao =
              findChannelForGroup(channels, alvo.folder) ||
              findChannel(channels, alvo.jid);
            if (!canalRevisao) {
              logger.error(
                { jid: alvo.jid, folder: alvo.folder },
                'revisão: nenhum canal para o destino, resposta NÃO foi revisada',
              );
            }
            const observando = emObservacao(group.folder, chatJid);
            await canalRevisao?.sendMessage(
              alvo.jid,
              textoDaRevisao(pendente, observando),
              'revisao',
            );
            logger.info(
              {
                group: group.name,
                codigo: pendente.codigo,
                partes: partes.length,
                observacao: observando,
              },
              observando
                ? 'observação: resposta registrada, NÃO vai ao paciente'
                : 'revisão: resposta aguardando aprovação',
            );
            return;
          }
        }

        let inicioDaMensagem = inicioDoTurno;
        let enviou = false;
        if (wantsHumanCadence(group.folder)) {
          // A cadência é por MENSAGEM, não pela resposta inteira: o alvo é o
          // tempo de digitar aquele texto, e somar o das duas faria a segunda
          // chegar tarde demais.
          for (const parte of mensagensDe(paraEnviar)) {
            const espera = humanDelayMs(parte, Date.now() - inicioDaMensagem);
            if (espera > 0) {
              logger.debug(
                { group: group.name, espera },
                'cadência humana: aguardando antes de enviar',
              );
              // Mantém o "digitando" de pé: a presença do WhatsApp expira, e
              // silêncio sem indicador parece queda, não pessoa pensando.
              await channel.setTyping?.(chatJid, true);
              await sleep(espera);
            }
            await channel.sendMessage(chatJid, parte, 'turno');
            // A próxima mensagem conta o tempo dela, do zero.
            inicioDaMensagem = Date.now();
          }
          enviou = true;
        }
        if (!enviou) {
          for (const parte of mensagensDe(paraEnviar)) {
            await channel.sendMessage(chatJid, parte, 'turno');
          }
        }
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // ⛔ Chave COMPOSTA em DM observada: sem isto todos os pacientes
  // compartilhavam uma sessão e o contexto de um entrava no turno de outro.
  // Ver `chaveDaSessao`.
  const chaveSessao = chaveDaSessao(group.folder, chatJid);
  const sessionId = sessions[chaveSessao];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[chaveSessao] = output.newSessionId;
          setSession(chaveSessao, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[chaveSessao] = output.newSessionId;
      setSession(chaveSessao, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[chaveSessao];
        deleteSession(chaveSessao);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      // Grupos ∪ DMs acompanhadas. A DM não está em `registered_groups` de
      // propósito (ver `dm-observada.ts`), então ela precisa entrar aqui.
      const jids = chatsAcompanhados(registeredGroups, dmsObservadas);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = grupoDoChat(chatJid);
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // ⛔ Resposta a PIPELINE não abre turno.
          //
          // Às 15h o lembrete sai e os pacientes respondem "SIM". Sem isto cada
          // um vira um "Só um instante." — 24 das 55 entradas da fila em
          // 22/10/2026. Exige as três condições de `respostaDePipeline`: quem
          // responde "SIM" e pede algo junto continua sendo atendido.
          //
          // ⚠️ Suprimir é não ABRIR TURNO; a mensagem fica gravada como
          // contexto, igual à fala da secretária.
          //
          // ⚠️ Esta trava NÃO é portada por `emObservacao`, ao contrário da
          // vizinha, e é de propósito: ela precisa valer quando a Lara assumir,
          // e aí a pasta sai de `OBSERVACAO_FOLDERS`. É isso que torna o
          // `some((m) => !m.is_from_me)` de `soEcoDePipeline` load-bearing —
          // sem ele um lote só de `is_from_me` (o grupo principal) satisfaria o
          // `every` por vacuidade.
          // ⛔ O expediente ANTES de qualquer despacho, porque um dos dois
          // caminhos daqui (canalizar para container vivo) não passa por
          // `processGroupMessages` e por isso não via horário nenhum.
          if (expedienteSegura(group, chatJid, groupMessages.length)) continue;

          const doPipeline = pipelinePorChat[chatJid];
          if (soEcoDePipeline(groupMessages, doPipeline, Date.now())) {
            logger.info(
              {
                chatJid,
                origin: doPipeline?.origin,
                mensagens: groupMessages.length,
              },
              'pipeline: resposta entra como contexto, sem virar turno',
            );
            continue;
          }

          // ⛔ Numa DM observada, a SECRETÁRIA não dispara turno.
          //
          // Desde 22/10/2026 as falas dela são gravadas (antes o canal as
          // descartava, e a Lara lia metade do diálogo). Gravar sem esta trava
          // faria a Lara responder à própria clínica — o `requiresTrigger` da
          // DM é `false`, então qualquer mensagem nova dispararia.
          //
          // `every`, não `some`: se o lote tem fala da secretária E do
          // paciente, o turno acontece, e a fala dela entra como contexto. Só
          // um lote INTEIRO da clínica é que não é turno.
          //
          // `emObservacao` já exige chat que não seja grupo, então isto não
          // alcança o grupo principal, onde `is_from_me` dispara de propósito.
          if (
            emObservacao(group.folder, chatJid) &&
            soFalaDaClinica(groupMessages)
          ) {
            logger.info(
              { chatJid, mensagens: groupMessages.length },
              'observação: fala da clínica entra como contexto, sem virar turno',
            );
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          //
          // ⚠️ Este é o SEGUNDO caminho de prompt: quando já há container vivo,
          // as mensagens novas são canalizadas para ele em vez de passarem por
          // `processGroupMessages`. Em 05/10/2026 isso fez o "Oi" funcionar (abre
          // o container, caminho completo) e o "2" seguinte escalar — ele chegava
          // ao classificador como 137 caracteres, só a própria mensagem, sem o
          // menu que a Lara tinha acabado de mandar.
          //
          // A lista de intenções não precisa ser repetida aqui: a sessão do
          // agente já a tem do primeiro turno. As falas da Lara, sim, porque o
          // texto do menu quem produziu foi o host.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
            wantsTemplates(group.folder),
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            // ⛔ Menos em observação: presença é egresso. Ver o comentário no
            // `setTyping` do início do turno.
            if (podeMostrarPresenca(group.folder, chatJid))
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Retoma as conversas que o expediente segurou.
 *
 * ⚠️ Sem isto, mensagem da noite NUNCA é respondida.
 *
 * O laço principal busca por um cursor GLOBAL (`lastTimestamp`) e o avança
 * assim que lê, antes de despachar. O gate do expediente devolve sem avançar o
 * cursor DA CONVERSA, que era o que eu tinha conferido — mas o global já passou
 * por aquela mensagem. Resultado: às 8h o laço não busca nada, o handler do
 * grupo nunca é chamado, e a conversa só volta se o paciente escrever de novo.
 * Achado do review adversarial do Codex em 19/10/2026, e eu havia afirmado o
 * contrário ao Thiago no mesmo dia.
 *
 * A varredura é a mesma do `recoverPendingMessages`, que já existia para o
 * reinício: comparar o cursor da conversa e enfileirar. Só nas pastas com
 * expediente, e só dentro do horário — fora dele enfileirar faria o gate
 * devolver de novo, num laço de um minuto.
 */
function retomaConversasDoExpediente(): void {
  if (!dentroDoExpediente()) return;
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (!wantsExpediente(group.folder)) continue;
    const pendentes = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
      wantsTemplates(group.folder),
    );
    // ⚠️ Só retoma se houver mensagem DO PACIENTE pendente.
    //
    // `getMessagesSince` em pasta com template devolve TAMBÉM as falas da Lara,
    // de propósito: o classificador precisa ver o que ela disse. Mas aqui isso
    // criava um laço que se alimenta, medido em produção em 20/10/2026, com a
    // observação recém-ligada:
    //
    //   a Lara posta "Só um instante." -> a fala dela fica depois do cursor ->
    //   a varredura de 60 s vê "pendente" -> re-enfileira -> novo turno ->
    //   escala -> posta de novo -> ...
    //
    // Resultado: um "Só um instante." no grupo e um escalonamento no DM do
    // Thiago a cada ciclo, pela MESMA pergunta, com código novo a cada vez
    // (73NK, YBXK, QH9Q). "Conversa segurada" significa que o PACIENTE escreveu
    // e nós retivemos; fala da Lara não é trabalho retido.
    const doPaciente = pendentes.filter((m) => !m.is_bot_message);
    if (doPaciente.length === 0) continue;
    logger.info(
      { group: group.name, pendentes: doPaciente.length },
      'expediente: retomando conversa segurada fora do horário',
    );
    queue.enqueueMessageCheck(chatJid);
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.closeAllConnections();
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  /**
   * ⛔ A política de egresso que o canal consulta no instante do envio.
   *
   * Mora AQUI porque só o host sabe a pasta de cada alvo. O canal garante que
   * nada sai sem perguntar; a decisão é desta função.
   *
   * ⚠️ DM de paciente em observação não está em `registeredGroups` (verificado
   * em 20/10/2026: a tabela tem 5 linhas e nenhuma DM de paciente). Então para
   * DM desconhecida a pasta é a de observação de DM, que é sob qual pasta
   * aquele turno roda. Sem isso a política não acharia a pasta e recusaria tudo.
   */
  const politicaDeEgresso = (opts: {
    alvo: string;
    origem?: string;
    tipo: 'texto' | 'imagem' | 'documento' | 'presenca';
  }): boolean => {
    const dmEnv = readEnvFile(['DM_OBSERVACAO_FOLDER']);
    const pastaDeDm = pastaDeObservacaoDeDm(
      process.env.DM_OBSERVACAO_FOLDER || dmEnv.DM_OBSERVACAO_FOLDER || '',
    ).folder;
    const folderDoAlvo = registeredGroups[opts.alvo]?.folder || pastaDeDm;
    return podeEntregar({
      alvo: opts.alvo,
      origem: opts.origem as OrigemDeEgresso | undefined,
      folderDoAlvo: folderDoAlvo || undefined,
    });
  };

  const channelOpts = {
    podeEntregar: politicaDeEgresso,
    onMessage: (chatJid: string, msg: NewMessage) => {
      // ⛔ A VIGIA DA CAPTURA. Ver `vigia-captura.ts`.
      //
      // Marca aqui, e não no canal, porque este é o ponto por onde TODA
      // mensagem passa: um caminho de captura novo que não chegue aqui não
      // grava nada, e é exatamente isso que a vigia tem de notar.
      //
      // Só conta mensagem DE PACIENTE: a fala da secretária passa por aqui
      // desde 22/10 e, se contasse, uma clínica respondendo sozinha manteria a
      // vigia calada justamente quando a captura do paciente quebrou.
      if (!msg.is_from_me && !chatJid.endsWith('@g.us')) {
        vigia.ultimaCaptura = Date.now();
      }

      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Aprovação de resposta: "ok R7K2" de quem recebe a revisão.
      //
      // Vem ANTES da baixa de escalonamento porque os dois usam o mesmo
      // "ok XXXX": se o código for de uma resposta pendente, aprovar é o que
      // se quis dizer. `aprovaEmQualquerPasta` devolve undefined quando não é,
      // e aí o fluxo segue para a baixa.
      if (!msg.is_bot_message && podeAprovar(chatJid)) {
        const codigo = codigoDaBaixa(trimmed);
        // ⚠️ Em observação `aprova` recusa e devolve undefined — e sem este
        // aviso o fluxo cairia na baixa de escalonamento e o `ok` morreria em
        // silêncio. Falhar calado é o pior desfecho: quem digitou acha que
        // aprovou. Mesmo raciocínio do comentário do `REVISAO_JID`.
        const pendenteEmObservacao =
          codigo &&
          pastasComRevisao().some((f) =>
            lePendentes(f).some(
              (x) =>
                x.codigo.toUpperCase() === codigo.toUpperCase() &&
                emObservacao(f, x.chatJid),
            ),
          );
        if (pendenteEmObservacao) {
          logger.warn(
            { codigo },
            'observação: `ok` recusado, nada é enviado ao paciente',
          );
          findChannel(channels, chatJid)
            ?.sendMessage(
              chatJid,
              `👁️ ${codigo} NÃO foi enviado: estamos em modo observação.\n\n` +
                `Quem responde o paciente esta semana é a secretária.`,
            )
            .catch((err) =>
              logger.warn({ err }, 'observação: aviso do `ok` falhou'),
            );
          return;
        }
        const achado = codigo ? aprovaEmQualquerPasta(codigo) : undefined;
        if (achado) {
          const { pendente } = achado;
          const canalPaciente = findChannel(channels, pendente.chatJid);
          // VERBATIM: a guarda já inspecionou e a cadência já não se aplica —
          // o tempo de revisão foi a espera. Em sequência, para as duas partes
          // chegarem na ordem.
          // ⚠️ A pendência só sai da fila DEPOIS da entrega, e o "enviado" só
          // é dito depois também. Antes disso, um reinício ou uma falha de rede
          // no meio apagava a única cópia da resposta — e deixava o paciente
          // sem a confirmação de uma consulta já marcada na agenda. Achado do
          // review adversarial do Codex em 19/10/2026.
          void (async () => {
            for (const parte of pendente.partes) {
              // `revisao`: isto foi aprovado por uma PESSOA. Sem declarar, a
              // política de egresso trataria como `turno` e barraria a
              // aprovação do humano — a trava viraria uma prisão.
              await canalPaciente?.sendMessage(
                pendente.chatJid,
                parte,
                'revisao',
              );
            }
            concluiEnvio(achado.folder, pendente.codigo);
            logger.info(
              { codigo: pendente.codigo, partes: pendente.partes.length },
              'revisão: aprovada e entregue ao paciente',
            );
            findChannel(channels, chatJid)
              ?.sendMessage(
                chatJid,
                `✅ ${pendente.codigo} enviado ao paciente.`,
              )
              .catch((err) => logger.warn({ err }, 'revisão: ack falhou'));
          })().catch((err) => {
            // Volta para a fila: alguém tem de poder tentar de novo.
            devolveAFila(achado.folder, pendente.codigo);
            logger.error(
              { err, codigo: pendente.codigo },
              'revisão: envio falhou, pendência devolvida à fila',
            );
            findChannel(channels, chatJid)?.sendMessage(
              chatJid,
              `⚠️ ${pendente.codigo} NÃO foi entregue. Responda *ok ${pendente.codigo}* de novo.`,
            );
          });
          storeMessage(msg);
          return;
        }
      }

      // Baixa de escalonamento: "ok E7K2" de quem recebe a cobrança.
      if (!msg.is_bot_message && podeDarBaixa(chatJid)) {
        const codigo = codigoDaBaixa(trimmed);
        if (codigo) {
          const baixada = baixaPorCodigo(codigo);
          const resposta = baixada
            ? `✅ ${codigo} baixado: ${baixada.motivo}`
            : `não achei ${codigo} em aberto (já baixado, ou código errado)`;
          const canal = findChannel(channels, chatJid);
          canal
            ?.sendMessage(chatJid, resposta)
            .catch((err) =>
              logger.warn({ err, codigo }, 'escalation-sla: ack falhou'),
            );
          storeMessage(msg);
          return;
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      // ⚠️ `grupoDoChat`, não o mapa cru: a DM observada ENTRA no descarte por
      // remetente (decisão do Thiago, 22/10/2026). Hoje não muda nada — não há
      // `sender-allowlist.json` —, mas é o que permite bloquear um número no
      // dia em que precisar, sem código novo. Ver `docs/DM-SEM-REGISTRO.md`.
      if (!msg.is_from_me && !msg.is_bot_message && grupoDoChat(chatJid)) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    // Uma DM de paciente ganha pasta na primeira mensagem. Reusa o
    // `registerGroup`, que já valida a pasta, cria o diretório e grava no
    // banco — então o resto do pipeline não sabe que isto é uma DM.
    registraDmEmObservacao: (
      chatJid: string,
      folder: string,
      desdeIso: string,
    ) => {
      // ⛔ A DM NÃO vira grupo registrado. Até 22/10/2026 esta função chamava
      // `registerGroup`, e aquilo (a) lançava sempre, por passar
      // `triggerPattern` onde o tipo pede `trigger` e não passar `added_at`,
      // (b) teria APAGADO a linha do grupo de atendimento se não lançasse,
      // porque `folder` é UNIQUE e o insert é `INSERT OR REPLACE`, e (c)
      // desarmaria o gate de DM do `ipc.ts`, que se abre para chat registrado.
      // Ver `docs/DM-SEM-REGISTRO.md`.
      if (registeredGroups[chatJid]) return;
      // ⚠️ Chamado a CADA mensagem, não só na primeira: com a DM fora de
      // `registered_groups`, a condição do canal
      // (`if (!registeredGroups()[chatJid])`) é sempre verdadeira. O `vistaEm`
      // é renovado aqui — sem isso a poda apagaria um paciente ATIVO 7 dias
      // depois do primeiro contato, e o cursor dele iria junto.
      const novaDm = !dmsObservadas[chatJid];
      const historico = novaDm
        ? historicoParaSemear(chatJid, desdeIso)
        : undefined;
      // ⛔ O piso do cursor. Sem histórico, é a mensagem que revelou a DM:
      // `getOrRecoverCursor` devolve '' para chat desconhecido, e aí a primeira
      // rodada varreria todo o histórico gravado daquele chat. "Só mensagens
      // novas" (Thiago, 19/10/2026). Com histórico, é o último evento semeado —
      // usar `desdeIso` faria o host reprocessar o que acabou de entrar.
      const piso = historico?.cursor ?? desdeIso;
      // ⛔ UMA transação para as TRÊS coisas: o cursor, as linhas do histórico e
      // o registro da DM. Ou as três valem, ou nenhuma vale.
      //
      // Antes a semeadura tinha a sua própria transação e o registro vinha
      // depois, num `saveState` separado: morrer entre os dois deixava cursor e
      // histórico gravados com o chat FORA de `dmsObservadas` — semeado e não
      // acompanhado, que é pior que não ter semeado. Achado do Codex, 22/10.
      //
      // ⚠️ A linha da mensagem que DESCOBRIU a DM continua fora: quem a grava é
      // o `onMessage` do canal, depois deste callback retornar. A janela
      // encurta, não fecha — e o que resta se cura na próxima mensagem do
      // paciente, que redescobre a DM e semeia a anterior como contexto.
      // `anotaDm` é idempotente no piso justamente para isso.
      const cursorAnterior = lastAgentTimestamp[chatJid];
      const dmsAnterior = dmsObservadas;
      try {
        runInTransaction(() => {
          if (novaDm) lastAgentTimestamp[chatJid] = piso;
          dmsObservadas = anotaDm(
            dmsObservadas,
            chatJid,
            folder,
            piso,
            new Date().toISOString(),
          );
          saveState();
          for (const m of historico?.mensagens ?? []) storeMessage(m);
        });
      } catch (err) {
        // O banco voltou atrás; a memória tem de voltar também, senão o cursor
        // fica adiantado só neste processo — o pior dos dois mundos.
        if (cursorAnterior === undefined) delete lastAgentTimestamp[chatJid];
        else lastAgentTimestamp[chatJid] = cursorAnterior;
        dmsObservadas = dmsAnterior;
        logger.warn({ err, chatJid, folder }, 'registro da DM falhou');
        return;
      }
      if (historico) {
        logger.info(
          {
            chatJid,
            mensagens: historico.mensagens.length,
            cursor: historico.cursor,
          },
          'histórico semeado: a conversa deixa de entrar sem passado',
        );
      }
      if (novaDm) {
        logger.info(
          { chatJid, folder, semeado: !!historico },
          'DM de paciente passa a ser acompanhada',
        );
      }
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Optional second WhatsApp instance for sending from the atendimento number
  const atendimentoEnv = readEnvFile(['WHATSAPP_ATENDIMENTO_PAIRING_NUMBER']);
  const atendimentoPairingNumber =
    process.env.WHATSAPP_ATENDIMENTO_PAIRING_NUMBER ||
    atendimentoEnv.WHATSAPP_ATENDIMENTO_PAIRING_NUMBER;
  if (atendimentoPairingNumber) {
    // ⚠️ A trava de configuração. Observar DM sem a pasta em observação faria a
    // Lara RESPONDER paciente real — exatamente o que esta semana não é. Então
    // a env é ignorada, com erro no log, se a pasta não estiver travada.
    const dmEnv = readEnvFile(['DM_OBSERVACAO_FOLDER']);
    const checada = pastaDeObservacaoDeDm(
      process.env.DM_OBSERVACAO_FOLDER || dmEnv.DM_OBSERVACAO_FOLDER || '',
    );
    const dmObservacaoFolder = checada.folder;
    if (checada.motivo) {
      logger.error(
        { motivo: checada.motivo },
        'DM_OBSERVACAO_FOLDER ignorada: configuração recusada',
      );
    } else if (dmObservacaoFolder) {
      logger.warn(
        { pasta: dmObservacaoFolder },
        'observação: DMs do atendimento viram turno; nada vai ao paciente',
      );
    }
    const atendimentoChannel = new WhatsAppChannel({
      ...channelOpts,
      authSubDir: 'auth-atendimento',
      pairingNumber: atendimentoPairingNumber,
      groupFolderOwner: PASTA_DO_SLA,
      // MODO OBSERVAÇÃO das DMs de paciente (Thiago, 19/10/2026): quando esta
      // env existe, as DMs deste número viram turno e a resposta vai ao destino
      // da revisão, nunca ao paciente.
      //
      // ⚠️ Sem a env, o comportamento é o de antes: estritamente outbound. E a
      // pasta apontada aqui PRECISA estar em `OBSERVACAO_FOLDERS`, senão a
      // resposta sairia para o paciente — é a diferença entre observar e ir ao
      // ar. O `index.ts` recusa a configuração se isso não estiver de pé.
      dmObservacaoFolder: dmObservacaoFolder || undefined,
    });
    channels.push(atendimentoChannel);
    // Outbound-only instance: connect in the background. Blocking startup on it
    // is dangerous — if it never opens (e.g. awaiting pairing, or it logs out
    // before its first open), the scheduler and message loop below would never
    // start and the whole bot goes mute while the primary number stays online.
    atendimentoChannel
      .connect()
      .then(() => logger.info('Atendimento WhatsApp channel connected'))
      .catch((err) =>
        logger.error({ err }, 'Atendimento WhatsApp channel failed to connect'),
      );
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, groupFolder) => {
      // Prioriza a instância DONA do grupo (ex: o número do atendimento posta no
      // grupo do atendimento). Fallback pro principal (findChannel por JID).
      const channel =
        (groupFolder && findChannelForGroup(channels, groupFolder)) ||
        findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      // `script`: o IPC já validou a origem fixa em `patientDmBlocked`.
      if (text) await channel.sendMessage(jid, text, 'script');
    },
  });
  startEscalationSla({
    sendMessage: (jid, text, groupFolder) => {
      const channel =
        (groupFolder && findChannelForGroup(channels, groupFolder)) ||
        findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'escalation-sla: nenhum canal para o destino');
        return;
      }
      // `alerta`: aviso a humano, nunca texto a paciente.
      return channel.sendMessage(jid, text, 'alerta');
    },
  });
  // Mesma escada, mesmo relógio: uma resposta pronta e não aprovada é um
  // paciente esperando, e a cobrança é a única coisa que impede isso de virar
  // silêncio. Nada sai sem aprovação (decisão do Thiago, 17/10/2026).
  // A cada minuto: dentro do expediente, o que ficou segurado volta à fila.
  // Barato — um SELECT por pasta com expediente, e a maioria devolve vazio.
  setInterval(() => {
    try {
      retomaConversasDoExpediente();
    } catch (err) {
      logger.warn({ err }, 'expediente: varredura de retomada falhou');
    }
  }, 60_000);

  if (pastasComRevisao().length > 0) {
    const enviaRevisao = (jid: string, text: string, groupFolder?: string) => {
      const channel =
        (groupFolder && findChannelForGroup(channels, groupFolder)) ||
        findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'revisão: nenhum canal para o destino');
        return;
      }
      return channel.sendMessage(jid, text, 'alerta');
    };
    logger.info(
      { pastas: pastasComRevisao(), destino: destinoDaRevisao() },
      'revisão humana: respostas vão ao grupo antes do paciente',
    );
    setInterval(() => {
      void tickRevisaoSla({ sendMessage: enviaRevisao, tocaAlarme }).catch(
        (err) => logger.warn({ err }, 'revisão: tick falhou'),
      );
    }, 60_000);
  }
  // ⛔ Vigia da captura: avisa quando a observação para de observar.
  //
  // `ultimaCaptura` começa AGORA, na subida: sem marca o alarme nunca toca, e
  // com marca zero ele tocaria em todo deploy. O relógio conta a partir daqui.
  setInterval(() => {
    try {
      const aviso = avisoDeCapturaParada({
        agora: Date.now(),
        observando: algumaPastaEmObservacao(),
        noExpediente: dentroDoExpediente(),
        estado: vigia,
      });
      if (!aviso) return;
      vigia.ultimoAviso = Date.now();
      const { jid, folder } = destinoDoAviso();
      logger.warn(
        { minutos: aviso.minutos },
        'vigia: observação sem captura de paciente',
      );
      const canal =
        findChannelForGroup(channels, folder) || findChannel(channels, jid);
      void canal
        ?.sendMessage(jid, textoDoAviso(aviso.minutos), 'alerta')
        .catch((err) => logger.warn({ err }, 'vigia: aviso não saiu'));
    } catch (err) {
      logger.warn({ err }, 'vigia: tick falhou');
    }
  }, 5 * 60_000);

  startIpcWatcher({
    registraPipeline: (chatJid, origin) => {
      const agora = Date.now();
      // Poda no caminho de ESCRITA: `loadState` só roda na subida, e o processo
      // fica semanas de pé. Um `for` sobre algumas dezenas de entradas é grátis
      // comparado a re-serializar um mapa que cresce para sempre.
      pipelinePorChat = podaPipelines(pipelinePorChat, agora);
      pipelinePorChat[chatJid] = { origin, quando: agora };
      saveState();
    },
    sendMessage: (jid, text, groupFolder) => {
      const channel =
        (groupFolder && findChannelForGroup(channels, groupFolder)) ||
        findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // ⚠️ `script` nos TRÊS egressos do IPC: o `patientDmBlocked` de ipc.ts já
      // validou a origem fixa antes de chegar aqui, e é ele o guardião desse
      // caminho. Declarar `script` é o que preserva o lembrete de consulta, a
      // auto-resposta, a nota fiscal e a avaliação pós-consulta durante a
      // observação — bloquear por alvo os quebraria.
      return channel.sendMessage(jid, text, 'script');
    },
    sendImage: async (jid, imagePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendImage) {
        logger.warn({ jid }, 'Channel does not support sendImage');
        return;
      }
      return channel.sendImage(jid, imagePath, caption, 'script');
    },
    sendDocument: async (jid, filePath, fileName, caption, groupFolder) => {
      const channel =
        (groupFolder && findChannelForGroup(channels, groupFolder)) ||
        findChannel(channels, jid);
      if (!channel?.sendDocument) {
        logger.warn({ jid }, 'Channel does not support sendDocument');
        return;
      }
      return channel.sendDocument(jid, filePath, fileName, caption, 'script');
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
