/**
 * Horário de atendimento da Lara.
 *
 * Regra do Thiago, 17/10/2026 e estendida em 19/10: **7h30 às 18h30, de
 * segunda a sexta.** E a parte
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
  'EXPEDIENTE_ULTIMO_INICIO',
  'EXPEDIENTE_CONVERSA_VIVA',
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

/**
 * Abertura e fechamento, em minutos desde a meia-noite local.
 *
 * Aceita "7:30" e "7": hora cheia foi o formato até 19/10/2026, quando o
 * horário era 8h-18h. O Thiago estendeu para **7h30 às 18h30** no mesmo dia,
 * depois de eu apontar que a janela de consultório da QUARTA vai até 18:30 e a
 * Lara calava às 18h — a clínica aberta e ela muda.
 */
function emMinutos(valor: string): number | undefined {
  const m = /^(\d{1,2})(?:[:h](\d{2}))?$/.exec(valor.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/**
 * Cada limite escrito UMA vez.
 *
 * Antes cada um aparecia duas vezes e em duas codificações — `'7:30'` para o env
 * ausente e `7 * 60 + 30` para o env malformado. Mudar o horário pedia quatro
 * edições, e meia edição era silenciosa: o ramo da aritmética só roda com `.env`
 * inválido, que nenhum teste do caminho normal exercita.
 */
function minutosDe(chave: string, padrao: string): number {
  return emMinutos(env(chave, padrao)) ?? emMinutos(padrao)!;
}

const INICIO = minutosDe('EXPEDIENTE_INICIO', '7:30');
const FIM = minutosDe('EXPEDIENTE_FIM', '18:30');
/**
 * A última hora em que uma conversa pode COMEÇAR (Thiago, 22/10/2026).
 *
 * Entre este horário e o `FIM` a Lara só atende quem já estava falando: a meia
 * hora final é para terminar conversa, não para começar. Quem chega às 18h05
 * recebe a mensagem de ausência do WhatsApp Business e é atendido na manhã
 * seguinte, com o fio inteiro no prompt.
 */
const ULTIMO_INICIO = minutosDe('EXPEDIENTE_ULTIMO_INICIO', '18:00');

/**
 * Quanto tempo sem falar nada até a conversa deixar de contar como "em
 * andamento", para efeito da meia hora final. Uma hora (Thiago, 22/10/2026).
 *
 * ⛔ Prazo PRÓPRIO, e não a validade da memória de slots. Chegaram juntos no
 * mesmo dia e eu usei um só: aí apertar este para uma hora fazia o paciente
 * que responde 70 minutos depois perder o convênio lembrado e os candidatos da
 * oferta em curso. São duas perguntas sobre o mesmo dado — "ainda lembro o que
 * ela me disse?" e "ela ainda está falando comigo?" — e só a segunda quer ser
 * curta.
 */
export const CONVERSA_VIVA_MS =
  minutosDe('EXPEDIENTE_CONVERSA_VIVA', '1:00') * 60 * 1000;
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

/**
 * A data de hoje na clínica, como `[ano, mes, dia]`.
 *
 * Mora aqui porque é aqui que a decisão de fuso do consultório já estava, com
 * o `EXPEDIENTE_TZ`. Dois módulos novos de 19/10/2026 calculavam "hoje" por
 * conta: `dia-pedido.ts` fixando o fuso no código e `retorno-contexto.ts` em
 * UTC. Três noções de hoje é uma a mais do que o número de fusos que a clínica
 * tem.
 */
export function dataLocal(agora: Date = new Date()): [number, number, number] {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(
    f.formatToParts(agora).map((x) => [x.type, x.value]),
  );
  return [Number(p.year), Number(p.month), Number(p.day)];
}

/**
 * Segunda a sexta, das 7h30 às 18h30. No minuto do fechamento já está fechado.
 *
 * O fim é exclusivo de propósito: às 18:30 a última consulta da quarta começou
 * às 18:00 e está em andamento, e abrir uma conversa nova ali deixaria alguém
 * esperando resposta que não vem.
 */
export function dentroDoExpediente(agora: Date | number = new Date()): boolean {
  const d = typeof agora === 'number' ? new Date(agora) : agora;
  const { diaSemana, hora, minuto } = horaLocal(d);
  if (diaSemana < 1 || diaSemana > 5) return false;
  const agoraMin = hora * 60 + minuto;
  return agoraMin >= INICIO && agoraMin < FIM;
}

/** A conversa pode COMEÇAR agora? Dentro do expediente e antes das 18h. */
export function podeComecar(agora: Date | number = new Date()): boolean {
  if (!dentroDoExpediente(agora)) return false;
  const { hora, minuto } = horaLocal(
    typeof agora === 'number' ? new Date(agora) : agora,
  );
  return hora * 60 + minuto < ULTIMO_INICIO;
}

/**
 * A Lara responde agora? (Thiago, 22/10/2026.)
 *
 * Três faixas, e nenhuma delas se estende para fora do dia:
 *
 * | horário | quem é atendido |
 * |---|---|
 * | antes de 18h | todos |
 * | 18h às 18h30 | só conversa iniciada ANTES das 18h |
 * | 18h30 em diante | ninguém |
 *
 * ⛔ Até hoje `abertaEm` era uma LICENÇA: conversa aberta dentro do expediente
 * seguia sendo atendida depois das 18h30, "até encerrar ou escalar". O que a
 * exceção escondia é que ela não tinha fim de dia — o que fechava a janela era
 * a validade de 4h do `slots_conversa`, RENOVADA a cada turno, então conversa
 * com atividade a cada menos de 4h emendava para a madrugada e para o dia
 * seguinte. Apareceu na fila como uma resposta às 19h53, num comprovante de
 * pagamento que chegou de noite numa conversa aberta às 10h24.
 *
 * Agora `abertaEm` é uma RESTRIÇÃO: na meia hora final ele é o que distingue
 * quem já estava falando de quem acabou de chegar.
 *
 * ⚠️ O preço, declarado: quem manda a primeira mensagem às 18h05 leva silêncio,
 * e quem está no meio da triagem às 18h29 leva silêncio às 18h31. As mensagens
 * NÃO se perdem — ficam pendentes e a varredura da manhã as pega com o fio
 * inteiro da conversa no prompt. Quem responde à noite é a mensagem de ausência
 * do WhatsApp Business, que é nativa.
 *
 * ⚠️ `abertaEm` de outro dia não passa: a parada às 18h30 garante um vão maior
 * que a validade de 4h da memória, então `conversaAbertaEm` devolve `undefined`
 * na manhã seguinte e `abreConversa` recomeça a contagem.
 */
export function podeResponder(
  abertaEm: number | undefined,
  agora: Date | number = new Date(),
): boolean {
  if (!dentroDoExpediente(agora)) return false;
  if (podeComecar(agora)) return true;
  // Meia hora final: só quem já estava falando antes do corte.
  return abertaEm !== undefined && podeComecar(abertaEm);
}

function comoHora(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

export function textoDoExpediente(): string {
  return `${comoHora(INICIO)} às ${comoHora(FIM)}, de segunda a sexta`;
}
