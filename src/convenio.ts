/**
 * O vocabulário de convênio, num lugar só.
 *
 * O slot `convenio` é texto livre: o modelo copia o que o paciente escreveu, e
 * o paciente escreve "Bradesco Saúde particular", "não tenho certeza, acho que
 * é Bradesco", "Hapvida, mas pago por fora o que ele não cobre". Três módulos
 * liam esse slot com regexes próprios — `vagas.ts` (desconto), `executor.ts`
 * (qual texto de plano parcial) e `output-guard.ts` (o formulário de convênio) —
 * e cada um tinha a sua lista.
 *
 * Este módulo existe para não haver uma quarta. É deliberadamente sem
 * dependências: `output-guard.ts` é função pura e importar `vagas.ts` arrastaria
 * `child_process` para dentro da guarda.
 *
 * ## A regra de ORDEM, que é o conserto de 19/10/2026
 *
 * Nome de plano VENCE palavra de ausência. Na passada 17 o C01 mostrou o lado
 * fácil — "particular, nao tenho plano" virava "plano não aceito" e a Lara dava
 * R$ 300,00 a quem paga R$ 430,00. Eu alarguei a lista de ausência e criei o
 * lado inverso, achado pelo /simplify no mesmo dia:
 *
 *   "não tenho certeza, acho que é Bradesco"        → negava o desconto
 *   "nao tenho o cartao aqui, mas é Amil"           → negava o desconto
 *   "não uso mais o Bradesco, agora é Amil"         → negava o desconto
 *   "Hapvida, mas pago por fora o que ele não cobre" → negava o desconto
 *   "Bradesco Saúde particular"                     → negava o desconto
 *
 * Enumerar não converge em nenhuma das duas direções. A ordem converge: se o
 * paciente NOMEOU um plano, ele tem plano, não importa o que mais escreveu.
 */

/**
 * Nomes de plano que aparecem de verdade nesta clínica.
 *
 * Não precisa ser completa: um nome fora da lista cai no `return true` final de
 * `temPlano`, que é o padrão certo — o erro caro é negar o desconto a quem tem
 * plano, e o padrão protege contra ele. A lista serve para VENCER as palavras de
 * ausência quando as duas coisas aparecem na mesma frase.
 */
export const RX_CITA_PLANO =
  /\b(?:IASPI|IAPEP|IPMT|PLAMTA|PLANTE|Unimed|Hapvida|Humana|Intermed|Bradesco|Amil|SulAm[ée]rica|NotreDame|Notre\s?Dame|Cassi|Geap|Postal)\b/i;

/** As formas de dizer "não tenho plano". */
export const RX_SEM_PLANO =
  /particular|privad|sem\s+(?:plano|conv[êe]nio|seguro)|nenhum|n[ãa]o\s+(?:tenho|possuo|uso)\b|pago\s+(?:do\s+)?(?:meu\s+)?bolso|por\s+fora/i;

/**
 * O paciente paga algum plano de saúde?
 *
 * Decide dinheiro (ver `temDescontoDeConsulta`, em `vagas.ts`), então a ordem
 * importa e está testada nos dois sentidos em `convenio.test.ts`.
 */
export function temPlano(convenio?: string): boolean {
  const c = (convenio ?? '').toLowerCase().trim();
  if (!c) return false;
  // 1. Nomeou um plano: tem plano, qualquer que seja o resto da frase.
  if (RX_CITA_PLANO.test(c)) return true;
  // 2. Disse que não tem: não tem.
  if (RX_SEM_PLANO.test(c)) return false;
  // 3. Escreveu um nome que não conhecemos: é um plano. Negar o desconto a
  //    quem tem plano é o erro caro; conceder a quem não tem custa R$ 130.
  //    Entre os dois, o padrão protege o paciente de ouvir dois preços.
  return true;
}

/** Convênio que a clínica atende para CONSULTA. O resto é particular. */
export function ehUnimed(convenio?: string): boolean {
  return !!convenio && /unimed/i.test(convenio);
}

/**
 * A necessidade que o paciente mencionou, quando o modelo deixou o slot vazio.
 *
 * ## Por que existe
 *
 * O desconto da consulta tem três condições: intenção CIRÚRGICA, tem plano, e o
 * plano não é Unimed. A primeira é lida do slot `necessidade`, que o modelo
 * preenche de forma instável quando "cirurgia" aparece sem diagnóstico junto.
 * Medido na passada 17:
 *
 *   "voces fazem cirurgia pelo PLAMTA?"             → necessidade vazia → R$ 430
 *   "voces atendem IPMT pra cirurgia de catarata?"  → "catarata"        → R$ 300
 *
 * A mesma pergunta, dois preços, e a regra certa nos dois casos. O que variava
 * era o slot. E o pior lado disso: quem diz só "cirurgia" e nada mais é o
 * paciente MAIS indeciso da fila, e era quem ouvia o valor mais alto — justo
 * quem o desconto existe para converter.
 *
 * Decisão do Thiago em 19/10/2026: o host preenche.
 *
 * ## O que ela NÃO faz
 *
 * Não adivinha o procedimento. Devolve o termo genérico "cirurgia", que é o que
 * o paciente disse — `ehCirurgico` reconhece, e `perfilDe` manda para
 * `particular-cirurgia`, que é a avaliação cirúrgica. Qual cirurgia é assunto da
 * consulta, não do slot.
 *
 * ⚠️ Só roda com o slot VAZIO. Nunca sobrescreve o que o modelo rotulou: se ele
 * disse "catarata", é catarata.
 */
const RX_MENCIONA_CIRURGIA =
  /\bcirurgi\w*|\bcatarata\b|\boperar\b|\bopera[çc][ãa]o\b|\brefrativ\w*|\blasik\b|\bprk\b/i;

export function necessidadeMencionada(
  necessidade: string | undefined,
  mensagem: string,
): string | undefined {
  if (necessidade?.trim()) return necessidade;
  return RX_MENCIONA_CIRURGIA.test(mensagem) ? 'cirurgia' : undefined;
}
