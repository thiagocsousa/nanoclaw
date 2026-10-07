import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * O que a conversa já contou, lembrado pelo HOST entre turnos.
 *
 * O classificador preenche slots do turno que está lendo. Quando o paciente
 * diz "e quanto fica a consulta?", esse turno não tem necessidade nem
 * convênio — ele os disse dois turnos atrás. Em 07/10/2026 isso fez a regra do
 * desconto (`temDescontoDeConsulta`) avaliar falso e o paciente ouvir R$ 430
 * quando devia ouvir R$ 300, mesmo com a regra já no host: ela estava certa e
 * não tinha de onde ler.
 *
 * Mesmo arranjo da oferta pendente em `agendamento.ts`: um arquivo por pasta,
 * uma entrada por conversa, podado na escrita. Deliberadamente NÃO é o
 * histórico da conversa — são só os poucos campos que decidem regra, porque
 * carregar conversa de paciente a cada turno seria dado de saúde circulando
 * sem necessidade.
 */
export interface SlotsLembrados {
  necessidade?: string;
  convenio?: string;
  /**
   * Cadastros do iClinic com o telefone desta conversa. Buscar custa ~10 s de
   * Playwright com login, então é uma vez por conversa, não por turno.
   */
  candidatos?: Array<{ id: number; nome: string; nascimento: string }>;
  /**
   * Já procuramos? Distinto de `candidatos` vazio: "procurei e não achei" não
   * pode virar "procuro de novo a cada mensagem".
   */
  buscouPaciente?: boolean;
  /**
   * Já perguntamos "é para você?" nesta conversa. Perguntar de novo a cada
   * turno seria pior que não perguntar.
   */
  perguntouPaciente?: boolean;
  quando: number;
}

const ARQUIVO = 'slots_conversa.json';

/**
 * Quatro horas. Uma conversa de paciente se arrasta pela manhã inteira, e
 * esquecer no meio traz de volta o bug que isto conserta. Mas não é eterno:
 * o mesmo paciente voltando noutro dia para outro assunto não deve herdar o
 * convênio de antes. Quando o turno traz o dado, ele VENCE o lembrado.
 */
const VALIDO_MS = 4 * 60 * 60 * 1000;

function arquivo(folder: string): string {
  return path.join(GROUPS_DIR, folder, ARQUIVO);
}

function le(folder: string): Record<string, SlotsLembrados> {
  try {
    return JSON.parse(fs.readFileSync(arquivo(folder), 'utf-8')) as Record<
      string,
      SlotsLembrados
    >;
  } catch {
    return {};
  }
}

function grava(folder: string, todas: Record<string, SlotsLembrados>): void {
  const alvo = arquivo(folder);
  try {
    const tmp = `${alvo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(todas, null, 2));
    fs.renameSync(tmp, alvo);
  } catch (err) {
    // Memória é conveniência: perdê-la degrada a resposta, não a quebra.
    logger.warn({ err, folder }, 'memoria-conversa: não consegui gravar');
  }
}

function vazio(v?: string): boolean {
  return !v || !v.trim();
}

/** Guarda o que este turno trouxe de novo, sem apagar o que já se sabia. */
export function lembraSlots(
  folder: string,
  chatJid: string,
  slots: { necessidade?: string; convenio?: string },
): void {
  if (vazio(slots.necessidade) && vazio(slots.convenio)) return;
  const agora = Date.now();
  const todas = Object.fromEntries(
    Object.entries(le(folder)).filter(([, v]) => agora - v.quando <= VALIDO_MS),
  );
  const antes = todas[chatJid];
  todas[chatJid] = {
    // Preserva o resto do registro. Sem o spread, gravar um slot apagava os
    // candidatos e as travas de "já busquei" e "já perguntei" — um teste pegou
    // a Lara perguntando "é para você?" duas vezes seguidas.
    ...antes,
    necessidade: vazio(slots.necessidade)
      ? antes?.necessidade
      : slots.necessidade,
    convenio: vazio(slots.convenio) ? antes?.convenio : slots.convenio,
    quando: agora,
  };
  grava(folder, todas);
}

/**
 * Os slots do turno completados pelo que a conversa já disse.
 * O turno atual SEMPRE vence: quem acabou de falar está mais certo.
 */
export function comLembrados<
  T extends { necessidade?: string; convenio?: string },
>(folder: string, chatJid: string, slots: T): T {
  const m = le(folder)[chatJid];
  if (!m || Date.now() - m.quando > VALIDO_MS) return slots;
  return {
    ...slots,
    necessidade: vazio(slots.necessidade) ? m.necessidade : slots.necessidade,
    convenio: vazio(slots.convenio) ? m.convenio : slots.convenio,
  };
}

/** Guarda o resultado da busca por telefone, inclusive quando não achou. */
export function lembraCandidatos(
  folder: string,
  chatJid: string,
  candidatos: Array<{ id: number; nome: string; nascimento: string }>,
): void {
  const agora = Date.now();
  const todas = Object.fromEntries(
    Object.entries(le(folder)).filter(([, v]) => agora - v.quando <= VALIDO_MS),
  );
  const antes = todas[chatJid];
  todas[chatJid] = {
    ...antes,
    candidatos,
    buscouPaciente: true,
    quando: agora,
  };
  grava(folder, todas);
}

/** O que a busca por telefone achou, e se ela já aconteceu. */
export function candidatosLembrados(
  folder: string,
  chatJid: string,
): { buscou: boolean; candidatos: Array<{ id: number; nome: string; nascimento: string }> } {
  const m = le(folder)[chatJid];
  if (!m || Date.now() - m.quando > VALIDO_MS) {
    return { buscou: false, candidatos: [] };
  }
  return { buscou: !!m.buscouPaciente, candidatos: m.candidatos ?? [] };
}

/** Marca que a pergunta de confirmação já foi feita nesta conversa. */
export function marcaPerguntouPaciente(folder: string, chatJid: string): void {
  const agora = Date.now();
  const todas = le(folder);
  todas[chatJid] = { ...todas[chatJid], perguntouPaciente: true, quando: agora };
  grava(folder, todas);
}

/** Já perguntamos de quem é a consulta nesta conversa? */
export function jaPerguntouPaciente(folder: string, chatJid: string): boolean {
  const m = le(folder)[chatJid];
  return !!m && Date.now() - m.quando <= VALIDO_MS && !!m.perguntouPaciente;
}

/** Esquece esta conversa. Usado em teste e quando o caso fecha. */
export function esqueceSlots(folder: string, chatJid: string): void {
  const todas = le(folder);
  if (!(chatJid in todas)) return;
  delete todas[chatJid];
  grava(folder, todas);
}
