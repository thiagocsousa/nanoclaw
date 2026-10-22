/**
 * O alarme de "a observação parou de observar".
 *
 * ⛔ Nasceu em 22/10/2026, de duas horas perdidas no primeiro dia da semana de
 * observação. O canal do atendimento ficou estritamente outbound porque faltava
 * uma env (`DM_OBSERVACAO_FOLDER`), e o sintoma era NADA: sem log, sem erro,
 * sem alerta. Oito pacientes escreveram entre 18:23 e 19:57 UTC e nenhuma
 * mensagem foi gravada. Quem percebeu foi o Thiago, olhando um grupo vazio.
 *
 * A lição é a que mais se repetiu naquele dia: **conferir configuração não é
 * conferir funcionamento.** Três vezes eu disse "está ligado" tendo verificado
 * que as variáveis resolviam, e nenhuma vez tendo verificado que uma mensagem
 * de paciente virava turno.
 *
 * ⚠️ Silêncio é ambíguo de propósito, e o alarme não finge o contrário: pode
 * ser captura quebrada OU clínica parada. Ele diz "há N minutos sem DM", que é
 * o fato, e deixa o julgamento com o humano. Um alarme que afirmasse "a
 * captura quebrou" mentiria metade das vezes e seria ignorado na outra metade.
 */

/** Quanto silêncio, dentro do expediente, já merece um aviso. */
export const SILENCIO_SUSPEITO_MS = 45 * 60 * 1000;

/** Intervalo mínimo entre dois avisos, para o alarme não virar ruído. */
export const ENTRE_AVISOS_MS = 60 * 60 * 1000;

export interface EstadoDaVigia {
  /** Quando a última DM de paciente foi capturada. */
  ultimaCaptura?: number;
  /** Quando o último aviso foi mandado. */
  ultimoAviso?: number;
}

export interface LeituraDaVigia {
  agora: number;
  /** Observação ligada para alguma pasta? Sem isso não há o que vigiar. */
  observando: boolean;
  /** Estamos dentro do horário em que paciente escreve? */
  noExpediente: boolean;
  estado: EstadoDaVigia;
  silencioMs?: number;
  entreAvisosMs?: number;
}

/**
 * Deve avisar agora? Devolve os minutos de silêncio quando sim.
 *
 * Fora do expediente nunca avisa: ninguém escreve, e alarme que toca à noite
 * ensina a ignorar alarme.
 */
export function avisoDeCapturaParada(
  l: LeituraDaVigia,
): { minutos: number } | undefined {
  if (!l.observando || !l.noExpediente) return undefined;
  const limite = l.silencioMs ?? SILENCIO_SUSPEITO_MS;
  const entre = l.entreAvisosMs ?? ENTRE_AVISOS_MS;
  // Sem captura nenhuma registrada, o relógio corre desde que a vigia começou:
  // quem chama passa `ultimaCaptura` no start. Sem isso não há como distinguir
  // "nunca capturou" de "capturou agora", e o estado seguro é não avisar.
  const desde = l.estado.ultimaCaptura;
  if (desde === undefined) return undefined;
  const silencio = l.agora - desde;
  if (silencio < limite) return undefined;
  const ultimo = l.estado.ultimoAviso;
  if (ultimo !== undefined && l.agora - ultimo < entre) return undefined;
  return { minutos: Math.floor(silencio / 60000) };
}

/** O texto do aviso. Diz o FATO, não o diagnóstico. */
export function textoDoAviso(minutos: number): string {
  return (
    `⚠️ *Observação sem captura*\n\n` +
    `Nenhuma mensagem de paciente há *${minutos} min*, dentro do expediente.\n\n` +
    'Pode ser clínica parada ou captura quebrada — o sistema não sabe ' +
    'distinguir. Se houver conversa acontecendo no WhatsApp do atendimento, ' +
    'é a captura.'
  );
}
