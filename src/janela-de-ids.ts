/**
 * "Já vi este id?", com teto.
 *
 * ⛔ Extraída para poder ser TESTADA, pela mesma razão que
 * `aceitaDmDeObservacao` saiu de dentro do canal: decisão enterrada num método
 * privado de uma classe que fala com socket não tem como ser medida, e esta tem
 * duas bordas fáceis de errar — o teto e a ordem de descarte.
 *
 * Nasceu do dedup do log de SLA (23/10/2026): o `messages.upsert` entrega a
 * mesma mensagem mais de uma vez, com `messageTimestamp` que pode diferir em 1
 * segundo entre as entregas, então o id é o único discriminador confiável.
 */

/**
 * Primeira vez que este id aparece? Registra-o se sim.
 *
 * ⚠️ Descarta o MAIS ANTIGO ao encher: `Set` preserva ordem de inserção, então
 * o primeiro do iterador é o mais velho. Descartar o mais novo deixaria a
 * duplicata recente passar, que é exatamente o caso que isto existe para pegar.
 */
export function primeiraVez(
  vistos: Set<string>,
  id: string,
  maximo: number,
): boolean {
  if (!id) return false;
  if (vistos.has(id)) return false;
  while (vistos.size >= maximo) {
    const maisAntigo = vistos.values().next().value as string | undefined;
    if (maisAntigo === undefined) break;
    vistos.delete(maisAntigo);
  }
  vistos.add(id);
  return true;
}
