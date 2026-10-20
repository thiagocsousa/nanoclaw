import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { montaArgs, rodaScript } from './script-container.js';
import { CREDENCIAIS, garanteCredenciais } from './vagas.js';

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
  const { nome, args } = montaArgs({
    rotulo: 'paciente',
    dir,
    script: 'iclinic_paciente_por_telefone.py',
    envKeys: CREDENCIAIS,
    argv: ['--telefone', telefone],
  });

  const t0 = Date.now();
  const { stdout: saida, erro } = await rodaScript({
    nome,
    args,
    timeoutMs: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
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
