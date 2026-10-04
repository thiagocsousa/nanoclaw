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
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';

/** Mesmo teto do pre-check do agent-runner: Playwright no iClinic leva ~87s. */
const TIMEOUT_MS = Number(process.env.VAGAS_TIMEOUT_MS) || 180_000;

/** Variáveis que o script precisa. Valor vem do ambiente do host, nunca daqui. */
const CREDENCIAIS = [
  'ICLINIC_EMAIL',
  'ICLINIC_PASSWORD',
  'ICLINIC_CLINIC_ID',
  'ICLINIC_PHYSICIAN_ID',
];

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
export function perfilDe(
  necessidade?: string,
  convenio?: string,
): string | undefined {
  if (!necessidade) return undefined;
  const n = necessidade.toLowerCase();
  if (n.includes('exame')) return 'exame';
  const cirurgico = n.includes('cirurgia') || n.includes('refrativa') || n.includes('catarata');
  if (n.includes('retorno')) return cirurgico ? 'retorno-cirurgia' : 'retorno';
  // Sem convênio declarado não se escolhe entre unimed e particular.
  if (!convenio) return undefined;
  if (cirurgico) return ehUnimed(convenio) ? 'unimed-cirurgia' : 'particular-cirurgia';
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
          logger.warn({ err: err.message }, 'vagas: script falhou ou estourou o tempo');
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
