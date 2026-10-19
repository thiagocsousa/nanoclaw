import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, GROUPS_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';
import { CREDENCIAIS, garanteCredenciais } from './vagas.js';
import {
  LIMITES_DE_RECURSO,
  colheContainer,
  nomeiaContainer,
} from './script-container.js';

/** Um cadastro do iClinic que tem este telefone. */
export interface Candidato {
  id: number;
  nome: string;
  nascimento: string;
  telefone: string;
  /** Convênio do cadastro, tipo "UNIMED TERESINA". Vazio quando não há. */
  convenio: string;
  /** Cidade da ficha. **Costuma vir vazia** — ver o script. */
  cidade: string;
  /**
   * Data da última consulta, em `AAAA-MM-DD`. Vem vazia quando nunca houve.
   *
   * O script sempre devolveu; o tipo não declarava, e a memória descartava.
   * Passou a importar em 19/10/2026: quem pede retorno já é paciente da casa, e
   * mandar essa data no escalonamento poupa a recepção de abrir o iClinic.
   */
  ultima_consulta: string;
}

/** Login + busca custam ~10 s. É por conversa, nunca por turno. */
const TIMEOUT_MS = 90_000;

/**
 * Quem tem este telefone no cadastro do iClinic.
 *
 * Existe para a triagem trocar quatro perguntas por uma. **Nunca decide quem é
 * a pessoa**: devolve os candidatos e quem confirma é o paciente, na conversa.
 * Medido em 07/10/2026 que um telefone devolve DOIS cadastros (pai e filha) —
 * telefone identifica uma casa. Escolher sozinho poria o nascimento de outra
 * pessoa na conferência de identidade da marcação.
 *
 * Mesmo arranjo do `buscaVagas`: Playwright não existe no host e existe na
 * imagem do agente, e as credenciais vão por `-e NOME`, herdando o valor, nunca
 * `-e NOME=valor`, que deixaria a senha visível em `ps`.
 */
export async function pacientesComTelefone(
  groupFolder: string,
  telefone: string,
): Promise<Candidato[]> {
  const dir = path.join(GROUPS_DIR, groupFolder);
  const script = path.join(dir, 'scripts', 'iclinic_paciente_por_telefone.py');
  if (!fs.existsSync(script)) return [];

  garanteCredenciais();
  const nome = nomeiaContainer('paciente');
  const args = [
    'run',
    '--rm',
    '--name',
    nome,
    ...LIMITES_DE_RECURSO,
    '--network',
    'bridge',
  ];
  for (const k of CREDENCIAIS) {
    if (process.env[k]) args.push('-e', k);
  }
  args.push(
    '-v',
    `${dir}:/workspace/group:ro`,
    '--entrypoint',
    'python3',
    CONTAINER_IMAGE,
    '/workspace/group/scripts/iclinic_paciente_por_telefone.py',
    '--telefone',
    telefone,
  );

  const t0 = Date.now();
  // ⚠️ `err` e `stderr` vão para o log, não para o lixo.
  //
  // A versão anterior era `(err, stdout) => resolve(err ? undefined : stdout)`,
  // e o warning saía com a pasta e mais nada. Em 19/10/2026 a busca falhou em
  // A07 e E08 na mesma passada e passou em E05, e o log não dizia se tinha sido
  // timeout, login do iClinic ou falta de credencial — as três exigem conserto
  // diferente. `signal` separa timeout de erro do provedor, e `stderr` é a
  // única cópia do que o iClinic respondeu.
  const { saida, erro } = await new Promise<{
    saida?: string;
    erro?: string;
  }>((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ saida: stdout });
        // O timeout do `execFile` mata o cliente, não o container.
        colheContainer(nome);
        const sinal = (err as { signal?: string | null }).signal;
        resolve({
          erro: [
            err.message,
            sinal ? `signal=${sinal}` : '',
            (stderr || '').trim().slice(-800),
          ]
            .filter(Boolean)
            .join(' · '),
        });
      },
    );
  });
  if (!saida) {
    // Falha de busca NÃO é "não é paciente": é não saber. Quem chama cai na
    // triagem normal, que é o comportamento de sempre.
    logger.warn(
      { groupFolder, ms: Date.now() - t0, err: erro },
      'paciente: busca por telefone falhou',
    );
    return [];
  }

  const linha = saida
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  let obj: { ok?: boolean; candidatos?: unknown } = {};
  try {
    obj = JSON.parse(linha ?? '{}') as typeof obj;
  } catch {
    return [];
  }
  if (!obj.ok || !Array.isArray(obj.candidatos)) return [];

  const candidatos = (obj.candidatos as Candidato[])
    .filter(
      (c) => typeof c?.id === 'number' && typeof c?.nome === 'string' && c.nome,
    )
    .map((c) => ({ ...c, convenio: c.convenio ?? '', cidade: c.cidade ?? '' }));
  logger.info(
    { groupFolder, achados: candidatos.length, ms: Date.now() - t0 },
    'paciente: busca por telefone',
  );
  return candidatos;
}

/** Primeiro nome, capitalizado. O cadastro vem em CAIXA ALTA. */
export function primeiroNome(nome: string): string {
  const p = (nome || '').trim().split(/\s+/)[0] ?? '';
  if (!p) return '';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}
