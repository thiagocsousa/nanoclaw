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

export function faltamNaTriagem(
  slots: Record<string, string>,
  entre: readonly Campo[] = CAMPOS,
): Campo[] {
  return entre.filter((c) => !slots[c]?.trim());
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
  /**
   * O formulário completo da tabela, usado quando falta tudo.
   *
   * Opcional porque com `apenas` ele não tem uso: quem pede um subconjunto
   * nunca cai no formulário de quatro campos, e os chamadores eram obrigados a
   * passar `textoCompleto: ''` só para satisfazer o tipo.
   */
  textoCompleto?: string;
  /**
   * Prefixo de propósito. Em `triagem_dados` o próximo passo é o horário, e
   * dizer isso justifica o pedido em vez de só exigir. Vazio desliga.
   */
  proposito?: string;
  /**
   * Restringe o pedido a um subconjunto dos campos.
   *
   * Existe desde 21/10/2026, quando a oferta passou a vir ANTES da coleta
   * (Thiago: "hoje a gente faz assim" na clínica). No turno do aceite o que
   * falta para marcar é nome e nascimento — cidade e convênio ou já vieram, ou
   * não entram na marcação. Pedir os quatro ali seria devolver o formulário a
   * quem acabou de escolher um horário.
   */
  apenas?: readonly Campo[];
}

/**
 * Monta o que o paciente vai ler. String vazia quando não falta nada: aí não há
 * pergunta a fazer, e quem chama não deve emendar frase nenhuma.
 */
export function fraseDeTriagem(
  slots: Record<string, string>,
  opts: OpcoesDaFrase,
): string {
  const faltando = faltamNaTriagem(slots, opts.apenas ?? CAMPOS);
  if (faltando.length === 0) return '';
  // Nenhum dado na mão: é o primeiro contato, e o formulário aprovado é o certo.
  // ⚠️ Só vale quando o pedido é dos QUATRO. Com `apenas`, "falta tudo" quer
  // dizer "faltam os dois do aceite", e devolver o formulário inteiro ali seria
  // exatamente o que a oferta-antes-da-coleta veio tirar do caminho.
  //
  // ⚠️ A pergunta é `!opts.apenas`, não `entre === CAMPOS`. A primeira versão
  // comparava a REFERÊNCIA do array, então `apenas: [...CAMPOS]` — uma forma
  // natural de dizer "os quatro" — mudava o comportamento em silêncio, sem erro
  // de tipo e sem teste olhando.
  if (!opts.apenas && faltando.length === CAMPOS.length) {
    return opts.textoCompleto ?? '';
  }

  const de = primeiroNome(slots.nome);
  const itens = faltando.map((c) =>
    // "a data de nascimento de Joana" só quando o nome é conhecido e não é ele
    // mesmo que está faltando.
    //
    // ⚠️ "de", nunca "da" nem "do": o artigo exigiria adivinhar o gênero pelo
    // nome, e errar isso é errar com a pessoa, não com a gramática. "de Marcos"
    // e "de Joana" funcionam igual, e combinam com o tom formal.
    //
    // E não, não é por falta do dado: a ficha do iClinic TEM o campo de gênero
    // (conferido em 17/10/2026). A decisão de não usá-lo é do Thiago, no mesmo
    // dia, por dois motivos. "Data de nascimento de Zulmira" está correto em
    // português, então o ganho é de proximidade, não de correção. E o campo é
    // preenchido pela recepção, às vezes anos atrás e às vezes no chute pelo
    // nome — usá-lo seria terceirizar a mesma adivinhação, com a diferença de
    // que o erro passaria a ser invisível para nós.
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
