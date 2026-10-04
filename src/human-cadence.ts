/**
 * Cadência humana para respostas do agente.
 *
 * ## Por que existe
 *
 * Um agente que responde em 900 ms se denuncia: ninguém lê, pensa e digita uma
 * resposta nesse tempo. Num atendimento a paciente isso é pior que estética,
 * porque quebra a premissa da conversa.
 *
 * Os números vieram das 849 respostas humanas medidas no corpus da clínica
 * (jul a out/2026), não de chute:
 *
 *   dentro do mesmo minuto .... 31%
 *   mediana ................... 2 min
 *   p75 ....................... 9 min
 *   p90 ....................... 38 min
 *
 * **Não imitamos a cauda de propósito.** Esperar 38 minutos seria autêntico e
 * péssimo: a clínica quer converter quem chegou por anúncio, e o agente existe
 * justamente para não deixar ninguém esperando. O alvo fica na faixa dominante
 * de "mesmo minuto a poucos minutos", que já basta para não parecer robô.
 *
 * Ressalva sobre a medição: o export do WhatsApp tem resolução de MINUTO, então
 * o bucket "0s" quer dizer "no mesmo minuto" (0 a 59 s), não instantâneo. É por
 * isso que a faixa de 30 a 60 s aparece vazia nos dados: ela é inobservável.
 *
 * ## Como funciona
 *
 * O atraso é um ALVO para o tempo total percebido, não um sleep somado por
 * cima. O container já gastou algum tempo pensando, e esse tempo conta: se a
 * resposta levou 18 s para ser gerada, só faltam poucos segundos de espera. Sem
 * isso, agente lento + atraso fixo viraria meio minuto de silêncio.
 */
import { readEnvFile } from './env.js';

const envConfig = readEnvFile(['HUMAN_CADENCE_FOLDERS']);

/**
 * Pastas de grupo que recebem cadência humana, separadas por vírgula. Vazio
 * desliga tudo, que é o default: a maioria dos grupos é back-office, onde
 * atrasar a resposta só faz o humano esperar sem motivo.
 */
const FOLDERS = new Set(
  (process.env.HUMAN_CADENCE_FOLDERS || envConfig.HUMAN_CADENCE_FOLDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Piso: abaixo disso a resposta "chega junto" com a pergunta e se denuncia. */
export const MIN_MS = 6_000;
/**
 * Teto de 1 minuto, regra do Thiago em 04/10/2026. A clínica quer converter
 * quem chegou por anúncio, então não imitamos a cauda de 38 min do corpus: o
 * alvo é só não parecer máquina.
 */
export const MAX_MS = 60_000;
/** Tempo de leitura e decisão, antes de começar a "digitar". */
const BASE_MS = 8_000;
/** ~18 caracteres por segundo, velocidade de digitação em celular. */
const MS_POR_CARACTERE = 55;
/** Jitter: atraso constante é um tell tão bom quanto atraso zero. */
const JITTER = 0.35;

export function wantsHumanCadence(groupFolder?: string): boolean {
  return !!groupFolder && FOLDERS.has(groupFolder);
}

/**
 * Quanto ainda falta esperar antes de enviar `text`, dado que `elapsedMs` já
 * se passaram desde que a mensagem do paciente começou a ser processada.
 *
 * `random` é injetável para o teste poder fixar o jitter.
 */
export function humanDelayMs(
  text: string,
  elapsedMs: number,
  random: () => number = Math.random,
): number {
  const alvoBruto = BASE_MS + text.length * MS_POR_CARACTERE;
  const comJitter = alvoBruto * (1 + (random() * 2 - 1) * JITTER);
  const alvo = Math.min(MAX_MS, Math.max(MIN_MS, comJitter));
  // O tempo que o container gastou pensando já foi silêncio para o paciente.
  return Math.max(0, Math.round(alvo - Math.max(0, elapsedMs)));
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
