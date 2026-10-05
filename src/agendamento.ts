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
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { buscaVagas } from './vagas.js';

/** Livro de marcações feitas: auditoria e base da idempotência. */
const LIVRO = 'agendamentos_feitos.jsonl';

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
function chave(d: Pick<DadosDaMarcacao, 'pedidoPor' | 'data' | 'hora'>): string {
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
 * Escreve o evento no iClinic. **Ainda não implementado, de propósito.**
 *
 * A leitura usa `GET /agenda/{medico}/{data}/?clinic={id}`; o endpoint de
 * criação precisa ser capturado observando a rede durante um agendamento real.
 * Não existe iClinic de homologação, então isso se faz com o Thiago presente,
 * num horário que ele designe como descartável, apagando em seguida.
 *
 * Adivinhar o formato de uma requisição que mexe em agenda médica pode criar um
 * evento que ninguém sabe desfazer. Lançar é mais honesto que tentar.
 */
export async function escreveNoIclinic(
  _folder: string,
  _d: DadosDaMarcacao,
): Promise<{ eventoId?: string }> {
  throw new Error('endpoint de escrita do iClinic ainda não foi descoberto');
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

  const falta = (['paciente', 'data', 'hora', 'perfil', 'pedidoPor'] as const)
    .filter((k) => !String(d[k] ?? '').trim());
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
    ({ eventoId } = await escreve(folder, d));
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
