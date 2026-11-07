/**
 * Mensagem que chegou e nunca descriptografou — o terceiro sumidouro silencioso.
 *
 * O `messages.upsert` entrega eventos com `message: null` quando a sessão
 * Signal não abre o envelope (`SessionError`). Os quatro caminhos de entrada
 * tratam isso com `if (!msg.message) continue;`, sem log: a mensagem chegou,
 * foi descartada, e ninguém soube — o mesmo formato de falha da DM endereçada
 * por LID, que levou duas semanas para ser notada.
 *
 * ⚠️ Medido no espelho cru em 07/11/2026, 10h36 de log, instância do
 * atendimento + principal: **604 ids falharam, 262 se recuperaram na
 * retentativa e 342 nunca tiveram versão legível**, contra 1072 ids legíveis.
 * Ou seja: ~24% da entrada se perdia, e avisar na PRIMEIRA falha erraria em
 * 43% dos casos — porque o baileys repete o mesmo id 8 a 12 vezes e boa parte
 * das repetições abre.
 *
 * Daí a forma: registra a falha, espera a janela de graça, e só avisa o que
 * nunca chegou legível. O que se recupera sai da lista em silêncio.
 *
 * Segue a disciplina de `janela-de-ids.ts` (teto + descarte do mais antigo) e
 * existe como módulo próprio pela mesma razão: decisão enterrada em método
 * privado de classe que fala com socket não tem como ser medida.
 */

export interface MensagemPerdida {
  id: string;
  jid: string;
  esperaMs: number;
}

/**
 * Esse JID conta como conversa de gente?
 *
 * `status@broadcast` e `@newsletter` entregam evento sem conteúdo por desenho
 * — status de terceiro e canal não são mensagem perdida. Dos 609 ids vazios
 * medidos, 5 eram status; incluí-los só sujaria o log que existe para alarmar.
 */
export function contaParaVigia(jid: string): boolean {
  if (!jid) return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@newsletter')) return false;
  return true;
}

export class VigiaDeDescriptografia {
  /** id → onde e quando a PRIMEIRA falha aconteceu. */
  private pendentes = new Map<string, { jid: string; quando: number }>();

  constructor(
    private readonly gracaMs = 60_000,
    private readonly teto = 5_000,
  ) {}

  /**
   * Chegou um evento sem conteúdo para este id.
   *
   * ⛔ A retentativa NÃO renova o prazo. Se cada repetição adiasse o
   * vencimento, uma mensagem que o baileys repete sem parar nunca venceria e
   * nunca seria reportada — perder-se-ia justamente o caso pior, que é o que
   * este vigia existe para enxergar.
   */
  falhou(id: string, jid: string, agora: number): void {
    if (!id || !contaParaVigia(jid)) return;
    if (this.pendentes.has(id)) return;
    while (this.pendentes.size >= this.teto) {
      const maisAntigo = this.pendentes.keys().next().value;
      if (maisAntigo === undefined) break;
      this.pendentes.delete(maisAntigo);
    }
    this.pendentes.set(id, { jid, quando: agora });
  }

  /** Chegou versão legível deste id. Devolve true se havia falha pendente. */
  chegou(id: string): boolean {
    if (!id) return false;
    return this.pendentes.delete(id);
  }

  /**
   * Remove e devolve o que passou da janela de graça sem versão legível.
   *
   * Varre tudo em vez de parar no primeiro não-vencido: a ordem de inserção
   * só é cronológica se o relógio nunca andar para trás, e `Date.now()` anda.
   * A lista guarda apenas as falhas dos últimos `gracaMs`, então varrer é
   * barato.
   */
  expirados(agora: number): MensagemPerdida[] {
    const fora: MensagemPerdida[] = [];
    for (const [id, p] of this.pendentes) {
      const esperaMs = agora - p.quando;
      if (esperaMs < this.gracaMs) continue;
      fora.push({ id, jid: p.jid, esperaMs });
    }
    for (const p of fora) this.pendentes.delete(p.id);
    return fora;
  }

  /** Quantas falhas ainda aguardam retentativa (para teste e diagnóstico). */
  get aguardando(): number {
    return this.pendentes.size;
  }
}
