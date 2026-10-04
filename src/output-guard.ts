/**
 * Guarda de saída: última inspeção do texto antes de chegar ao paciente.
 *
 * ## O que ela é, e o que ela não é
 *
 * A arquitetura alvo (`docs/AGENTE-ATENDIMENTO.md`) é classificador mais tabela
 * de templates fixos, onde o gate só pergunta "esta intenção tem template
 * aprovado?". Decisão do Thiago em 04/10/2026: **não ter a tabela agora.** O
 * agente redige livremente enquanto o conjunto de intenções ainda cresce, e o
 * grupo de teste existe para descobrir quais são.
 *
 * Então esta guarda inspeciona **texto livre**, não escolha de template. Ela não
 * substitui a tabela e não torna invenção impossível: ela pega as falhas que são
 * mecanicamente detectáveis, que são exatamente as que eu vinha encontrando à
 * mão lendo transcrição depois do fato.
 *
 * ## Três níveis, e por que não é tudo "bloquear"
 *
 * "Falhar fechado" é a regra certa para o que machuca, não para tudo. Jogar fora
 * uma resposta correta por causa de um travessão deixaria o paciente sem
 * resposta por um deslize de estilo, o que é pior para ele que o deslize.
 *
 *   sanitize → conserta e envia. Só onde o conserto é mecânico e seguro.
 *   flag     → envia e avisa. Deslize de estilo: o dano é soar a robô.
 *   block    → NÃO envia. Vira aviso para humano. Só onde o dano é real:
 *              preço de cirurgia, agendamento confirmado, dado de terceiro.
 *
 * ## A precisão importa mais que a cobertura
 *
 * O texto do F05, o mais importante de conversão, diz "desejam realizar a
 * cirurgia. A avaliação, que normalmente custa R$ 430,00, sai por R$ 300,00".
 * Dinheiro e "cirurgia" na mesma frase. Regra de proximidade ingênua bloquearia
 * justamente ele. Por isso a checagem de preço de cirurgia procura o **sujeito
 * do preço**, não a vizinhança: dinheiro atribuído à cirurgia é proibido,
 * dinheiro atribuído à avaliação é o trabalho.
 *
 * Guarda que bloqueia o certo é desligada pela equipe em uma semana, e aí não
 * guarda nada. Falso positivo aqui custa mais que falso negativo.
 */
import { readEnvFile } from './env.js';

const envConfig = readEnvFile(['OUTPUT_GUARD_FOLDERS']);

const FOLDERS = new Set(
  (process.env.OUTPUT_GUARD_FOLDERS || envConfig.OUTPUT_GUARD_FOLDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export function wantsOutputGuard(groupFolder?: string): boolean {
  return !!groupFolder && FOLDERS.has(groupFolder);
}

export type Nivel = 'sanitize' | 'flag' | 'block';

export interface Achado {
  regra: string;
  nivel: Nivel;
  motivo: string;
  trecho?: string;
}

export interface Veredito {
  /** Texto a enviar. Vazio quando bloqueado. */
  texto: string;
  bloqueado: boolean;
  achados: Achado[];
}

// --- dinheiro e assuntos de preço -------------------------------------------

const RX_DINHEIRO = /R\$\s?\d[\d.,]*|\b\d{3,4}\s?reais\b/gi;
const CIRURGIA =
  /cirurgi|facectomia|refrativ|catarata|pterígio|pterigio|lasik|prk|yag|capsulotomia|intraocular/i;
/** Assuntos cujo preço a Lara PODE dizer. */
const PRECIFICAVEL =
  /avalia[çc][ãa]o|consulta|retorno|exame|mapeamento|topografi|ceratoscopi/i;
/**
 * Pentacam saiu do precificável em 04/10/2026: o valor muda por hospital
 * (R$ 500 no Hospital do Olho, R$ 600 no Vilar), então a agente responde a
 * cobertura e escala o preço. Qualquer valor junto dele é erro.
 */
const RX_PENTACAM_VALOR =
  /pentacam[^.!?\n]{0,40}(?:R\$\s?\d|\d{3}\s?reais)|(?:R\$\s?\d|\d{3}\s?reais)[^.!?\n]{0,40}pentacam/i;

/**
 * Preço de cirurgia (regra dura 1b).
 *
 * A 1ª versão olhava o "último assunto antes do valor" e reprovou em produção
 * logo no primeiro teste, bloqueando uma resposta CORRETA:
 *
 *   "a consulta de avaliação para cirurgia refrativa é particular,
 *    no valor de R$ 430,00"
 *
 * Ali "cirurgia refrativa" é **modificador** de "consulta de avaliação", não o
 * sujeito do preço. O paciente ficou sem resposta nenhuma.
 *
 * A regra agora é por **janela**: para cada valor, o trecho entre o valor
 * anterior (ou o começo do texto) e este valor. Bloqueia só quando a janela
 * fala de cirurgia **e não nomeia nada precificável**. O texto legítimo da
 * clínica sempre nomeia o que está sendo cobrado (avaliação, consulta, exame);
 * a violação de verdade ("a cirurgia custa R$ 8.000") não nomeia nada.
 *
 * A janela também pega o caso misto, que o escopo por frase perderia:
 * "a avaliação é R$ 430 e a cirurgia fica R$ 8.000" bloqueia no 2º valor,
 * porque a janela dele é só " e a cirurgia fica ".
 */
export function achaPrecoDeCirurgia(texto: string): Achado | undefined {
  let inicioJanela = 0;
  for (const m of texto.matchAll(RX_DINHEIRO)) {
    const fim = m.index ?? 0;
    const janela = texto.slice(inicioJanela, fim);
    inicioJanela = fim + m[0].length;
    if (!CIRURGIA.test(janela)) continue;
    if (PRECIFICAVEL.test(janela)) continue;
    return {
      regra: 'preco_cirurgia',
      nivel: 'block',
      motivo:
        'valor atribuído a cirurgia sem nomear consulta, avaliação ou exame; a clínica nunca passa preço de cirurgia antes da avaliação (regra dura 1b)',
      trecho: (janela + m[0]).trim().slice(-120),
    };
  }
  return undefined;
}

// --- agendamento confirmado -------------------------------------------------

/**
 * Afirmar que está marcado (regra dura 3). Só pega AFIRMAÇÃO: o texto do F05
 * termina em "Podemos fazer seu agendamento garantindo o desconto?", que é
 * oferta, e precisa passar.
 */
const RX_CONFIRMADO =
  /\b(?:est[áa]|ficou|fica|t[áa])\s+(?:marcad|agendad|confirmad|reservad)|\bj[áa]\s+(?:marquei|agendei|confirmei|reservei|deixei marcad)|\b(?:marquei|agendei|reservei)\s+(?:voc[êe]|pra voc[êe]|seu|sua)|\bhor[áa]rio\s+(?:garantid|reservad)|\bconfirmad[oa]\s+(?:para|pra|no dia)/i;

// --- telemetria vazando -----------------------------------------------------

/** Linha de marcação que o agente deveria ter posto dentro de <internal>. */
const RX_LINHA_TELEMETRIA = /^\s*[[(]?\s*inten[çc][ãa]o\s*[:=][\s\S]*$/im;
/** Referência a bloco do FAQ ou a script: linguagem interna. */
const RX_INTERNO = /\bF\d{2}\b|\b\w+\.py\b|\biclinic_vagas\b|\bescalar\.py\b/;

// --- estilo -----------------------------------------------------------------

const PROIBIDAS: Array<[RegExp, string]> = [
  [/\bme conta\b/i, 'soa a chatbot de varejo'],
  // "me passa"/"me manda" sem atenuante é ordem, não pedido. O detector antigo
  // exigia dois-pontos ("me passa:") e deixou escapar "Me passa a data de
  // nascimento da Joana", que o Thiago apontou como bruto em 04/10/2026.
  [
    /\bme (?:passa|manda|envia)\b|\bpreciso que (?:voc[êe] )?(?:envie|mande|passe)\b/i,
    'imperativo seco ao pedir dado; use "poderia me informar" ou "qual é" (F10)',
  ],
  [
    /quer que eu (?:veja|confira|busque|procure)/i,
    'pede permissão para fazer o próprio trabalho',
  ],
  [
    /posso (?:verificar|conferir|checar)/i,
    'pede permissão para fazer o próprio trabalho',
  ],
  [
    /como posso (?:te )?ajudar|o que posso fazer por (?:voc[êe]|ti)|em que posso (?:te )?ajudar|como posso (?:te )?ser [úu]til/i,
    'empurra o trabalho para quem já disse o que quer',
  ],
  [
    /\b(?:cadastrad[oa]|no nosso sistema|na nossa base)\b/i,
    'narra limitação interna; o paciente não sabe que existe sistema',
  ],
  [
    /n[ãa]o tenho essa informa[çc][ãa]o (?:aqui|por aqui)/i,
    'narra limitação interna',
  ],
  [
    /estamos [àa] disposi[çc][ãa]o|permane[çc]o [àa] disposi[çc][ãa]o/i,
    'fecho de protocolo; use "Ajudo em algo mais?"',
  ],
  [/prezad[oa]\b/i, 'tratamento de ofício'],
  [/informamos que/i, 'tratamento de ofício'],
];

// --- exames "inclusos" ------------------------------------------------------

/**
 * Dizer que a consulta "inclui o exame completo" é promessa comercial que a
 * clínica terá de desdizer no balcão: fundoscopia e tonometria estão inclusas
 * nos R$ 430, mapeamento (R$ 300) e topografia (R$ 380) não.
 *
 * Aconteceu na leva 1 da suíte: "A avaliação é R$ 430,00 e já inclui o exame
 * completo". Nomear o que está incluso é legítimo e passa; a forma vaga, não.
 */
const RX_INCLUI_EXAME =
  /inclu\w+\s+(?:o\s+|os\s+|todos\s+os\s+)?exames?\b|exames?\s+(?:est[ãa]o\s+)?inclu[íi]d/i;
const NOMEIA_INCLUSO = /fundoscopia|tonometria|dois olhos|ambos os olhos/i;

// --- pedir dado que o paciente já deu ---------------------------------------

/**
 * Mandar o bloco dos quatro campos numa mensagem que CITA o convênio do paciente
 * significa que ela está pedindo de volta o que ele acabou de dizer. Saiu assim
 * em 04/10/2026: "Infelizmente a consulta pelo IASPI a gente não atende (...)
 * Convênio (ou particular):".
 *
 * Só dispara com o nome de um convênio no texto, então o formulário completo
 * para quem não disse nada passa limpo.
 */
const RX_FORM_CONVENIO = /conv[êe]nio\s*\(ou particular\)\s*:/i;
const RX_CITA_PLANO =
  /\b(?:IASPI|IAPEP|IPMT|Unimed|Hapvida|Humana|Intermed|Bradesco|Amil|SulAm[ée]rica)\b/i;

// --- coletar dados de CNPJ --------------------------------------------------

/**
 * Nota fiscal para pessoa jurídica escala (F11, regra do Thiago em 04/10/2026):
 * tem exigências próprias e quem monta é a recepção. Se a agente está PEDINDO
 * CNPJ, razão social ou inscrição municipal, ela assumiu um caso que não é dela,
 * e o paciente vai mandar os dados duas vezes.
 */
const RX_PEDE_CNPJ =
  /\bCNPJ\b|\braz[ãa]o social\b|\binscri[çc][ãa]o municipal\b|\bnome fantasia\b/i;

// --- dizer que atende plano que não atende ----------------------------------

/**
 * IASPI e IPMT **não** são atendidos para consulta: só a cirurgia vai pelo
 * PLAMTA e pelo PLANTE. Dizer "atende sim" apaga a exclusão da consulta e o
 * paciente chega achando que o plano cobre tudo.
 *
 * Saiu na suíte em 04/10/2026: "Atende sim, o IASPI cobre cirurgia pelo PLAMTA."
 * Mesmo vício do "inclui o exame completo": compressão que cria expectativa
 * errada sobre dinheiro.
 */
const RX_PLANO_PARCIAL = /\b(?:IASPI|IAPEP|IPMT)\b/i;
const RX_ATENDE_SIM =
  /\batende(?:mos)?\s+sim\b|\bsim,?\s+atende(?:mos)?\b|\bcobre\s+(?:sim|tudo)\b/i;
/** A exclusão da consulta tem que estar dita em algum lugar da mensagem. */
const RX_EXCLUI_CONSULTA =
  /consulta[^.!?\n]{0,60}(?:n[ãa]o|particular)|(?:n[ãa]o|particular)[^.!?\n]{0,60}consulta/i;

// --- afirmar que a lista está completa --------------------------------------

/**
 * Dizer "os exames pré-operatórios são dois" faz o paciente orçar a cirurgia
 * errado e descobrir o resto depois. A Dra. Marina pede outros conforme o caso,
 * parte deles fora da clínica, e a agente não tem esses valores.
 *
 * Saiu na suíte em 04/10/2026, e a culpa era do FAQ, que afirmava "São dois
 * exames" sem base.
 */
const RX_COMPLETUDE =
  /\b(?:s[ãa]o|[ée])\s+(?:apenas\s+|s[óo]\s+)?dois\s+exames?\b|\bexames?[^.!?\n]{0,40}\b(?:s[ãa]o|[ée])\s+(?:apenas\s+|s[óo]\s+)?dois\b|\bs[óo]\s+esses\s+dois\b|\bs[ãa]o\s+apenas\s+esses\b|\b[ée]\s+s[óo]\s+isso\s+que\s+precisa\b/i;

// --- fingir-se humana -------------------------------------------------------

/**
 * A agente escala quando perguntam se é robô, e nunca afirma ser pessoa. Calar e
 * passar adiante não é mentira; dizer que é humana, é, e isso bloqueia.
 */
const RX_FINGE_HUMANA =
  /\bsou (?:uma )?(?:pessoa|humana|gente)\b|\bn[ãa]o sou (?:um )?rob[ôo]\b|\bsou da recep[çc][ãa]o\b/i;

// --- abertura adulterada ---------------------------------------------------

/**
 * A regra anterior (`abertura_malformada`) exigia o menu completo em toda
 * mensagem que começasse com "Olá, Sou a Lara", e virou ruído puro: **68 dos 70
 * avisos** da 3ª passada eram ela. Canal de alerta com 97% de ruído é pior que
 * não ter alerta, que é a mesma fadiga de alarme que o ntfy evita.
 *
 * A causa foi a correção da regra 0 no mesmo dia: desde que a triagem deixou de
 * ser pré-requisito de resposta, cumprimentar e responder um fato SEM menu
 * passou a ser o comportamento correto.
 *
 * Sobraram os dois casos que motivaram a regra, agora detectados direto.
 */

/** Anunciar que é automática sem ninguém perguntar (F00e). */
const RX_ANUNCIA_BOT =
  /atendimento autom[áa]tico|assistente virtual|sou (?:um |uma )?(?:rob[ôo]|bot|IA|intelig[êe]ncia artificial)/i;

/** Menu numerado sem separar refrativa de catarata (F00). */
const RX_MENU_NUMERADO = /^\s*1\s*[-.)]\s*\S/m;
const RX_MENU_COMPLETO =
  /Cirurgia Refrativa[\s\S]*Cirurgia de Catarata[\s\S]*Rotina/i;

// --- mandar o paciente ligar ------------------------------------------------

/**
 * Mandar a pessoa ligar é transferir para ela o trabalho de ser atendida, e em
 * dor isso é pior ainda: quem liga é a clínica. Regra do Thiago em 04/10/2026,
 * que corrigiu a MINHA instrução anterior ("dê o número quando houver
 * urgência").
 *
 * Informar o telefone a quem PEDIU o telefone continua certo, então a regra olha
 * a combinação, não o número solto: telefone mais convite a ligar, ou telefone
 * mais contexto de dor.
 */
const RX_CONVITE_LIGAR = /\b(?:liga|ligue|ligar|nos liga|me liga)\b/i;
const RX_DOR =
  /\b(?:dor|doendo|doer|ardendo|arder|incomodando|urg[êe]ncia|urgente|p[óo]s[-\s]?operat[óo]rio|inchad)/i;

// --- mandar de volta ao menu ------------------------------------------------

/**
 * Apontar para o menu ("escolha uma das opções que enviei") é o mesmo vício que
 * reenviá-lo, e soa a atendimento eletrônico de telefone. O certo é pedir para a
 * pessoa explicar. Saiu na suíte em 04/10/2026, numa forma que a regra de "não
 * repetir o menu" não cobria.
 */
const RX_APONTA_MENU =
  /escolh[ae]r?\s+(?:uma\s+)?(?:das\s+)?op[çc][õo]es|escolh[ae]r?\s+(?:um\s+)?n[úu]mero|selecion[ae]r?\s+(?:a\s+)?op[çc][ãa]o|op[çc][õo]es que (?:eu\s+)?enviei/i;

// --- negar o desconto -------------------------------------------------------

/**
 * Dizer que NÃO tem desconto conta que o desconto existe. Quem não ia saber
 * passa a saber, e sai da conversa achando que pagou mais caro que alguém.
 *
 * Saiu assim na suíte em 04/10/2026: "Para pacientes particulares esse é o valor
 * da consulta, sem desconto."
 */
const RX_NEGA_DESCONTO =
  /sem desconto|n[ãa]o (?:tem|temos|h[áa]|oferecemos)\s+desconto|valor cheio|desconto n[ãa]o se aplica/i;

// --- dado de terceiro -------------------------------------------------------

const RX_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
/**
 * QUALQUER telefone na saída é bloqueado, sem exceção.
 *
 * Até 04/10/2026 havia uma exceção para "o telefone da clínica", (86) 3226-1619.
 * O Thiago apontou que esse número **não existe**: eu o inventei e o escrevi no
 * FAQ como fato. A verificação no corpus de 482 conversas confirmou zero
 * ocorrências. A atendente também não recebe ligação, só mensagem e áudio, então
 * não há telefone legítimo a informar e a exceção some.
 */
const RX_TELEFONE = /\(?\b(?:0?\d{2})\)?\s?9?\d{4}[-\s]?\d{4}\b/g;

// ---------------------------------------------------------------------------

/**
 * Inspeciona o texto. Devolve o que enviar (já saneado) e os achados.
 * Nunca lança: guarda que quebra o envio é pior que o problema que ela evita.
 */
export function inspecionaSaida(bruto: string): Veredito {
  const achados: Achado[] = [];
  let texto = bruto;

  // 1. sanitize: telemetria que escapou do <internal>
  if (RX_LINHA_TELEMETRIA.test(texto)) {
    texto = texto.replace(RX_LINHA_TELEMETRIA, '').trim();
    achados.push({
      regra: 'telemetria_vazada',
      nivel: 'sanitize',
      motivo: 'linha de marcação fora de <internal>; removida antes de enviar',
    });
  }

  // 2. sanitize: travessão, a marca registrada de texto de IA
  if (/[—–]/.test(texto)) {
    texto = texto.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*([.:;!?])/g, '$1');
    achados.push({
      regra: 'travessao',
      nivel: 'sanitize',
      motivo: 'travessão trocado por vírgula',
    });
  }

  // 3. block: preço de cirurgia
  const preco = achaPrecoDeCirurgia(texto);
  if (preco) achados.push(preco);

  // 4. block: afirmou que está marcado
  const conf = texto.match(RX_CONFIRMADO);
  if (conf) {
    achados.push({
      regra: 'agendamento_confirmado',
      nivel: 'block',
      motivo:
        'afirma que está marcado; quem efetiva é a recepção (regra dura 3)',
      trecho: conf[0],
    });
  }

  // 5. block: dado de terceiro
  const cpf = texto.match(RX_CPF);
  if (cpf) {
    achados.push({
      regra: 'dado_sensivel',
      nivel: 'block',
      motivo: 'CPF no texto; dado de paciente não sai daqui',
      trecho: '(omitido)',
    });
  }
  if (RX_TELEFONE.test(texto)) {
    achados.push({
      regra: 'telefone',
      nivel: 'block',
      motivo:
        'telefone na resposta; a clínica não tem telefone a informar (a atendente não recebe ligação) e um número qualquer pode ser de outro paciente',
      trecho: '(omitido)',
    });
  }
  RX_TELEFONE.lastIndex = 0; // regex global: zera entre chamadas

  // 6. flag: pediu o convênio de volta para quem já disse qual é
  if (RX_FORM_CONVENIO.test(texto) && RX_CITA_PLANO.test(texto)) {
    achados.push({
      regra: 'pede_dado_repetido',
      nivel: 'flag',
      motivo:
        'pede o convênio na lista numa mensagem que já nomeia o plano do paciente; peça só o que falta (F00)',
      trecho: RX_CITA_PLANO.exec(texto)?.[0] ?? '',
    });
  }

  // 7. flag: citou valor do Pentacam, que varia por hospital
  const pent = texto.match(RX_PENTACAM_VALOR);
  if (pent) {
    achados.push({
      regra: 'valor_pentacam',
      nivel: 'flag',
      motivo:
        'cita valor do Pentacam; muda por hospital (R$ 500 no Hospital do Olho, R$ 600 no Vilar), quem informa é a recepção (F08)',
      trecho: pent[0].slice(0, 60),
    });
  }

  // 8. flag: pediu dado de pessoa jurídica em vez de escalar
  const cnpj = texto.match(RX_PEDE_CNPJ);
  if (cnpj) {
    achados.push({
      regra: 'coleta_cnpj',
      nivel: 'flag',
      motivo:
        'pede dado de pessoa jurídica; nota em nome de CNPJ escala para a recepção (F11)',
      trecho: cnpj[0],
    });
  }

  // 9. flag: disse que atende plano que só cobre cirurgia
  if (
    RX_PLANO_PARCIAL.test(texto) &&
    RX_ATENDE_SIM.test(texto) &&
    !RX_EXCLUI_CONSULTA.test(texto)
  ) {
    achados.push({
      regra: 'plano_parcial',
      nivel: 'flag',
      motivo:
        'diz que atende IASPI/IPMT sem dizer que a CONSULTA não é coberta; só a cirurgia vai pelo PLAMTA/PLANTE (F04)',
      trecho: RX_ATENDE_SIM.exec(texto)?.[0] ?? 'atende sim',
    });
  }

  // 10. flag: afirmou que a lista de exames está completa
  const compl = texto.match(RX_COMPLETUDE);
  if (compl) {
    achados.push({
      regra: 'completude_falsa',
      nivel: 'flag',
      motivo:
        'afirma que os exames pré-operatórios são só esses; a Dra. Marina pede outros conforme o caso, parte fora da clínica (F08)',
      trecho: compl[0],
    });
  }

  // 11. block: afirmou ser pessoa
  const finge = texto.match(RX_FINGE_HUMANA);
  if (finge) {
    achados.push({
      regra: 'finge_humana',
      nivel: 'block',
      motivo:
        'afirma ser pessoa; quando perguntam se é robô a resposta é escalar e "Só um instante" (F00e)',
      trecho: finge[0],
    });
  }

  // 12. flag: anunciou que é automática, ou resumiu o menu
  const anuncia = texto.match(RX_ANUNCIA_BOT);
  if (anuncia) {
    achados.push({
      regra: 'anuncia_bot',
      nivel: 'flag',
      motivo:
        'anuncia que é automática; quando perguntam, a resposta é escalar e "Só um instante" (F00e)',
      trecho: anuncia[0],
    });
  }
  if (RX_MENU_NUMERADO.test(texto) && !RX_MENU_COMPLETO.test(texto)) {
    achados.push({
      regra: 'menu_resumido',
      nivel: 'flag',
      motivo:
        'menu numerado sem separar Cirurgia Refrativa de Cirurgia de Catarata (F00)',
      trecho: texto.slice(0, 80),
    });
  }

  // 13. flag: mandou o paciente ligar
  if (RX_CONVITE_LIGAR.test(texto) && RX_DOR.test(texto)) {
    achados.push({
      regra: 'manda_ligar',
      nivel: 'flag',
      motivo:
        'convida o paciente a ligar em contexto de dor; quem procura é a clínica. Acolha, escale com --urgente e diga "Só um instante" (F13)',
      trecho: RX_CONVITE_LIGAR.exec(texto)?.[0] ?? 'ligar',
    });
  }

  // 14. flag: mandou o paciente de volta ao menu
  const menu = texto.match(RX_APONTA_MENU);
  if (menu) {
    achados.push({
      regra: 'aponta_menu',
      nivel: 'flag',
      motivo: 'manda o paciente escolher no menu; peça para ele explicar (F00)',
      trecho: menu[0],
    });
  }

  // 15. flag: negou o desconto, contando que ele existe
  const nega = texto.match(RX_NEGA_DESCONTO);
  if (nega) {
    achados.push({
      regra: 'nega_desconto',
      nivel: 'flag',
      motivo: 'negar o desconto conta que ele existe; informe só o valor (F05)',
      trecho: nega[0],
    });
  }

  // 16. flag: prometeu exame incluso sem nomear o que está incluso
  const inclui = texto.match(RX_INCLUI_EXAME);
  if (inclui && !NOMEIA_INCLUSO.test(texto)) {
    achados.push({
      regra: 'exames_inclusos',
      nivel: 'flag',
      motivo:
        'diz que exame está incluso sem nomear qual; mapeamento e topografia são cobrados à parte e isso vira cobrança inesperada no balcão',
      trecho: inclui[0],
    });
  }

  // 17. flag: linguagem interna sobrevivendo no texto
  const interno = texto.match(RX_INTERNO);
  if (interno) {
    achados.push({
      regra: 'linguagem_interna',
      nivel: 'flag',
      motivo: 'nome de bloco do FAQ ou de script no texto ao paciente',
      trecho: interno[0],
    });
  }

  // 18. flag: frases proibidas de estilo
  for (const [rx, motivo] of PROIBIDAS) {
    const m = texto.match(rx);
    if (m) {
      achados.push({
        regra: 'frase_proibida',
        nivel: 'flag',
        motivo,
        trecho: m[0],
      });
    }
  }

  const bloqueado = achados.some((a) => a.nivel === 'block');
  return { texto: bloqueado ? '' : texto, bloqueado, achados };
}

/** Resumo para o aviso ao humano. Não inclui trecho de dado sensível. */
export function resumoDoAviso(v: Veredito, original: string): string {
  const linhas = v.achados
    .filter((a) => a.nivel !== 'sanitize')
    .map(
      (a) =>
        `• *${a.regra}* (${a.nivel}): ${a.motivo}${a.trecho ? `\n  _"${a.trecho}"_` : ''}`,
    );
  const cabecalho = v.bloqueado
    ? '⛔ *Resposta BLOQUEADA, paciente não recebeu*'
    : '⚠️ *Resposta enviada com ressalva*';
  return `${cabecalho}\n\n${linhas.join('\n')}\n\n*Texto do agente:*\n${original.slice(0, 700)}`;
}
