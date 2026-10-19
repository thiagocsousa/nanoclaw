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
/**
 * Ausência EXPLÍCITA: a frase diz que o plano não existe mais, ou não existe.
 *
 * Precisa do OBJETO. "não tenho plano" e "cancelei" são ausência; "não tenho
 * certeza" e "não tenho o cartão aqui" não são — são incerteza sobre QUAL plano,
 * e foi confundi-las que criou o bug inverso do desconto em 19/10/2026.
 *
 * ⚠️ Esta vence o nome do plano. O Codex reproduziu em 19/10: "particular,
 * cancelei o Bradesco e não tenho mais plano" devolvia TEM PLANO, porque minha
 * regra de ordem dava a vitória ao nome sem exceção — e aí um particular ouvia
 * R$ 300,00. Declaração explícita de ausência é mais forte que a menção de um
 * nome, que pode ser histórico.
 *
 * ⛔ Não inclui "não uso mais o Bradesco": quem diz isso costuma emendar "agora
 * é Amil", e o nome seguinte é que vale.
 */
const RX_AUSENCIA_EXPLICITA =
  /\bcancel\w+|n[ãa]o\s+tenho\s+(?:mais\s+)?(?:plano|conv[êe]nio|seguro|nenhum)|n[ãa]o\s+(?:tenho|possuo)\s+(?:mais\s+)?nada|sem\s+(?:plano|conv[êe]nio|seguro)\b|nenhum\s+(?:plano|conv[êe]nio)/i;

export function temPlano(convenio?: string): boolean {
  const c = (convenio ?? '').toLowerCase().trim();
  if (!c) return false;
  // 1. Disse EXPLICITAMENTE que não tem, ou que cancelou: não tem. Vence o
  //    nome, que pode ser o do plano que ele acabou de cancelar.
  if (RX_AUSENCIA_EXPLICITA.test(c)) return false;
  // 2. Nomeou um plano: tem plano. Vence a palavra solta de ausência —
  //    "não tenho certeza, acho que é Bradesco" é incerteza, não ausência.
  if (RX_CITA_PLANO.test(c)) return true;
  // 3. Palavra de ausência sem objeto: particular, privado, por fora.
  if (RX_SEM_PLANO.test(c)) return false;
  // 4. Escreveu um nome que não conhecemos: é um plano. Negar o desconto a
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
/**
 * Em ORDEM, do mais específico para o genérico. A primeira que casa manda.
 *
 * ⚠️ A especificidade é load-bearing, não enfeite:
 *   - `retorno` vai para um perfil `soHumano` — a Lara não agenda retorno.
 *   - `cirurgia refrativa` dispara a pergunta da lente e os 3 dias de
 *     antecedência (`VOCABULARIO_REFRATIVO`, em `vagas.ts`).
 *   - `cirurgia` genérico NÃO dispara nenhum dos dois.
 *
 * A primeira versão devolvia sempre "cirurgia", e o Codex reproduziu o custo em
 * 19/10/2026: "é para o retorno da cirurgia" caía em `particular-cirurgia`, que
 * não é `soHumano` — a trava do retorno era contornada por uma omissão do
 * classificador. E "quero marcar a cirurgia refrativa" perdia a pergunta da
 * lente, podendo oferecer horário para menos de 3 dias a quem usa lente.
 */
const MENCOES: Array<[RegExp, string]> = [
  // Retorno primeiro: "retorno da cirurgia" tem as duas palavras, e é retorno.
  [
    /\bretorno\b[^.!?\n]{0,30}\bcirurgi\w*|\bcirurgi\w*[^.!?\n]{0,30}\bretorno\b/i,
    'retorno de cirurgia',
  ],
  [/\bretorno\b|\bvolta\w*\s+da\s+consulta\b/i, 'retorno'],
  [/\bcatarata\b/i, 'catarata'],
  // ⚠️ "óculos" exige verbo de livrar-se deles, igual ao `VOCABULARIO_REFRATIVO`
  // de `vagas.ts` — a razão está lá: "trocar o grau do óculos" é ROTINA, quer
  // receita nova, não operar. Com `óculos` solto, meu primeiro regex mandava
  // quem quer receita para a fila cirúrgica e dava desconto a ele.
  [
    /\brefrativ\w*|\blasik\b|\bprk\b|\bmiopia\b|\bastigmatism\w*|\bhipermetrop\w*|(?:parar de usar|largar|deixar de usar|n[ãa]o usar mais|livrar|sem)[^.!?]{0,20}[óo]culos/i,
    'cirurgia refrativa',
  ],
  [/\bcirurgi\w*|\boperar\b|\bopera[çc][ãa]o\b/i, 'cirurgia'],
];

export function necessidadeMencionada(
  necessidade: string | undefined,
  mensagem: string,
): string | undefined {
  // ⚠️ `necessidade` tem de chegar aqui JÁ COM A MEMÓRIA (`comLembrados`), não
  // só com o slot do turno. A primeira versão lia o slot do turno, então uma
  // menção nova a cirurgia com slot omitido ATROPELAVA o "cirurgia refrativa"
  // ou o "retorno" que a conversa já tinha estabelecido. Achado do Codex.
  if (necessidade?.trim()) return necessidade;
  return MENCOES.find(([rx]) => rx.test(mensagem))?.[1];
}

/**
 * O MENU DA BRUNA: a resposta automática do WhatsApp Business.
 *
 * ⏳ TEMPORÁRIO — semana de observação de 20/10/2026. O Thiago disse, no dia em
 * que me contou do menu: "vai ser assim apenas nessa semana de observação,
 * depois vamos eliminar esse menu". Quando o menu sair, ISTO SAI com ele, e os
 * dois testes em `convenio.test.ts` passam a reprovar de propósito para quem
 * esquecer.
 *
 * O menu que o paciente recebe ANTES de a Lara dizer qualquer coisa:
 *
 *   Olá, tudo bem? Sou a Bruna, assistente da Dra Marina Costa. Para
 *   agilizarmos o seu atendimento escolha a opção (…)
 *   1 - Avaliação para Cirurgia Refrativa
 *   2 - Avaliação para Cirurgia de Catarata
 *   3 - Consulta Oftalmológica de Rotina
 *   4 - Outros
 *
 * Sem esta tradução, a primeira mensagem de quase todo paciente da semana é um
 * número órfão: a `abertura` da Lara não tem mais menu (o Thiago tirou em
 * 17/10), e `DESCONHECIDO` passa a ser a classificação CORRETA para o que o
 * modelo viu — a observação encheria de escalada que não é culpa dela. O
 * comentário em `index.ts` já avisava disso para o menu antigo.
 *
 * ⛔ O "4 - Outros" NÃO vira necessidade. Significa "nenhuma das três", e
 * adivinhar qual é pior que perguntar.
 */
const MENU_DA_BRUNA: Record<string, string> = {
  '1': 'cirurgia refrativa',
  '2': 'catarata',
  '3': 'rotina',
};

/**
 * A necessidade que o número do menu significa, e nada mais.
 *
 * ⚠️ SÓ mensagem que é o número sozinho — é o que o menu produz. "tenho 2
 * filhos" e "nasci em 1980" não contam, e um número fora do menu ("7") não vira
 * nada: escala, como qualquer coisa que a Lara não entendeu.
 */
export function necessidadeDoMenu(mensagem: string): string | undefined {
  const m = mensagem.trim().match(/^([1-9])[\s.)-]*$/);
  return m ? MENU_DA_BRUNA[m[1]] : undefined;
}
