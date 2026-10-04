/**
 * Telemetria do teste de tom: registra a intenção e a fonte que o próprio
 * agente declara para cada resposta.
 *
 * ## Por que o host faz isso, e não um script no container
 *
 * A primeira versão pedia ao agente uma linha no fim da mensagem:
 *
 *     [intenção: verificar vaga | fonte: base (F12)]
 *
 * Media bem, mas o paciente lia a linha, e num teste de tom o instrumento
 * estragava o que ele mede.
 *
 * A segunda versão virou um script (`marcar.py`) a ser chamado depois de
 * responder. Em 04/10/2026 o agente leu o FAQ, chamou o script e terminou o
 * turno com `result: null`, **sem responder nada ao paciente**. Uma chamada de
 * ferramenta obrigatória no fim do turno cria o caminho em que a chamada vira o
 * turno.
 *
 * Esta versão não pede nada novo do agente: ele anota dentro de um bloco
 * `<internal>`, que o host já removia da mensagem antes de enviar. A entrega
 * dele continua sendo uma só, o texto, então não existe caminho em que ele
 * cumpra a telemetria e esqueça o paciente.
 *
 * Formato esperado dentro do bloco (ordem livre, campos ausentes ficam vazios):
 *
 *     <internal>intencao=verificar vaga | fonte=base | bloco=F12 | script=iclinic_vagas.py</internal>
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const RX_INTERNAL = /<internal>([\s\S]*?)<\/internal>/g;
const CAMPOS = ['intencao', 'fonte', 'bloco', 'script', 'nota'] as const;

export interface AgentMarking {
  intencao: string;
  fonte: string;
  bloco: string;
  script: string;
  nota: string;
}

/** Extrai a marcação dos blocos <internal> de uma saída bruta do agente. */
export function parseMarking(raw: string): AgentMarking | undefined {
  let achou = false;
  const out: Record<string, string> = {};
  for (const [, corpo] of raw.matchAll(RX_INTERNAL)) {
    for (const campo of CAMPOS) {
      // Para no | ou no fim do bloco; tolera espaços e acento em "intenção".
      const m = corpo.match(
        new RegExp(
          `\\b${campo === 'intencao' ? 'inten[çc][ãa]o' : campo}\\s*=\\s*([^|\\n]+)`,
          'i',
        ),
      );
      if (m) {
        out[campo] = m[1].trim();
        achou = true;
      }
    }
  }
  if (!achou) return undefined;
  return {
    intencao: out.intencao ?? '',
    fonte: out.fonte ?? '',
    bloco: out.bloco ?? '',
    script: out.script ?? '',
    nota: out.nota ?? '',
  };
}

/**
 * Grava a marcação em `groups/<folder>/rodadas.jsonl`. Nunca lança: telemetria
 * de teste não pode derrubar um atendimento.
 */
export function recordAgentMarking(
  groupFolder: string,
  raw: string,
): AgentMarking | undefined {
  const marca = parseMarking(raw);
  if (!marca) return undefined;
  try {
    const dir = path.join(GROUPS_DIR, groupFolder);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'rodadas.jsonl'),
      JSON.stringify({ quando: new Date().toISOString(), ...marca }) + '\n',
    );
  } catch (err) {
    logger.warn({ err, groupFolder }, 'recordAgentMarking: não gravou');
  }
  return marca;
}
