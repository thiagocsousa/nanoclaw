/**
 * O dia que o paciente pediu, em ISO.
 *
 * ## Por que existe
 *
 * `dia_pedido` chega do classificador como a pessoa falou: "sexta", "amanhã",
 * "dia 23". O host só repassava à agenda o que JÁ estava em `AAAA-MM-DD`, e o
 * `CLAUDE.md` documenta o exemplo do slot como **"sábado"** — ou seja, o modelo
 * mandava exatamente o que nunca passava no filtro.
 *
 * Resultado, em produção até 19/10/2026: *"tem vaga na sexta?"* era descartado
 * em silêncio e a agenda devolvia o próximo horário de qualquer dia. O pedido
 * de dia nunca era respeitado. O Thiago mandou consertar no mesmo dia.
 *
 * ## Por que no host, e não no prompt
 *
 * Converter data é aritmética de calendário: determinística, testável, e com
 * resposta única. Pedir ao modelo que calcule "sexta que vem" é a aposta que
 * esta arquitetura existe para não fazer — e um erro aqui não produz texto
 * errado, produz o paciente indo à clínica no dia errado.
 */
import { dataLocal } from './expediente.js';
import { logger } from './logger.js';

const DIAS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

function semAcento(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function iso(ano: number, mes: number, dia: number): string {
  const d = String(dia).padStart(2, '0');
  const m = String(mes).padStart(2, '0');
  return `${ano}-${m}-${d}`;
}

/** Soma dias a uma data civil, sem passar por fuso. */
function somaDias(ano: number, mes: number, dia: number, n: number): string {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Converte o que o paciente disse em `AAAA-MM-DD`, ou devolve `undefined`
 * quando não dá para saber.
 *
 * ⚠️ `undefined` é o caso SEGURO: a agenda então devolve o próximo horário
 * disponível, que é a resposta certa para "tem vaga?". Chutar uma data seria
 * oferecer um dia que ninguém pediu.
 */
export function resolveDiaPedido(
  pedido: string | undefined,
  agora: Date = new Date(),
): string | undefined {
  const t = semAcento(pedido ?? '');
  if (!t) return undefined;

  // Já veio pronto.
  const jaIso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (jaIso) return jaIso[0];

  // A data de hoje vem do `expediente.ts`, que é onde o fuso da clínica já
  // morava. Calcular aqui de novo criava uma segunda noção de "hoje", com o
  // fuso fixo no código enquanto o outro lê `EXPEDIENTE_TZ` — perto da
  // meia-noite, "amanhã" cairia em dias diferentes.
  const [ano, mes, dia] = dataLocal(agora);
  const h = {
    ano,
    mes,
    dia,
    diaSemana: new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay(),
  };

  if (/\bhoje\b/.test(t)) return iso(h.ano, h.mes, h.dia);
  if (/\bdepois de amanha\b/.test(t)) {
    return somaDias(h.ano, h.mes, h.dia, 2);
  }
  if (/\bamanha\b/.test(t)) return somaDias(h.ano, h.mes, h.dia, 1);

  // "23/10", "23/10/2026", "23-10"
  const br = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (br) {
    const dia = Number(br[1]);
    const mes = Number(br[2]);
    let ano = br[3] ? Number(br[3]) : h.ano;
    if (ano < 100) ano += 2000;
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
    // Sem ano e já passou: é do ano que vem.
    if (!br[3] && (mes < h.mes || (mes === h.mes && dia < h.dia))) ano += 1;
    return iso(ano, mes, dia);
  }

  // "dia 23"
  const soDia = t.match(/\bdia\s+(\d{1,2})\b/);
  if (soDia) {
    const dia = Number(soDia[1]);
    if (dia < 1 || dia > 31) return undefined;
    let mes = h.mes;
    let ano = h.ano;
    if (dia < h.dia) {
      mes += 1;
      if (mes > 12) {
        mes = 1;
        ano += 1;
      }
    }
    return iso(ano, mes, dia);
  }

  // Dia da semana. A próxima ocorrência, incluindo hoje: quem diz "sexta" numa
  // sexta de manhã quer hoje, e a agenda já descarta hora que passou.
  for (const [nome, n] of Object.entries(DIAS)) {
    if (new RegExp(`\\b${nome}(?:[- ]?feira)?\\b`).test(t)) {
      const delta = (n - h.diaSemana + 7) % 7;
      const base = somaDias(h.ano, h.mes, h.dia, delta);
      // "sexta que vem" / "próxima sexta": pula a desta semana.
      if (/\b(que vem|proxim[ao]|seguinte)\b/.test(t) && delta === 0) {
        return somaDias(h.ano, h.mes, h.dia, 7);
      }
      return base;
    }
  }

  logger.debug({ pedido }, 'dia-pedido: não reconheci, vai sem --dia');
  return undefined;
}
