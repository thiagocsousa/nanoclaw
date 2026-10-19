/**
 * Vagas da agenda, buscadas pelo HOST.
 *
 * ## Por que o host, e não o modelo
 *
 * `src/classify.ts` proíbe o classificador de preencher `dia`, `hora` e valor:
 * é por aí que um horário inventado chegaria ao paciente. A consequência é que
 * `horario_oferta` e `dia_sem_atendimento` **não podem ser renderizados** sem
 * alguém de fora trazer esses valores, e esse alguém é este módulo.
 *
 * Deixar o agente rodar o script e repassar o resultado pareceria mais simples e
 * não serve: um valor que o modelo digita é um valor que o modelo pode ter
 * inventado, e não há como distinguir transcrição de invenção olhando o texto.
 * Então o host roda o script e lê a saída dele.
 *
 * ## Por que dentro de um container
 *
 * O script usa Playwright, que **não existe no host** (conferido na VM em
 * 04/10/2026), e existe na imagem do agente. As credenciais do iClinic estão no
 * `.env` do host e vão por `-e NOME`, herdando o valor: nunca `-e NOME=valor`,
 * que deixaria a senha visível em `ps`.
 *
 * ## Falha fecha
 *
 * Sem vaga, sem perfil, com o script falhando ou estourando o tempo, a função
 * devolve lista vazia. Quem chama então não tem `dia`/`hora`, o renderizador
 * rebaixa para DESCONHECIDO e o caso escala. O próprio script já avisa disso
 * quando não consegue ler a agenda: "NÃO ofereça horário, escale".
 */
import { execFile } from 'child_process';

import { ehUnimed, temPlano } from './convenio.js';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';

/** Mesmo teto do pre-check do agent-runner: Playwright no iClinic leva ~87s. */
const TIMEOUT_MS = Number(process.env.VAGAS_TIMEOUT_MS) || 180_000;

/** Variáveis que o script precisa. Valor vem do ambiente do host, nunca daqui. */
export const CREDENCIAIS = [
  'ICLINIC_EMAIL',
  'ICLINIC_PASSWORD',
  'ICLINIC_CLINIC_ID',
  'ICLINIC_PHYSICIAN_ID',
];

/**
 * Garante que as credenciais estejam em `process.env`, lendo o `.env`.
 *
 * O processo do app **não** recebe o `.env` pelo ambiente: o
 * `ecosystem.config.cjs` só define `NODE_ENV`, e todo o resto é lido do arquivo
 * por `readEnvFile`. Então `process.env.ICLINIC_EMAIL` é undefined em produção,
 * e `-e NOME` (que herda o valor do cliente docker) não passaria nada — o
 * container subia sem credencial e o login falhava.
 *
 * Isso não apareceu em nenhum teste meu porque eu rodava `set -a; . ./.env`
 * antes, ou seja, validei num ambiente que produção não tem. Medido em
 * 05/10/2026, com o `vagas: script falhou` no primeiro uso real.
 *
 * Preencher `process.env` preserva a propriedade que importa: continua sendo
 * `-e NOME` sem valor, então a senha não aparece em `ps`.
 */
export function garanteCredenciais(): void {
  const doArquivo = readEnvFile(CREDENCIAIS);
  for (const k of CREDENCIAIS) {
    if (!process.env[k] && doArquivo[k]) process.env[k] = doArquivo[k];
  }
}

export interface Vaga {
  /** ISO, como o script devolve: "2026-10-06". */
  data: string;
  dia_semana: string;
  inicio: string;
  fim: string;
}

/**
 * Perfis que o script aceita. Lista fechada de propósito: perfil errado é
 * horário inválido que já foi prometido ao paciente (FAQ F12).
 */
const PERFIS = new Set([
  'particular-cirurgia',
  'unimed-cirurgia',
  'particular',
  'unimed',
  'retorno-cirurgia',
  'retorno',
  'exame',
]);

/**
 * Vocabulário de cirurgia REFRATIVA, exportado porque o host precisa dele duas
 * vezes e com as duas definições tinha de bater.
 *
 * Em 17/10/2026 um teste pegou as duas discordando. Eu tinha escrito um regex
 * próprio no executor, para escolher o texto de preço que fala de óculos, e ele
 * reconhecia "quero parar de usar óculos". O `ehCirurgico` aqui não — então o
 * mesmo paciente recebia o enquadramento de cirurgia refrativa E o preço cheio
 * da consulta, porque o desconto julgou que não havia intenção cirúrgica.
 *
 * Duas definições de "intenção de cirurgia" no mesmo host é o achado 4 do
 * review do Codex outra vez, só noutro lugar. Agora é uma.
 *
 * ⚠️ "óculos" SOZINHO não entra, e isso foi conserto de 18/10/2026. Na primeira
 * versão eu pus a palavra solta, e o Thiago pediu para conferir que o desconto
 * só vale para intenção cirúrgica — a conferência mostrou "preciso trocar o
 * grau do óculos" recebendo R$ 300. Trocar o grau é ROTINA: a pessoa quer
 * receita nova, não operar. Agora o vocabulário exige o verbo de livrar-se
 * deles ("parar de usar óculos", "largar os óculos"), que é como quem quer
 * cirurgia refrativa fala.
 */
export const VOCABULARIO_REFRATIVO =
  /refrativ|miopia|astigmatism|hipermetrop|lasik|prk|(?:parar de usar|largar|deixar de usar|n[ãa]o usar mais|livrar|sem)[^.!?]{0,20}[óo]culos/i;

/**
 * Necessidade com intenção de cirurgia. Usada pelo perfil E pelo desconto.
 *
 * "Quero parar de usar óculos" é intenção de cirurgia dita como o paciente
 * fala, e entra: quem diz isso vai para a fila cirúrgica e paga a consulta com
 * desconto se o plano não for aceito, igual a quem escreve "refrativa".
 */
function ehCirurgico(n: string): boolean {
  return (
    n.includes('cirurgia') ||
    n.includes('catarata') ||
    VOCABULARIO_REFRATIVO.test(n)
  );
}

/**
 * O desconto da consulta: intenção de CIRURGIA **e** plano não atendido.
 *
 * As duas condições juntas. É o erro mais fácil de cometer na tabela de preços
 * da clínica, porque os dois descontos têm critérios quase opostos:
 *
 *   cirúrgico PARTICULAR (sem plano)  → consulta R$ 430 cheia, exames com desconto
 *   cirúrgico com PLANO NÃO ACEITO    → consulta R$ 300,       exames cheios
 *   rotina                            → consulta R$ 430,       exames cheios
 *
 * Mora no HOST por decisão do Thiago em 06/10/2026, e não no prompt: é regra
 * determinística sobre dois slots que o host já tem na mão. Na passada 5 o
 * classificador rotulou `convenio_nao_atendido` e depois `preco_consulta` para
 * um paciente com intenção cirúrgica e Bradesco — os dois textos citam R$ 430,
 * e ele ouviu o preço errado duas vezes. Esperar que o modelo lembre de uma
 * regra de duas condições é exatamente a aposta que esta arquitetura existe
 * para não fazer.
 */
export function temDescontoDeConsulta(
  necessidade?: string,
  convenio?: string,
): boolean {
  if (!necessidade || !convenio) return false;
  if (!ehCirurgico(necessidade.toLowerCase())) return false;
  const c = convenio.toLowerCase().trim();
  // Sem plano nenhum não há desconto: particular paga a consulta cheia.
  // Quem decide é `temPlano`, em `convenio.ts`, com a regra de ordem — nome de
  // plano vence palavra de ausência. Ver lá o porquê: a lista enumerada errava
  // nas duas direções.
  if (!temPlano(c)) return false;
  // Unimed a clínica atende; qualquer outro plano é "não aceito".
  //
  // Isso INCLUI os bloqueados (Intermed, Hapvida, Humana), que o
  // `convenio_bloqueado` recusa para consulta E cirurgia. Parece contradição e
  // não é: decisão do Thiago em 07/10/2026 — eles recebem o desconto, e na
  // consulta descobrem que o plano não cobre a cirurgia, o que é a tentativa de
  // conversão para particular. Quem mexer aqui achando que é bug, não é.
  return !ehUnimed(convenio);
}

/**
 * Deriva o `--perfil` da necessidade e do convênio.
 *
 * Devolve undefined quando falta um dos dois, e aí quem chama não busca vaga:
 * "não rode no chute" é regra do F12, porque o perfil decide duração,
 * antecedência e cota, e errá-lo produz uma vaga que não existe.
 */
/**
 * Perfis que a Lara NUNCA agenda: retorno e exame vão sempre para uma pessoa.
 *
 * Regra do Thiago em 06/10/2026, perguntada como "retorno e exame podem no
 * mesmo dia?" e respondida mais forte: não é restrição de encaixe, é de escopo
 * — ela não oferece nem marca esses dois em dia nenhum.
 *
 * O porquê é o mesmo de `cancelar_consulta` e `remarcar_consulta`: retorno
 * depende do que a médica pediu na consulta anterior, e exame depende de qual
 * exame foi solicitado. Nada disso está na agenda, então oferecer horário aqui
 * é prometer vaga sem saber o que vai ocupar.
 *
 * Fica sobre o PERFIL, não sobre a necessidade crua, porque `perfilDe` já
 * normaliza as variações ("retorno", "retorno-cirurgia", "exame").
 *
 * ⚠️ Até 19/10/2026 esta doc dizia que o executor "só consulta isto no caminho
 * da AGENDA". Deixou de ser verdade no mesmo dia: o gate passou a valer também
 * antes do formulário de triagem, porque quem pedia retorno digitava os quatro
 * dados para só então ser escalado.
 *
 * O que continua valendo, e é o que a frase antiga queria proteger: isto NÃO é
 * consultado no caminho de RESPOSTA. `exames_preco` e "quanto custa o retorno?"
 * são respostas aprovadas e continuam saindo. O gate vale para MARCAR.
 */
const PERFIS_SO_HUMANO = new Set(['retorno', 'retorno-cirurgia', 'exame']);

export function soHumano(perfil: string): boolean {
  return PERFIS_SO_HUMANO.has(perfil);
}

export function perfilDe(
  necessidade?: string,
  convenio?: string,
): string | undefined {
  if (!necessidade) return undefined;
  const n = necessidade.toLowerCase();
  if (n.includes('exame')) return 'exame';
  const cirurgico = ehCirurgico(n);
  if (n.includes('retorno')) return cirurgico ? 'retorno-cirurgia' : 'retorno';
  // Sem convênio declarado não se escolhe entre unimed e particular.
  if (!convenio) return undefined;
  if (cirurgico)
    return ehUnimed(convenio) ? 'unimed-cirurgia' : 'particular-cirurgia';
  return ehUnimed(convenio) ? 'unimed' : 'particular';
}

function executa(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr?.trim()) {
          logger.debug({ stderr: stderr.slice(0, 400) }, 'vagas: stderr');
        }
        if (err) {
          logger.warn(
            { err: err.message },
            'vagas: script falhou ou estourou o tempo',
          );
          return resolve(undefined);
        }
        resolve(stdout);
      },
    );
  });
}

/** Última linha não vazia da saída é o JSON do script. */
function leJson(saida: string): { vagas?: unknown } | undefined {
  const linhas = saida.trim().split('\n');
  for (let i = linhas.length - 1; i >= 0; i--) {
    const t = linhas[i].trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* tenta a anterior */
    }
  }
  return undefined;
}

export interface OpcoesDeBusca {
  /** Dia específico, ISO. Sem ele o script procura o próximo disponível. */
  dia?: string;
  /**
   * Hora específica, "HH:MM". O script **exige `--dia` junto** e, com os dois,
   * responde se aquele horário exato cabe. É assim que se relê uma vaga no
   * instante da escrita: lista vazia significa que ela já foi tomada.
   */
  hora?: string;
  /**
   * Dias mínimos a partir de hoje. Soma-se à regra do perfil pelo MAIOR dos
   * dois, não pela soma — quem é Unimed e usa lente espera o maior prazo.
   *
   * Existe para o preparo de lente de contato (19/10/2026): a lente deforma a
   * córnea e a medida da avaliação refrativa sai errada. Sem isto a Lara
   * oferecia amanhã a quem precisa de 3 dias sem usar, e o paciente viajava
   * para um exame que não prestaria.
   */
  antecedencia?: number;
}

/** Busca vagas rodando o script na imagem do agente. Lista vazia = escalar. */
export async function buscaVagas(
  groupFolder: string,
  perfil: string,
  opts: OpcoesDeBusca = {},
): Promise<Vaga[]> {
  if (!PERFIS.has(perfil)) {
    logger.warn({ perfil }, 'vagas: perfil fora da lista, não vou buscar');
    return [];
  }
  const dir = path.join(GROUPS_DIR, groupFolder);
  const script = path.join(dir, 'scripts', 'iclinic_vagas.py');
  if (!fs.existsSync(script)) {
    logger.error({ script }, 'vagas: iclinic_vagas.py não existe na pasta');
    return [];
  }

  garanteCredenciais();
  const args = ['run', '--rm', '--network', 'bridge'];
  // `-e NOME` herda o valor do ambiente do host: a senha não aparece em `ps`.
  for (const k of CREDENCIAIS) {
    if (process.env[k]) args.push('-e', k);
  }
  args.push(
    '-v',
    `${dir}:/workspace/group:ro`,
    '--entrypoint',
    'python3',
    CONTAINER_IMAGE,
    '/workspace/group/scripts/iclinic_vagas.py',
    '--perfil',
    perfil,
  );
  if (opts.dia) args.push('--dia', opts.dia);
  if (opts.hora) {
    if (!opts.dia) {
      // O script sai com erro nesse caso, e aqui o erro é meu: pedir hora sem
      // dia é um bug de quem chamou, não uma indisponibilidade de agenda.
      logger.error('vagas: --hora exige --dia; não vou buscar');
      return [];
    }
    args.push('--hora', opts.hora);
  }
  if (opts.antecedencia && opts.antecedencia > 0) {
    args.push('--antecedencia', String(Math.floor(opts.antecedencia)));
  }

  const t0 = Date.now();
  const saida = await executa(args);
  if (!saida) return [];

  const obj = leJson(saida);
  const brutas = Array.isArray(obj?.vagas) ? obj.vagas : [];
  const vagas = brutas.filter(
    (v): v is Vaga =>
      !!v &&
      typeof v === 'object' &&
      typeof (v as Vaga).data === 'string' &&
      typeof (v as Vaga).inicio === 'string' &&
      typeof (v as Vaga).dia_semana === 'string',
  );
  logger.info(
    { groupFolder, perfil, encontradas: vagas.length, ms: Date.now() - t0 },
    'vagas: busca concluída',
  );
  return vagas;
}

/**
 * Qual das vagas oferecidas o paciente escolheu, pelo que ele escreveu.
 *
 * Devolve a vaga, ou `undefined` quando não dá para saber — e aí quem chama
 * PERGUNTA, não adivinha. Marcar o dia errado manda a pessoa à clínica no dia
 * errado, que é pior que uma mensagem a mais.
 *
 * Com uma vaga só, qualquer aceite serve: não há o que confundir.
 */
/** Minúsculas e sem acento, para comparar o que a pessoa escreveu. */
export function semAcento(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function vagaEscolhida(vagas: Vaga[], texto: string): Vaga | undefined {
  if (vagas.length === 0) return undefined;
  if (vagas.length === 1) return vagas[0];
  const t = semAcento(texto);

  // ⚠️ Negação primeiro: "a primeira não, pode ser a segunda" casava com
  // "primeir" e marcava a PRIMEIRA. Reproduzido pelo review adversarial do
  // Codex em 19/10/2026. Com negação na frase, o host pergunta — é uma
  // mensagem a mais contra marcar o dia errado.
  if (/\b(nao|nem|nenhum|outra|outro)\b/.test(t)) return undefined;

  // ORDINAL EXPLÍCITO vence tudo: "a segunda OPÇÃO", "o segundo", "2ª".
  //
  // Essas formas não são dia da semana — "opção" e "alternativa" marcam, o
  // masculino não existe em dia ("segundo" ≠ "segunda-feira"), e o ordinal
  // numérico é inequívoco.
  const masculino = /\b(?:o |no )?(primeiro|segundo)\b/.exec(t);
  if (masculino) return masculino[1] === 'primeiro' ? vagas[0] : vagas[1];
  const numerico = /\b([12])\s*[ªº°]/.exec(t);
  if (numerico) return numerico[1] === '1' ? vagas[0] : vagas[1];
  const marcado =
    /\b(primeir|segund)[ao]\b.{0,12}\b(opcao|alternativa|hora)/.exec(t);
  if (marcado) return marcado[1] === 'primeir' ? vagas[0] : vagas[1];

  // DIA/DATA/HORA vêm ANTES do ordinal NU, e esta ordem é o conserto.
  //
  // "pode ser segunda", com segunda e quarta na mesa, marcava QUARTA: o regex
  // de ordinal casava o prefixo "segund" antes de alguém olhar o dia da
  // semana. "segunda-feira fica melhor" também. Dia da semana é o que o
  // paciente quis dizer em quase todo caso; ordinal é o resto.
  const porDia = vagas.filter((v) => casaDiaOuHora(v, t));
  if (porDia.length === 1) return porDia[0];
  if (porDia.length > 1) return undefined;

  // Ordinal NU ("a segunda"), e só quando não é dia de nenhuma vaga oferecida.
  // Se alguma vaga fosse de segunda-feira, o passo acima já teria resolvido.
  const ordinal = /\b(primeir|segund)[ao]\b/.exec(t);
  if (ordinal && !mencionaDiaDeAlgumaVaga(vagas, t)) {
    return ordinal[1] === 'primeir' ? vagas[0] : vagas[1];
  }
  return undefined;
}

/** A vaga é identificada pelo dia da semana, pela data ou pela hora no texto? */
function casaDiaOuHora(v: Vaga, t: string): boolean {
  const dia = semAcento(v.dia_semana || '');
  const [, mes, d] = v.data.split('-');
  const [hh, mm] = v.inicio.split(':');
  // Exige `h` ou `:` grudado: senão o "9" de uma data casaria com 09:00.
  const rxHora = new RegExp(
    `\\b0?${Number(hh)}\\s*(?:[h:]\\s*${mm}\\b|[h:](?!\\d)|h\\b)`,
  );
  return (
    (!!dia && new RegExp(`\\b${dia}(?:[- ]?feira)?\\b`).test(t)) ||
    (!!d && !!mes && t.includes(`${d}/${mes}`)) ||
    rxHora.test(t)
  );
}

/** Alguma das vagas é do dia da semana citado no texto? */
function mencionaDiaDeAlgumaVaga(vagas: Vaga[], t: string): boolean {
  return vagas.some((v) => {
    const dia = semAcento(v.dia_semana || '');
    return !!dia && new RegExp(`\\b${dia}\\b`).test(t);
  });
}

/**
 * A hora pedida vira `HH:MM`, ou `undefined` quando não der para saber.
 *
 * O script valida o formato e recusa fora da janela, mas aceita só `HH:MM`.
 * "10h", "10 horas" e "10:00" são a mesma coisa para quem escreve.
 */
export function horaPedidaIso(pedido?: string): string | undefined {
  const t = (pedido ?? '').trim().toLowerCase();
  if (!t) return undefined;
  // O `h` ou `:` é OBRIGATÓRIO: sem ele, "dia 10" viraria 10:00. E o casamento
  // termina no marcador, não num `\b` — entre "0" e "h" não existe fronteira de
  // palavra, e a primeira versão desta regex não casava "10h", que é
  // exatamente como as pessoas escrevem.
  const m = t.match(/\b([01]?\d|2[0-3])\s*(?::|h|\s*horas?\b)\s*([0-5]\d)?/);
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** O perfil é particular? A hora pedida só é aceita nesses (Thiago, 19/10). */
export function ehParticular(perfil: string): boolean {
  return perfil.startsWith('particular');
}

/**
 * As DUAS opções a oferecer: a melhor vaga, e a melhor de OUTRO DIA.
 *
 * Decisão do Thiago em 19/10/2026: "as duas opções disponíveis de horários
 * deveriam ser em dias distintos". Antes era `vagas.slice(0, 2)`, e como o
 * `iclinic_vagas.py` ranqueia por encaixe — ele esgota as posições de um dia
 * antes de ir para o próximo — as duas caíam colada uma na outra:
 *
 *   "Tenho quarta, dia 21/10, às 17:40 ou às 18:00."
 *
 * Vinte minutos de diferença não é escolha, é a mesma coisa duas vezes. Dois
 * dias é escolha de verdade, e dobra a chance de um servir.
 *
 * ⚠️ FALLBACK: quando só existe um dia com vaga, volta a oferecer duas no mesmo
 * dia. Duas opções ruins é melhor que uma — e é por isso que o
 * `textos_dois_mesmo_dia` continua existindo, agora como exceção e não como
 * caso comum.
 *
 * ⚠️ TETO: a segunda tem de estar a no máximo 10 dias da primeira. Com a semana
 * cheia, "quarta 21/10 ou segunda 03/11" não é escolha — é ruído. Passando do
 * teto, oferece UMA e deixa o paciente pedir outro dia, que o host sabe tratar
 * (`dia_pedido`). Decisão do Thiago em 19/10/2026.
 *
 * A ORDEM de dentro do dia é preservada: a segunda é a melhor vaga do outro
 * dia, não a primeira que aparecer. O ranking do script é a fonte da aritmética
 * de agenda e não se reordena aqui.
 */
const TETO_DA_SEGUNDA_EM_DIAS = 10;

/** Dias entre duas datas ISO. Devolve undefined se alguma não for ISO. */
function diasEntre(a: string, b: string): number | undefined {
  const ta = Date.parse(`${a}T12:00:00Z`);
  const tb = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return undefined;
  return Math.round(Math.abs(tb - ta) / 86_400_000);
}

export function duasOpcoes(vagas: Vaga[]): Vaga[] {
  const [primeira] = vagas;
  if (!primeira) return [];
  const deOutroDia = vagas.find((v) => {
    if (v.data === primeira.data) return false;
    // ⚠️ TETO de 10 dias (Thiago, 19/10/2026): "limita a no máximo 10 dias
    // depois, se não tiver, só oferece uma".
    //
    // Sem o teto, com a semana cheia a oferta sairia "quarta 21/10 ou segunda
    // 03/11" — e a segunda opção vira ruído, não escolha. Melhor oferecer uma
    // e deixar o paciente pedir outro dia.
    const d = diasEntre(primeira.data, v.data);
    return d !== undefined && d <= TETO_DA_SEGUNDA_EM_DIAS;
  });
  if (deOutroDia) return [primeira, deOutroDia];
  // Um dia só com vaga: duas no mesmo dia continua melhor que uma.
  const mesmoDia = vagas.filter((v) => v.data === primeira.data);
  if (mesmoDia.length > 1) return mesmoDia.slice(0, 2);
  // Há outro dia, mas longe demais. Oferece só a primeira.
  return [primeira];
}

/**
 * Os slots de UMA ou DUAS vagas, com o sufixo `_b` na segunda.
 *
 * A trinca `dia_b`/`data_b`/`hora_b` era montada à mão em dois lugares do
 * executor, e `templates.ts` decide `textos_dois` olhando só duas das três. Um
 * site que esquecesse `data_b` passava no teste de `temSegunda`, caía no texto
 * de duas opções, e o render rebaixava por chave aberta: o paciente recebia
 * "Só um instante." com duas vagas boas na mão.
 */
export function slotsDasVagas(vagas: Vaga[]): Record<string, string> {
  const [a, b] = vagas;
  if (!a) return {};
  const s = slotsDaVaga(a);
  if (!b) return s;
  const sb = slotsDaVaga(b);
  return { ...s, dia_b: sb.dia, data_b: sb.data, hora_b: sb.hora };
}

/**
 * Converte a vaga nos slots que os textos usam. `data` sai em DD/MM, que é
 * como a clínica escreve: "Tenho segunda, dia 06/10, às 09:20".
 */
export function slotsDaVaga(v: Vaga): Record<string, string> {
  const [, mes, dia] = v.data.split('-');
  return {
    dia: v.dia_semana,
    data: dia && mes ? `${dia}/${mes}` : v.data,
    hora: v.inicio,
  };
}
