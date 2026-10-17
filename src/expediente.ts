/**
 * Horário de atendimento da Lara.
 *
 * Regra do Thiago em 17/10/2026: **8h às 18h, de segunda a sexta.** E a parte
 * que não é óbvia: *"se o paciente iniciou a conversa antes de 18 horas,
 * continua até encerrar ou escalar"*.
 *
 * O corte é no INÍCIO da conversa, não em cada mensagem. Alguém que escreveu
 * 17h55 e está no meio da triagem não pode levar um silêncio às 18h01 — isso
 * seria pior que nunca ter respondido, porque a pessoa já estava sendo
 * atendida.
 *
 * ## Fora do horário quem responde é o WhatsApp
 *
 * A clínica já usa a **mensagem de ausência do WhatsApp Business**, que é
 * nativa e dispara sozinha. Por isso a Lara fica CALADA fora do expediente em
 * vez de mandar um aviso próprio: duas respostas automáticas para a mesma
 * mensagem é pior que uma.
 *
 * ⚠️ Isso também evita o pior cruzamento com a revisão humana: às 20h não há
 * ninguém no grupo para aprovar, então uma resposta gerada fora de hora ficaria
 * pendurada até de manhã, disparando cobrança e alarme de madrugada para
 * ninguém.
 */
import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'EXPEDIENTE_FOLDERS',
  'EXPEDIENTE_INICIO',
  'EXPEDIENTE_FIM',
  'EXPEDIENTE_TZ',
]);

function env(key: string, fallback = ''): string {
  return process.env[key] || envConfig[key] || fallback;
}

const FOLDERS = new Set(
  env('EXPEDIENTE_FOLDERS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Hora de abrir e de fechar, em hora cheia local. */
const INICIO = parseInt(env('EXPEDIENTE_INICIO', '8'), 10);
const FIM = parseInt(env('EXPEDIENTE_FIM', '18'), 10);
/** Teresina. Sem horário de verão desde 2019, mas o IANA cuida disso. */
const TZ = env('EXPEDIENTE_TZ', 'America/Fortaleza');

export function wantsExpediente(groupFolder?: string): boolean {
  return !!groupFolder && FOLDERS.has(groupFolder);
}

/**
 * Dia da semana (0=domingo) e hora local, pelo Intl.
 *
 * Usa `Intl` em vez de aritmética de offset de propósito: offset fixo erra em
 * mudança de regra de fuso, e o erro aparece como a Lara calada num dia útil,
 * que ninguém liga ao relógio.
 */
export function horaLocal(agora: Date = new Date()): {
  diaSemana: number;
  hora: number;
  minuto: number;
} {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(
    f.formatToParts(agora).map((x) => [x.type, x.value]),
  );
  const dias: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    diaSemana: dias[p.weekday as string] ?? 0,
    // "24" aparece à meia-noite em algumas implementações de hour12:false.
    hora: parseInt(p.hour as string, 10) % 24,
    minuto: parseInt(p.minute as string, 10),
  };
}

/** Segunda a sexta, das 8h às 18h. Às 18h00 em ponto já está fechado. */
export function dentroDoExpediente(agora: Date | number = new Date()): boolean {
  const d = typeof agora === 'number' ? new Date(agora) : agora;
  const { diaSemana, hora } = horaLocal(d);
  if (diaSemana < 1 || diaSemana > 5) return false;
  return hora >= INICIO && hora < FIM;
}

/**
 * A Lara responde agora?
 *
 * `abertaEm` é quando a conversa começou. Conversa aberta DENTRO do expediente
 * continua depois das 18h até encerrar ou escalar — quem fecha a conversa é o
 * host, apagando a memória dela, e aí o próximo turno volta a valer esta regra.
 */
export function podeResponder(
  abertaEm: number | undefined,
  agora: Date | number = new Date(),
): boolean {
  if (dentroDoExpediente(agora)) return true;
  return abertaEm !== undefined && dentroDoExpediente(abertaEm);
}

export function textoDoExpediente(): string {
  return `${INICIO}h às ${FIM}h, de segunda a sexta`;
}
