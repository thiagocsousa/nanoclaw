/**
 * Revisão humana: a resposta vai ao grupo antes de ir ao paciente.
 *
 * ## Por que existe
 *
 * Decisão do Thiago em 17/10/2026, antes de abrir para pacientes de verdade:
 * *"queria que enviasse a resposta pro grupo de atendimento, para avaliarmos
 * antes de responder ao paciente, e após autorização enviar pra ele. Acho que
 * ficaríamos mais confortáveis com essa alternativa antes de deixar 100%
 * automatizado."*
 *
 * É uma fase de confiança, não o desenho final: a tabela de templates já
 * garante que o TEXTO foi aprovado por humano uma vez, e o que a revisão
 * acrescenta é conferir se foi o texto CERTO para aquela pergunta. Os dois
 * erros da passada 13 ("campimetria e OCT" respondido com a tabela de preços,
 * cobertura de EXAME respondida com a da cirurgia) são exatamente o que ela
 * pega e nenhuma guarda pegaria: os dois textos estavam corretos, só não
 * respondiam o que foi perguntado.
 *
 * ## Um passo de aprovação já foi removido antes, e não é o mesmo
 *
 * `agendamento.ts` registra que eu havia construído aprovação para a MARCAÇÃO e
 * removido, porque "uma pessoa clicando confirmar três minutos depois" não
 * protege contra colisão de horário. Aquele argumento é sobre uma corrida de
 * escrita. Aqui o risco é outro: resposta errada chegando ao paciente, que uma
 * pessoa lendo três minutos depois pega muito bem.
 *
 * ## O que NÃO passa por revisão
 *
 * Escalonamento. O caso já está na mão de um humano, e pedir que ele aprove uma
 * mensagem que diz "olha isto" é uma volta inútil.
 *
 * ## Marcação já aconteceu quando o texto chega aqui
 *
 * ⚠️ Em `aceita_horario`, o `marca()` escreve no iClinic ANTES de o texto ser
 * enviado, e a revisão não desfaz isso. Segurar a escrita seria pior: a vaga
 * pode ser tomada enquanto a confirmação espera aprovação, e aí o paciente
 * recebe um "está agendado" sobre um horário que outro levou.
 *
 * Então, nesses casos, o horário JÁ ESTÁ na agenda e só falta avisar o
 * paciente. A mensagem para o grupo diz isso com todas as letras, e a pendência
 * entra como urgente: esquecer dela deixa alguém com consulta marcada e sem
 * saber.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { destinoDoAviso, proximoDegrau } from './escalation-sla.js';
import { logger } from './logger.js';

const envConfig = readEnvFile([
  'REVISAO_HUMANA_FOLDERS',
  'REVISAO_JID',
  'REVISAO_FOLDER',
  'OBSERVACAO_FOLDERS',
]);

function env(key: string, fallback = ''): string {
  return process.env[key] || envConfig[key] || fallback;
}

const FOLDERS = new Set(
  env('REVISAO_HUMANA_FOLDERS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * MODO OBSERVAÇÃO: a resposta vai para revisão e NUNCA sai ao paciente.
 *
 * Decisão do Thiago em 19/10/2026, para a semana de 20/10: a Lara passa a ler o
 * grupo real, calcula a resposta e manda só para o grupo de teste, para a equipe
 * julgar a coerência. Quem responde o paciente nessa semana é a secretária
 * humana.
 *
 * ⚠️ É TRAVA, não convenção. "Não vamos aprovar nenhuma" bastaria se ninguém
 * errasse: um `ok R7K2` digitado por engano no grupo liberaria mensagem para um
 * paciente REAL. Em observação o `aprova` recusa, então o erro não tem como
 * acontecer.
 *
 * E desliga a cobrança e o alarme do SLA (o Thiago pediu o alarme desligado no
 * mesmo dia). Sem isso, TODA resposta da semana ficaria pendente para sempre,
 * gerando cobrança e alarme em cada conversa — e aviso que aparece em tudo é
 * aviso que ninguém lê, que é o defeito já documentado neste projeto.
 */
const OBSERVACAO = new Set(
  env('OBSERVACAO_FOLDERS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Um chat de GRUPO. DM é o que não é. */
function ehGrupo(chatJid?: string): boolean {
  return !!chatJid && chatJid.endsWith('@g.us');
}

/**
 * Observação vale por CHAT, não pela pasta inteira.
 *
 * Primeira versão era por pasta, e isso forçava uma pasta nova só para as DMs —
 * que exigiria duplicar `templates.json`, `CLAUDE.md`, o FAQ e os scripts,
 * porque o container monta SÓ a própria pasta do grupo (`container-runner.ts`) e
 * um symlink para a pasta vizinha fica pendurado lá dentro. Duas tabelas
 * divergindo é o defeito que mais custou neste projeto.
 *
 * Com a trava por chat, as DMs de paciente moram na MESMA pasta do grupo de
 * teste: tabela única, CLAUDE.md único, scripts únicos. A memória de conversa já
 * é por `chatJid`, então as conversas não se misturam.
 *
 * ⚠️ E o chat do GRUPO continua respondendo normalmente — é o que a suíte
 * precisa. Pôr a pasta inteira em observação calaria a passada.
 */
export function emObservacao(groupFolder?: string, chatJid?: string): boolean {
  if (!groupFolder || !OBSERVACAO.has(groupFolder)) return false;
  // Sem chat, a pergunta é "esta pasta tem observação ligada?" — usada pela
  // validação de configuração no startup.
  if (chatJid === undefined) return true;
  return !ehGrupo(chatJid);
}

/**
 * Valida a pasta de observação de DM pedida por env.
 *
 * ⛔ É a trava de CONFIGURAÇÃO, e protege a única falha que importa nesta
 * semana: ler DM de paciente numa pasta que NÃO está em observação faria a Lara
 * RESPONDER paciente real. A diferença entre observar e ir ao ar é uma linha de
 * `.env`, e um erro de digitação não pode decidir isso.
 *
 * Devolve a pasta quando é segura, e `''` com o motivo quando não é — quem
 * chama registra o motivo no log e segue sem observação, que é o estado seguro.
 */
export function pastaDeObservacaoDeDm(pedida: string): {
  folder: string;
  motivo?: string;
} {
  const p = pedida.trim();
  if (!p) return { folder: '' };
  if (!emObservacao(p)) {
    return {
      folder: '',
      motivo: `a pasta "${p}" não está em OBSERVACAO_FOLDERS, e sem isso a resposta iria ao paciente`,
    };
  }
  if (!wantsRevisaoHumana(p)) {
    return {
      folder: '',
      motivo: `a pasta "${p}" não está em REVISAO_HUMANA_FOLDERS, então a resposta não tem para onde ir e ninguém observaria nada`,
    };
  }
  return { folder: p };
}

/**
 * Para onde vai a resposta a revisar, e de onde a aprovação é aceita.
 *
 * ⚠️ Default é o destino do escalonamento, que hoje é a DM do Thiago — NÃO o
 * grupo de atendimento. O Thiago pediu o grupo, então em produção isto precisa
 * do `REVISAO_JID` apontando para lá. Sem env próprio, um `ok R7K2` mandado no
 * grupo seria ignorado em silêncio, que é o pior desfecho possível: a recepção
 * acha que aprovou e o paciente não recebe nada.
 */
function destino(): { jid: string; folder: string } {
  const padrao = destinoDoAviso();
  return {
    jid: env('REVISAO_JID', padrao.jid),
    folder: env('REVISAO_FOLDER', padrao.folder),
  };
}

export function destinoDaRevisao(): { jid: string; folder: string } {
  return destino();
}

export function wantsRevisaoHumana(groupFolder?: string): boolean {
  return !!groupFolder && FOLDERS.has(groupFolder);
}

/** Só de onde a revisão foi pedida se aceita a aprovação. */
export function podeAprovar(jid: string): boolean {
  return FOLDERS.size > 0 && jid === destino().jid;
}

export interface RespostaPendente {
  codigo: string;
  /** epoch ms de quando ficou pronta */
  quando: number;
  /** Para quem vai, depois de aprovada. */
  chatJid: string;
  /**
   * As mensagens já divididas e já inspecionadas pela guarda. Guardadas como
   * lista, e não como texto com separador dentro, porque na aprovação elas são
   * enviadas VERBATIM: a guarda não roda de novo (já rodou) e a cadência humana
   * não se aplica (o tempo de revisão já foi a espera).
   */
  partes: string[];
  intencao: string;
  /** O que o paciente perguntou, para quem revisa julgar se a resposta cabe. */
  pergunta: string;
  /** A marcação no iClinic já foi feita e só falta avisar. */
  jaMarcou?: boolean;
  cobrado?: boolean;
  alarmado?: boolean;
  /** Aprovada e em voo. Só sai da fila quando a entrega confirma. */
  enviando?: boolean;
}

const ARQUIVO = 'respostas_pendentes.json';
const ALFABETO = 'ABCDEFGHJKMNPQRTUVWXY34679';

function arquivo(folder: string): string {
  return path.join(GROUPS_DIR, folder, ARQUIVO);
}

export function lePendentes(folder: string): RespostaPendente[] {
  try {
    const d = JSON.parse(fs.readFileSync(arquivo(folder), 'utf-8'));
    return Array.isArray(d) ? (d as RespostaPendente[]) : [];
  } catch {
    return [];
  }
}

function grava(folder: string, itens: RespostaPendente[]): void {
  try {
    const alvo = arquivo(folder);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    const tmp = `${alvo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(itens, null, 2));
    fs.renameSync(tmp, alvo);
  } catch (err) {
    // ⚠️ Diferente da memória de conversa, perder isto NÃO é degradação
    // aceitável: a resposta some e o paciente fica sem nada. Por isso o erro é
    // logado como error, e quem chama trata a falha.
    logger.error({ err, folder }, 'revisao: NÃO gravou a pendência');
    throw err;
  }
}

function geraCodigo(usados: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) {
      c += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
    }
    if (!usados.has(c)) return c;
  }
  return `R${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

/** Guarda a resposta e devolve o código para quem revisa aprovar. */
export function registraParaRevisao(
  folder: string,
  dados: Omit<RespostaPendente, 'codigo' | 'quando'>,
): RespostaPendente {
  const itens = lePendentes(folder);
  const p: RespostaPendente = {
    ...dados,
    codigo: geraCodigo(new Set(itens.map((x) => x.codigo))),
    quando: Date.now(),
  };
  itens.push(p);
  grava(folder, itens);
  return p;
}

/** A mensagem que o grupo recebe. */
export function textoDaRevisao(
  p: RespostaPendente,
  observacao = false,
): string {
  const corpo = p.partes.map((t, i) => `*${i + 1}.* ${t}`).join('\n\n');
  const aviso = p.jaMarcou
    ? '\n\n⚠️ *O horário JÁ ESTÁ na agenda do iClinic.* Falta só avisar o paciente.'
    : '';
  // Em observação não promete envio: dizer "responda ok" seria convidar a
  // liberar mensagem para paciente real numa semana em que isso não é o acordo.
  const fecho = observacao
    ? '_Modo observação: isto NÃO foi enviado ao paciente._'
    : `Responda *ok ${p.codigo}* para enviar ao paciente.`;
  const cabeca = observacao
    ? `👁️ *Resposta que a Lara daria* · *${p.codigo}*`
    : `📝 *Resposta pronta* · *${p.codigo}*`;
  return (
    `${cabeca}\n\n` +
    `*Paciente:* ${p.pergunta}\n\n` +
    `${corpo}${aviso}\n\n` +
    `${fecho}`
  );
}

/**
 * Marca a pendência como aprovada e devolve o que enviar. Idempotente.
 *
 * ⚠️ NÃO remove. A primeira versão tirava da fila e gravava ANTES do envio, e
 * aí um reinício ou uma falha de rede no meio apagava a única cópia: repetir
 * "ok CODIGO" não recuperava nada, e o paciente ficava sem a confirmação de
 * uma consulta que já estava marcada na agenda. Achado do review adversarial
 * do Codex em 19/10/2026.
 *
 * Quem envia chama `concluiEnvio` depois de a entrega ter acontecido.
 */
export function aprova(
  folder: string,
  codigo: string,
): RespostaPendente | undefined {
  const itens = lePendentes(folder);
  const p = itens.find((x) => x.codigo.toUpperCase() === codigo.toUpperCase());
  if (!p) return undefined;
  // ⚠️ A TRAVA. Em observação nada sai ao paciente, nem com `ok CODIGO`.
  // Decide pelo CHAT da pendência: na mesma pasta, o grupo de teste responde e
  // a DM de paciente não.
  if (emObservacao(folder, p.chatJid)) {
    logger.warn(
      { folder, codigo, chatJid: p.chatJid },
      'revisão: aprovação RECUSADA, chat em modo observação',
    );
    return undefined;
  }
  if (p.enviando) {
    // Já aprovada e em voo: não manda duas vezes.
    return undefined;
  }
  p.enviando = true;
  grava(folder, itens);
  return p;
}

/** Tira da fila, depois de a resposta ter chegado ao paciente. */
export function concluiEnvio(folder: string, codigo: string): void {
  const itens = lePendentes(folder).filter(
    (x) => x.codigo.toUpperCase() !== codigo.toUpperCase(),
  );
  grava(folder, itens);
}

/** Devolve à fila: o envio falhou e alguém precisa tentar de novo. */
export function devolveAFila(folder: string, codigo: string): void {
  const itens = lePendentes(folder);
  const p = itens.find((x) => x.codigo.toUpperCase() === codigo.toUpperCase());
  if (!p) return;
  p.enviando = false;
  grava(folder, itens);
}

/** Procura o código em todas as pastas com revisão ligada. */
export function aprovaEmQualquerPasta(
  codigo: string,
): { folder: string; pendente: RespostaPendente } | undefined {
  for (const folder of FOLDERS) {
    const p = aprova(folder, codigo);
    if (p) return { folder, pendente: p };
  }
  return undefined;
}

export function pastasComRevisao(): string[] {
  return [...FOLDERS];
}

export function salvaPendentes(
  folder: string,
  itens: RespostaPendente[],
): void {
  grava(folder, itens);
}

/**
 * A escada de cobrança, reusando `proximoDegrau` do escalonamento.
 *
 * Reusar, e não copiar: duas escadas com os mesmos números em arquivos
 * diferentes divergem na primeira vez que alguém ajusta uma. Já aconteceu duas
 * vezes hoje com a mesma regra escrita em dois lugares (o escopo do
 * `empurra_trabalho` e a regex de telefone com e sem `\b`).
 *
 * Diferença de fundo em relação ao escalonamento: ali a cobrança é por um caso
 * esquecido; aqui é por um PACIENTE esperando uma resposta que já está pronta.
 * Nada sai sozinho — decisão do Thiago em 17/10/2026, com a alternativa de
 * enviar automaticamente após N minutos na mesa. Enviar sozinho faria a revisão
 * virar opcional: num dia corrido, tudo passaria sem ninguém ler.
 */
export interface RevisaoSlaDeps {
  sendMessage: (jid: string, texto: string, folder?: string) => unknown;
  tocaAlarme: () => Promise<void> | void;
}

export async function tickRevisaoSla(
  deps: RevisaoSlaDeps,
  agora: number = Date.now(),
): Promise<void> {
  const alvo = destino();
  for (const folder of FOLDERS) {
    const itens = lePendentes(folder);
    if (itens.length === 0) continue;
    let mudou = false;
    const cobrados: string[] = [];
    const alarmados: string[] = [];
    for (const p of itens) {
      // Em observação a pendência é só registro para leitura humana: ninguém vai
      // aprovar, então cobrar e alarmar seria ruído em cada conversa da semana.
      // Por CHAT: a pendência do grupo de teste continua sendo cobrada.
      if (emObservacao(folder, p.chatJid)) continue;
      // `proximoDegrau` lê `quando`, `cobrado`, `alarmado` e `urgente`. Uma
      // resposta com a marcação já feita é urgente: esquecer dela deixa alguém
      // com consulta na agenda e sem saber.
      const degrau = proximoDegrau(
        { ...p, motivo: '', pergunta: '', urgente: !!p.jaMarcou },
        agora,
      );
      if (degrau === 'nada') continue;
      const minutos = Math.floor((agora - p.quando) / 60_000);
      if (degrau === 'cobrar') {
        mudou = true;
        cobrados.push(p.codigo);
        deps.sendMessage(
          alvo.jid,
          `⏰ *${p.codigo}* esperando aprovação há ${minutos} min\n\n` +
            `O paciente está sem resposta. Responda *ok ${p.codigo}* para enviar.` +
            (p.jaMarcou
              ? '\n\n⚠️ O horário já está na agenda: ele não sabe ainda.'
              : ''),
          alvo.folder,
        );
        logger.info({ folder, codigo: p.codigo }, 'revisão: cobrado');
      } else {
        await deps.tocaAlarme();
        logger.warn({ folder, codigo: p.codigo }, 'revisão: alarme');
        alarmados.push(p.codigo);
      }
    }
    // ⚠️ Relê ANTES de gravar, e só mexe nos códigos que ainda existem.
    //
    // `tocaAlarme` é await: durante ele uma aprovação pode tirar A da fila e
    // uma resposta nova pode inserir B. Gravar o snapshot antigo ressuscitava A
    // (que então seria enviada de novo) ou apagava B (deixando outro paciente
    // sem resposta). Achado do Codex, 19/10/2026 — e é corrida de verdade,
    // diferente das operações síncronas da memória de conversa.
    if (mudou || alarmados.length > 0) {
      const agora2 = lePendentes(folder);
      for (const p of agora2) {
        if (cobrados.includes(p.codigo)) p.cobrado = true;
        if (alarmados.includes(p.codigo)) {
          p.alarmado = true;
          p.cobrado = true;
        }
      }
      grava(folder, agora2);
    }
  }
}
