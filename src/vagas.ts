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

/** Necessidade com intenção de cirurgia. Usada pelo perfil E pelo desconto. */
function ehCirurgico(n: string): boolean {
  return (
    n.includes('cirurgia') || n.includes('refrativa') || n.includes('catarata')
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
  if (!c || /particular|sem\s+(plano|conv[êe]nio)|nenhum/.test(c)) return false;
  // Unimed a clínica atende; qualquer outro plano é "não aceito".
  //
  // Isso INCLUI os bloqueados (Intermed, Hapvida, Humana), que o
  // `convenio_bloqueado` recusa para consulta E cirurgia. Parece contradição e
  // não é: decisão do Thiago em 07/10/2026 — eles recebem o desconto, e na
  // consulta descobrem que o plano não cobre a cirurgia, o que é a tentativa de
  // conversão para particular. Quem mexer aqui achando que é bug, não é.
  return !ehUnimed(convenio);
}

/** Convênio que a clínica atende para CONSULTA. O resto é particular. */
function ehUnimed(convenio?: string): boolean {
  return !!convenio && /unimed/i.test(convenio);
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
 * normaliza as variações ("retorno", "retorno-cirurgia", "exame"). E o executor
 * só consulta isto no caminho da AGENDA: `exames_preco` é resposta de preço
 * aprovada e continua saindo normalmente.
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
