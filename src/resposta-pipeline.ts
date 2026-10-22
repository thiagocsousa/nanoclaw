/**
 * Resposta a pipeline não é conversa com a Lara.
 *
 * ⛔ Nasceu de uma observação do Thiago em 22/10/2026: às 15h o lembrete de
 * consulta sai, os pacientes respondem "SIM" — e a Lara produzia um
 * "Só um instante." para cada um. Medido na fila daquele dia: 55 entradas, 24
 * delas `DESCONHECIDO` (44%), e um "Confirmado" que virou "Eu que agradeço!".
 *
 * Nada chegou ao paciente: a trava de egresso segurou. Mas é ruído, e ruído é o
 * que faz a Marina ler lixo em vez de atendimento — e quando a Lara assumir,
 * deixa de ser ruído e vira mensagem errada depois de uma confirmação.
 *
 * Ver `docs/RESPOSTA-A-PIPELINE.md` para os cinco pipelines e os achados.
 */

/** Os pipelines que falam com paciente, e por quanto tempo donos da conversa. */
export const JANELA_DO_PIPELINE: Record<string, number> = {
  // O lembrete PEDE confirmação, e ela chega até o dia seguinte.
  send_reminder: 36 * 3600 * 1000,
  lembrete_autoreply: 36 * 3600 * 1000,
  // Estes não pedem nada; o "obrigado" vem logo ou não vem.
  send_nota: 2 * 3600 * 1000,
  send_avaliacao: 2 * 3600 * 1000,
  /**
   * ⛔ Janela curta de propósito, e é a exceção que mais importa.
   *
   * O lembrete de 1 ano é o único cujo retorno é CONVERSA DE VERDADE: quem
   * responde quer marcar. Suprimir ali seria perder exatamente a conversão que
   * o pipeline existe para gerar. Só o "ok"/"obrigado" imediato é suprimido.
   */
  send_retorno: 30 * 60 * 1000,
};

/**
 * Passada a maior janela, NENHUMA entrada consegue suprimir coisa alguma —
 * `respostaDePipeline` devolve `false` fora dela. Daí a validade do registro.
 */
export const VALIDADE_DO_PIPELINE = Math.max(
  ...Object.values(JANELA_DO_PIPELINE),
);

/**
 * Tira do mapa o que já não decide nada.
 *
 * ⛔ Sem isto o estado cresce sem teto — uma entrada por paciente que qualquer
 * um dos cinco pipelines já tocou, re-serializada inteira em cada `saveState()`
 * — é a mesma lição que `podaDms` registra. E a poda tem de rodar no caminho de
 * ESCRITA, não só na subida: o processo fica semanas de pé.
 */
export function podaPipelines(
  mapa: Record<string, PipelineDoChat>,
  agora: number,
): Record<string, PipelineDoChat> {
  const vivo: Record<string, PipelineDoChat> = {};
  for (const [jid, p] of Object.entries(mapa)) {
    if (agora - p.quando <= VALIDADE_DO_PIPELINE) vivo[jid] = p;
  }
  return vivo;
}

/**
 * O que conta como "só confirmei, não quero nada".
 *
 * ⚠️ Lista curta e fechada, em código e sob teste, de propósito. Qualquer
 * pergunta, negativa com pedido, ou mensagem mais longa NÃO entra aqui — quem
 * responde "SIM" e dez minutos depois escreve "posso remarcar?" precisa ser
 * atendido, e é esse caso que a recepção mais quer ver.
 */
export const CONFIRMACOES = new Set([
  'sim',
  'simm',
  'ok',
  'okay',
  'confirmo',
  'confirmado',
  'confirmada',
  'certo',
  'isso',
  'ciente',
  'recebi',
  'recebido',
  'obrigado',
  'obrigada',
  'obg',
  'vlw',
  'valeu',
  'grato',
  'grata',
  'feito',
  'perfeito',
  'blz',
  'beleza',
  'ta bom',
  'tá bom',
  'tudo bem',
]);

/**
 * Tira pontuação, emoji e caixa, para "SIM!!" casar com "sim".
 *
 * Exportada só para a trava estrutural do teste, que confere que toda entrada
 * de `CONFIRMACOES` é igual à própria normalização — entrada que a
 * normalização alteraria nunca casaria com nada, em silêncio.
 */
export function normalizaConfirmacao(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[^a-zà-ú\s]/gi, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * ⚠️ O `Set` é o ÚNICO portão. Havia aqui um `split(' ').length > 3` que parecia
 * um segundo limite e não decidia nada — a entrada mais longa da lista tem duas
 * palavras, então toda frase já caía no `has()`. Pior que inútil: se alguém
 * acrescentasse uma confirmação de quatro palavras, ela seria recusada em
 * silêncio. Quem quiser aceitar frase tem de mexer na lista, não num teto.
 */
export function ehConfirmacaoCurta(texto: string): boolean {
  const limpo = normalizaConfirmacao(texto);
  if (!limpo) return false;
  return CONFIRMACOES.has(limpo);
}

export interface PipelineDoChat {
  origin: string;
  /** Quando a mensagem do pipeline saiu, em epoch ms. */
  quando: number;
}

/**
 * Esta mensagem é só o eco de um pipeline, e não deve abrir turno?
 *
 * ⛔ Exige as TRÊS condições juntas. Suprimir por janela apenas seria pior que
 * o defeito: quem responde "SIM" ao lembrete e depois pergunta "posso
 * remarcar?" ficaria sem resposta, e é exatamente a conversa que importa.
 *
 * ⚠️ Suprimir é NÃO ABRIR TURNO. A mensagem continua gravada como contexto —
 * mesma distinção do conserto da secretária: "não responda a isto" não é "não
 * leia isto".
 */
export function respostaDePipeline(
  texto: string,
  pipeline: PipelineDoChat | undefined,
  agora: number,
): boolean {
  if (!pipeline) return false;
  const janela = JANELA_DO_PIPELINE[pipeline.origin];
  if (janela === undefined) return false;
  if (agora - pipeline.quando > janela) return false;
  return ehConfirmacaoCurta(texto);
}

/**
 * O lote inteiro é eco de pipeline, e por isso não abre turno?
 *
 * ⚠️ Exige ao menos UMA mensagem recebida. Sem isso, um lote só de `is_from_me`
 * — o Thiago escrevendo no grupo principal, por exemplo — satisfaria o `every`
 * por vacuidade e seria suprimido, derrubando o grupo. A trava não apareceu em
 * teste nenhum quando eu a sabotei, o que é a definição de não estar medida.
 *
 * Lote MISTO não é suprimido: se junto do "SIM" veio um pedido, o turno
 * acontece e o "SIM" entra como contexto.
 */
export function soEcoDePipeline(
  mensagens: Array<{ content: string; is_from_me?: boolean }>,
  pipeline: PipelineDoChat | undefined,
  agora: number,
): boolean {
  if (!mensagens.some((m) => !m.is_from_me)) return false;
  return mensagens.every(
    (m) => m.is_from_me || respostaDePipeline(m.content, pipeline, agora),
  );
}
