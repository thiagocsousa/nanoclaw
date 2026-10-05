/**
 * Marcação automática no iClinic.
 *
 * ## Decisões do Thiago em 04/10/2026, e o critério por trás
 *
 * **Só `marcar` escreve.** Marcar é aditivo: errar cria um horário a mais, que
 * se apaga. Remarcar e cancelar são destrutivos — erram apagando ou movendo a
 * consulta de alguém que vai aparecer na clínica no dia, e o iClinic não tem
 * desfazer. Esses dois escalam (`remarcar_consulta`, `cancelar_consulta`), e a
 * recusa está em `marca()`, no código, não no prompt.
 *
 * **Sem confirmação humana.** Eu havia construído um passo de aprovação e,
 * reduzido o escopo a marcar, ele protegia menos do que parecia: identidade
 * quase não importa quando se CRIA um horário para quem está falando, e contra
 * a colisão de dois pacientes no mesmo horário uma pessoa clicando "confirmar"
 * três minutos depois não protege nada.
 *
 * ## As duas travas que substituem o humano, e por que funcionam
 *
 * 1. **Releitura no instante da escrita.** Imediatamente antes de escrever,
 *    relê-se aquele horário exato na agenda. Vaga tomada, não escreve. Isso
 *    fecha a janela entre oferecer e marcar, que é onde a colisão vive.
 * 2. **Idempotência.** Mesma pessoa, mesmo dia, mesma hora já marcada devolve o
 *    registro existente em vez de marcar de novo. Sem isso, um retry de rede
 *    ou uma mensagem duplicada viram duas consultas, e a segunda ocupa o
 *    horário de outro paciente.
 *
 * ## Falha fecha
 *
 * Dado faltando, operação que não é marcar, vaga tomada, agenda ilegível ou
 * script falhando: **não escreve e devolve o motivo**. Quem chama escala. O
 * próprio `iclinic_vagas.py` já avisa "NÃO ofereça horário, escale" quando não
 * consegue ler a agenda.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, GROUPS_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';
import {
  buscaVagas,
  CREDENCIAIS,
  garanteCredenciais,
  type Vaga,
} from './vagas.js';

// ---------------------------------------------------------------------------
// A oferta pendente
//
// Para marcar é preciso saber QUAL horário o paciente aceitou, e o classificador
// é proibido de preencher dia e hora — é essa proibição que impede um horário
// inventado de chegar ao paciente. Então quem lembra é o host: ao oferecer, ele
// registra; ao receber o aceite, ele lê de volta.
//
// Assim o modelo nunca toca no horário, nem para oferecer nem para confirmar.

const OFERTAS = 'ofertas_pendentes.json';

/**
 * Validade da oferta. Passado isso, a vaga provavelmente já é de outro, e
 * marcar em cima seria o erro que a releitura existe para evitar — melhor
 * reofertar que marcar o que não está mais lá.
 */
export const OFERTA_VALIDA_MS = 30 * 60_000;

export interface OfertaPendente {
  /**
   * A vaga inteira, como o `iclinic_vagas.py` devolveu. Guardar a vaga em vez
   * de data e hora soltas evita reimplementar aqui a aritmética de duração que
   * o script declara ser fonte única: `fim` já vem calculado por ele.
   */
  vaga: Vaga;
  perfil: string;
  quando: number;
}

function arquivoOfertas(folder: string): string {
  return path.join(GROUPS_DIR, folder, OFERTAS);
}

function leOfertas(folder: string): Record<string, OfertaPendente> {
  try {
    const d = JSON.parse(fs.readFileSync(arquivoOfertas(folder), 'utf-8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/**
 * Grava as ofertas. Uma função só para registrar e para esquecer: as duas
 * cópias anteriores já tinham divergido — só uma criava o diretório, e sem ele
 * o esquecimento falhava calado e a oferta continuava valendo.
 */
function gravaOfertas(
  folder: string,
  todas: Record<string, OfertaPendente>,
  oque: string,
): void {
  const alvo = arquivoOfertas(folder);
  try {
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    const tmp = `${alvo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(todas, null, 2));
    fs.renameSync(tmp, alvo);
  } catch (err) {
    logger.warn({ err, folder, oque }, 'oferta: não gravei');
  }
}

/** Registra o que foi oferecido a esta conversa. Uma por conversa: a última. */
export function registraOferta(
  folder: string,
  chatJid: string,
  o: Omit<OfertaPendente, 'quando'>,
): void {
  const agora = Date.now();
  // Poda as vencidas de passagem: só o caminho de sucesso apagava, então o
  // arquivo crescia sem teto, uma entrada por conversa que não fechou.
  const todas = Object.fromEntries(
    Object.entries(leOfertas(folder)).filter(
      ([, v]) => agora - v.quando <= OFERTA_VALIDA_MS,
    ),
  );
  todas[chatJid] = { ...o, quando: agora };
  gravaOfertas(folder, todas, 'registrar');
}

/** A oferta ainda válida desta conversa, se houver. */
export function ultimaOferta(
  folder: string,
  chatJid: string,
  agora = Date.now(),
): OfertaPendente | undefined {
  const o = leOfertas(folder)[chatJid];
  if (!o) return undefined;
  if (agora - o.quando > OFERTA_VALIDA_MS) return undefined;
  return o;
}

/** Some com a oferta depois de usada, para um "sim" repetido não remarcar. */
export function esqueceOferta(folder: string, chatJid: string): void {
  const todas = leOfertas(folder);
  if (!(chatJid in todas)) return;
  delete todas[chatJid];
  gravaOfertas(folder, todas, 'esquecer');
}

/** Livro de marcações feitas: auditoria e base da idempotência. */
const LIVRO = 'agendamentos_feitos.jsonl';

/** Mesmo teto do `vagas.ts`: Playwright no iClinic leva dezenas de segundos. */
const TIMEOUT_MS = Number(process.env.VAGAS_TIMEOUT_MS) || 180_000;



/**
 * Só `marcar`. Ver o cabeçalho: o critério é o que o erro faz, não quanto ele
 * é provável.
 */
export type Operacao = 'marcar';

export interface DadosDaMarcacao {
  operacao: Operacao;
  /** Nome como o paciente informou. */
  paciente: string;
  /** JID de quem pediu. Entra na chave de idempotência. */
  pedidoPor: string;
  nascimento?: string;
  convenio?: string;
  /** ISO, "2026-10-06". */
  data: string;
  /** "09:20". */
  hora: string;
  /** Perfil da agenda: define duração e tipo. */
  perfil: string;
}

export interface Marcacao extends DadosDaMarcacao {
  /** epoch ms da escrita. */
  feitoEm: number;
  /** Identificador do evento no iClinic, quando ele devolver. */
  eventoId?: string;
}

export type MotivoDeRecusa =
  | 'dado_faltando'
  | 'operacao_nao_permitida'
  | 'vaga_tomada'
  | 'agenda_ilegivel'
  | 'escrita_indisponivel';

export type ResultadoDaMarcacao =
  | { ok: true; marcacao: Marcacao; jaExistia: boolean }
  | { ok: false; motivo: MotivoDeRecusa; detalhe: string };

function livro(folder: string): string {
  return path.join(GROUPS_DIR, folder, LIVRO);
}

export function leMarcacoes(folder: string): Marcacao[] {
  try {
    return fs
      .readFileSync(livro(folder), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Marcacao);
  } catch {
    return [];
  }
}

/**
 * Chave de idempotência: quem pediu, para quando. Não inclui o nome, porque o
 * paciente pode reescrevê-lo diferente ("Joana" e depois "Joana Silva") e isso
 * não é um segundo agendamento.
 */
function chave(
  d: Pick<DadosDaMarcacao, 'pedidoPor' | 'data' | 'hora'>,
): string {
  return `${d.pedidoPor}|${d.data}|${d.hora}`;
}

export function achaMarcacao(
  folder: string,
  d: Pick<DadosDaMarcacao, 'pedidoPor' | 'data' | 'hora'>,
): Marcacao | undefined {
  const k = chave(d);
  return leMarcacoes(folder).find((m) => chave(m) === k);
}

function registra(folder: string, m: Marcacao): void {
  const alvo = livro(folder);
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.appendFileSync(alvo, `${JSON.stringify(m)}\n`);
}

/**
 * Escreve o evento no iClinic, rodando `iclinic_marcar.py` num container.
 *
 * O script resolve a identidade antes de escrever, por
 * `GET /pacientes/busca.json`: nome MAIS nascimento E telefone, os dois juntos
 * (regra do Thiago em 05/10/2026). Batendo os dois, usa o cadastro existente;
 * qualquer dúvida — só um fator confere, falta um deles, há mais de um
 * candidato, cadastro de falecido — ele recusa e o caso escala.
 *
 * O "ou" seria pior que inútil: um homônimo cujo telefone a clínica não tem,
 * mas com data de nascimento coincidente, entraria no prontuário de outra
 * pessoa.
 *
 * Mesmo arranjo do `vagas.ts`, e pelo mesmo motivo: Playwright não existe no
 * host e existe na imagem do agente; as credenciais vão por `-e NOME`, herdando
 * o valor, nunca `-e NOME=valor`, que deixaria a senha visível em `ps`.
 *
 * O endpoint foi medido em 05/10/2026 interceptando o XHR real:
 * `POST /agenda/criar-evento/{PHYSICIAN_ID}/`, corpo JSON. O script também relê
 * a agenda antes e depois, então há duas verificações: a dele e a de `marca()`.
 * Redundante de propósito — é agenda médica.
 */
export async function escreveNoIclinic(
  folder: string,
  d: DadosDaMarcacao,
  fim: string,
): Promise<{ eventoId?: string }> {
  const dir = path.join(GROUPS_DIR, folder);
  const script = path.join(dir, 'scripts', 'iclinic_marcar.py');
  if (!fs.existsSync(script)) {
    throw new Error(`iclinic_marcar.py não existe em ${folder}`);
  }
  garanteCredenciais();
  const args = ['run', '--rm', '--network', 'bridge'];
  for (const k of CREDENCIAIS) {
    if (process.env[k]) args.push('-e', k);
  }
  args.push(
    '-v',
    `${dir}:/workspace/group:ro`,
    '--entrypoint',
    'python3',
    CONTAINER_IMAGE,
    '/workspace/group/scripts/iclinic_marcar.py',
    '--nome',
    d.paciente,
    '--data',
    d.data,
    '--inicio',
    d.hora,
    '--fim',
    fim,
    '--perfil',
    d.perfil,
  );
  // O telefone sai do JID de quem pediu. Sem ele o cadastro criado fica SEM
  // contato, e o pipeline de lembrete não alcança o paciente.
  const telefone = d.pedidoPor.split('@')[0].replace(/\D/g, '');
  if (telefone) args.push('--telefone', telefone);
  // Sem o nascimento o script NÃO casa o paciente existente e escala — é o
  // segundo fator da identidade, junto com o telefone.
  if (d.nascimento) args.push('--nascimento', d.nascimento);
  const saida = await new Promise<string>((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

  // Última linha JSON, como todos os scripts desta base.
  for (const linha of saida.trim().split('\n').reverse()) {
    const t = linha.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as {
        ok?: boolean;
        evento_id?: string;
        erro?: string;
      };
      if (j.ok === true) return { eventoId: j.evento_id };
      throw new Error(j.erro || 'o script não confirmou a marcação');
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }
  throw new Error('o script não devolveu JSON');
}

export interface DepsDaMarcacao {
  /** Injetável para teste: relê a vaga exata. */
  relê?: typeof buscaVagas;
  /** Injetável para teste: escreve de verdade. */
  escreve?: typeof escreveNoIclinic;
}

/**
 * Marca, com as duas travas. Nunca lança: devolve `ok: false` com o motivo,
 * para quem chama poder escalar com uma razão que a recepção entende.
 */
export async function marca(
  folder: string,
  d: DadosDaMarcacao,
  deps: DepsDaMarcacao = {},
): Promise<ResultadoDaMarcacao> {
  const relê = deps.relê ?? buscaVagas;
  const escreve = deps.escreve ?? escreveNoIclinic;

  if (d.operacao !== 'marcar') {
    logger.error({ folder, operacao: d.operacao }, 'marca: operação recusada');
    return {
      ok: false,
      motivo: 'operacao_nao_permitida',
      detalhe: 'só marcar escreve; remarcar e cancelar escalam',
    };
  }

  const falta = (
    ['paciente', 'data', 'hora', 'perfil', 'pedidoPor'] as const
  ).filter((k) => !String(d[k] ?? '').trim());
  if (falta.length > 0) {
    return {
      ok: false,
      motivo: 'dado_faltando',
      detalhe: `faltou: ${falta.join(', ')}`,
    };
  }

  // Trava 2 primeiro: é a mais barata, e se já marcou não há por que ir à rede.
  const existente = achaMarcacao(folder, d);
  if (existente) {
    logger.info(
      { folder, chave: chave(d) },
      'marca: já existia, não vou marcar de novo',
    );
    return { ok: true, marcacao: existente, jaExistia: true };
  }

  // Trava 1: a vaga ainda está livre AGORA? É aqui que a colisão morre.
  const vagas = await relê(folder, d.perfil, { dia: d.data, hora: d.hora });
  if (vagas.length === 0) {
    logger.warn(
      { folder, data: d.data, hora: d.hora, perfil: d.perfil },
      'marca: vaga não está mais livre (ou agenda ilegível), não escrevi',
    );
    return {
      ok: false,
      motivo: 'vaga_tomada',
      detalhe: `${d.hora} de ${d.data} não está disponível`,
    };
  }

  let eventoId: string | undefined;
  try {
    // O fim vem da vaga RELIDA, não de uma tabela de durações no host: a
    // aritmética de agenda tem uma fonte só, o `iclinic_vagas.py`. Duplicá-la
    // aqui faria a vaga ser achada com uma largura e escrita com outra.
    ({ eventoId } = await escreve(folder, d, vagas[0].fim));
  } catch (err) {
    logger.error({ err, folder }, 'marca: escrita no iClinic falhou');
    return {
      ok: false,
      motivo: 'escrita_indisponivel',
      detalhe: err instanceof Error ? err.message : String(err),
    };
  }

  const m: Marcacao = { ...d, feitoEm: Date.now(), eventoId };
  registra(folder, m);
  logger.info(
    { folder, paciente: d.paciente, data: d.data, hora: d.hora, eventoId },
    'marca: consulta marcada no iClinic',
  );
  return { ok: true, marcacao: m, jaExistia: false };
}

/** Aviso à clínica DEPOIS do fato: automático não é invisível. */
export function avisoDaMarcacao(m: Marcacao): string {
  const [a, mes, dia] = m.data.split('-');
  return [
    '📅 *Consulta marcada pela Lara*',
    '',
    `*Paciente:* ${m.paciente}`,
    m.nascimento ? `*Nascimento:* ${m.nascimento}` : '',
    m.convenio ? `*Convênio:* ${m.convenio}` : '',
    `*Quando:* ${dia}/${mes}/${a} às ${m.hora}`,
    `*Tipo:* ${m.perfil}`,
    m.eventoId ? `*Evento:* ${m.eventoId}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
