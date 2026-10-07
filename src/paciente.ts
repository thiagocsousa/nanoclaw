import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, GROUPS_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';
import { CREDENCIAIS, garanteCredenciais } from './vagas.js';

/** Um cadastro do iClinic que tem este telefone. */
export interface Candidato {
  id: number;
  nome: string;
  nascimento: string;
  telefone: string;
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
  const script = path.join(
    dir,
    'scripts',
    'iclinic_paciente_por_telefone.py',
  );
  if (!fs.existsSync(script)) return [];

  garanteCredenciais();
  const args = ['run', '--rm', '--network', 'bridge'];
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
  const saida = await new Promise<string | undefined>((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
  if (!saida) {
    // Falha de busca NÃO é "não é paciente": é não saber. Quem chama cai na
    // triagem normal, que é o comportamento de sempre.
    logger.warn({ groupFolder }, 'paciente: busca por telefone falhou');
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

  const candidatos = (obj.candidatos as Candidato[]).filter(
    (c) => typeof c?.id === 'number' && typeof c?.nome === 'string' && c.nome,
  );
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
