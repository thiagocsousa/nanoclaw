/**
 * A frase da triagem: pedir só o que falta.
 *
 * ## Por que isto não é cosmético
 *
 * Os quatro dados em tópicos são um formulário, e formulário no meio de conversa
 * soa a máquina. Pior: pedir de novo o que a pessoa acabou de responder é o
 * jeito mais rápido de parecer máquina, porque máquina é a única coisa que não
 * presta atenção. O Thiago apontou isso duas vezes em 04/10/2026, uma delas no
 * caso exato de um paciente que disse "IASPI" e levou "Convênio:" de volta.
 *
 * Então o host monta a frase a partir do que o classificador extraiu: quatro
 * faltando é o formulário aprovado da tabela, de um a três é frase corrida.
 *
 * ## Tom
 *
 * Todo pedido leva **"poderia me informar"**. "Me passa a data de nascimento da
 * Joana" é bruto e foi reprovado pelo Thiago; "Poderia me informar a data de
 * nascimento da Joana?" é a mesma coisa, educada. E quando o nome já é
 * conhecido, a frase o usa: custa nada e deixa de soar genérico.
 */

/** Os quatro dados da triagem, na ordem em que a clínica os pede (F00). */
export const CAMPOS = ['nome', 'nascimento', 'cidade', 'convenio'] as const;
export type Campo = (typeof CAMPOS)[number];

/** Como cada campo aparece numa frase corrida, não como rótulo de formulário. */
const EM_FRASE: Record<Campo, string> = {
  nome: 'o nome completo do paciente',
  nascimento: 'a data de nascimento',
  cidade: 'a cidade',
  convenio: 'o convênio (ou particular)',
};

export function faltamNaTriagem(slots: Record<string, string>): Campo[] {
  return CAMPOS.filter((c) => !slots[c]?.trim());
}

/** "a, b e c" — vírgula entre, "e" antes do último, como se escreve. */
function lista(itens: string[]): string {
  if (itens.length <= 1) return itens[0] ?? '';
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

/** Primeiro nome, para a frase não repetir o nome completo. */
function primeiroNome(nome?: string): string | undefined {
  const t = nome?.trim().split(/\s+/)[0];
  return t && t.length > 1 ? t : undefined;
}

export interface OpcoesDaFrase {
  /** O formulário completo da tabela, usado quando falta tudo. */
  textoCompleto: string;
  /**
   * Prefixo de propósito. Em `triagem_dados` o próximo passo é o horário, e
   * dizer isso justifica o pedido em vez de só exigir. Vazio desliga.
   */
  proposito?: string;
}

/**
 * Monta o que o paciente vai ler. String vazia quando não falta nada: aí não há
 * pergunta a fazer, e quem chama não deve emendar frase nenhuma.
 */
export function fraseDeTriagem(
  slots: Record<string, string>,
  opts: OpcoesDaFrase,
): string {
  const faltando = faltamNaTriagem(slots);
  if (faltando.length === 0) return '';
  // Nenhum dado na mão: é o primeiro contato, e o formulário aprovado é o certo.
  if (faltando.length === CAMPOS.length) return opts.textoCompleto;

  const de = primeiroNome(slots.nome);
  const itens = faltando.map((c) =>
    // "a data de nascimento de Joana" só quando o nome é conhecido e não é ele
    // mesmo que está faltando.
    //
    // ⚠️ "de", nunca "da" nem "do": o artigo exigiria adivinhar o gênero pelo
    // nome, e errar isso é errar com a pessoa, não com a gramática. "de Marcos"
    // e "de Joana" funcionam igual, e combinam com o tom formal.
    c === 'nascimento' && de ? `${EM_FRASE[c]} de ${de}` : EM_FRASE[c],
  );
  const proposito =
    opts.proposito === undefined
      ? 'Para eu já ver um horário, '
      : opts.proposito;
  const pedido = `poderia me informar ${lista(itens)}?`;
  return proposito
    ? `${proposito}${pedido}`
    : `${pedido.charAt(0).toUpperCase()}${pedido.slice(1)}`;
}
