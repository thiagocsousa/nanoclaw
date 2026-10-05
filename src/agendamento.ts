/**
 * Agendamento no iClinic, com confirmação humana.
 *
 * ## A decisão que desenha este módulo
 *
 * Thiago em 04/10/2026, perguntado quem efetiva quando o paciente escolhe um
 * horário: **humano confirma**. A Lara prepara o pedido, alguém da clínica
 * aprova, e só então o host escreve.
 *
 * Isso não é timidez: é o que tira a verificação de identidade do caminho
 * crítico. Quem aprova já sabe quem é o paciente, então o erro que mais
 * assusta — mexer na consulta de outra pessoa (regra dura 3b) — não tem como
 * chegar à agenda sem passar por um olho humano.
 *
 * ## Por que não reusei `escalonamentos_pendentes.json`
 *
 * Um escalonamento é "alguém precisa olhar isso"; um pedido de agendamento é
 * "escreva isto no iClinic se eu aprovar". O segundo carrega dados que o
 * primeiro não tem (horário exato, tipo, paciente) e tem um desfecho que o
 * primeiro não tem (efetivado). Misturar os dois faria a baixa de um poder
 * disparar a escrita do outro, e é exatamente o tipo de confusão que num
 * sistema de agenda custa o horário de um paciente.
 *
 * ## Falha fecha
 *
 * Pedido sem horário, sem paciente ou com código repetido não é criado.
 * Aprovação de código inexistente não escreve nada. E a escrita em si ainda
 * não existe: `efetiva()` lança até o endpoint do iClinic ser descoberto com o
 * Thiago presente, num horário descartável. Melhor lançar que adivinhar o
 * formato de uma requisição que mexe em agenda médica.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const ARQUIVO = 'agendamentos_pendentes.json';

/** Mesmo alfabeto do escalonamento: sem 0/O, 1/I/L, 5/S, 2/Z. */
const ALFABETO = 'ABCDEFGHJKMNPQRTUVWXY34679';

export type Operacao = 'marcar' | 'remarcar' | 'cancelar';

export interface PedidoDeAgendamento {
  codigo: string;
  operacao: Operacao;
  /** epoch ms de quando o paciente pediu. */
  quando: number;
  /** Nome como o paciente informou. Quem aprova confere. */
  paciente: string;
  /** JID de quem pediu, para a clínica saber com quem falar. */
  pedidoPor: string;
  nascimento?: string;
  convenio?: string;
  /** ISO, "2026-10-06". */
  data: string;
  /** "09:20". */
  hora: string;
  /** Perfil da agenda, que define duração e tipo. */
  perfil: string;
  /** Em remarcar/cancelar, o evento que será tocado. */
  eventoAlvo?: string;
  /** Preenchido quando a escrita acontece. */
  efetivadoEm?: number;
}

function arquivo(folder: string): string {
  return path.join(GROUPS_DIR, folder, ARQUIVO);
}

export function lePedidos(folder: string): PedidoDeAgendamento[] {
  try {
    const d = JSON.parse(fs.readFileSync(arquivo(folder), 'utf-8'));
    return Array.isArray(d) ? (d as PedidoDeAgendamento[]) : [];
  } catch {
    return [];
  }
}

function grava(folder: string, itens: PedidoDeAgendamento[]): void {
  const alvo = arquivo(folder);
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  const tmp = `${alvo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(itens, null, 2));
  fs.renameSync(tmp, alvo);
}

function geraCodigo(usados: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) {
      c += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
    }
    if (!usados.has(c)) return c;
  }
  return `Z${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

export type DadosDoPedido = Omit<
  PedidoDeAgendamento,
  'codigo' | 'quando' | 'efetivadoEm'
>;

/**
 * Cria o pedido e devolve o código. undefined quando falta dado essencial:
 * sem paciente ou sem horário não há o que aprovar, e um pedido pela metade na
 * fila é pior que nenhum, porque alguém vai aprová-lo.
 */
export function criaPedido(
  folder: string,
  dados: DadosDoPedido,
): PedidoDeAgendamento | undefined {
  const falta = (['paciente', 'data', 'hora', 'perfil'] as const).filter(
    (k) => !String(dados[k] ?? '').trim(),
  );
  if (falta.length > 0) {
    logger.warn({ folder, falta }, 'agendamento: pedido incompleto, não criei');
    return undefined;
  }
  if (dados.operacao !== 'marcar' && !dados.eventoAlvo) {
    // Remarcar ou cancelar sem saber QUAL consulta é um pedido que, aprovado,
    // não se sabe executar.
    logger.warn(
      { folder, operacao: dados.operacao },
      'agendamento: remarcar/cancelar exige eventoAlvo',
    );
    return undefined;
  }

  const itens = lePedidos(folder);
  const pedido: PedidoDeAgendamento = {
    ...dados,
    codigo: geraCodigo(new Set(itens.map((p) => p.codigo))),
    quando: Date.now(),
  };
  itens.push(pedido);
  grava(folder, itens);
  logger.info(
    { folder, codigo: pedido.codigo, operacao: pedido.operacao },
    'agendamento: pedido criado, aguardando confirmação humana',
  );
  return pedido;
}

/**
 * Lê um comando de confirmação. Verbo PRÓPRIO, separado do "ok" da baixa de
 * escalonamento de propósito: "ok" significa "já cuidei disso" e não pode, por
 * acidente, escrever na agenda.
 */
export function comandoDeConfirmacao(texto: string): string | undefined {
  const m = texto
    .trim()
    .match(/^(?:confirmar|confirma|efetivar|marcar)\s+([A-Za-z0-9]{4})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

/** Lê um comando de recusa: o pedido sai da fila sem nada ser escrito. */
export function comandoDeRecusa(texto: string): string | undefined {
  const m = texto
    .trim()
    .match(/^(?:recusar|recusa|descartar|nao|não)\s+([A-Za-z0-9]{4})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

export function achaPedido(
  folder: string,
  codigo: string,
): PedidoDeAgendamento | undefined {
  return lePedidos(folder).find((p) => p.codigo === codigo && !p.efetivadoEm);
}

/** Remove o pedido da fila. Usado na recusa e depois de efetivar. */
export function removePedido(folder: string, codigo: string): boolean {
  const itens = lePedidos(folder);
  const i = itens.findIndex((p) => p.codigo === codigo);
  if (i === -1) return false;
  itens.splice(i, 1);
  grava(folder, itens);
  return true;
}

/** Texto do pedido para quem vai aprovar. Tudo que ele precisa conferir. */
export function avisoDoPedido(p: PedidoDeAgendamento): string {
  const verbo = { marcar: 'MARCAR', remarcar: 'REMARCAR', cancelar: 'CANCELAR' }[
    p.operacao
  ];
  const [a, m, d] = p.data.split('-');
  const linhas = [
    `📅 *${verbo}* \`${p.codigo}\``,
    '',
    `*Paciente:* ${p.paciente}`,
    p.nascimento ? `*Nascimento:* ${p.nascimento}` : '',
    p.convenio ? `*Convênio:* ${p.convenio}` : '',
    `*Quando:* ${d}/${m}/${a} às ${p.hora}`,
    `*Tipo:* ${p.perfil}`,
    p.eventoAlvo ? `*Consulta alvo:* ${p.eventoAlvo}` : '',
    '',
    `Responda *confirmar ${p.codigo}* para efetivar no iClinic, ou`,
    `*recusar ${p.codigo}* para descartar. Nada é escrito até você confirmar.`,
  ];
  return linhas.filter((l) => l !== '').join('\n');
}

/**
 * Escreve no iClinic. **Ainda não implementado, de propósito.**
 *
 * O endpoint de escrita não foi descoberto: a leitura usa
 * `GET /agenda/{medico}/{data}/?clinic={id}`, e o de criação precisa ser
 * capturado observando a rede durante um agendamento real. Não há iClinic de
 * homologação, então isso se faz com o Thiago presente, num horário que ele
 * designe como descartável, e apagando em seguida.
 *
 * Lançar aqui é a escolha certa: adivinhar o formato de uma requisição que
 * mexe em agenda médica pode criar um evento errado que ninguém sabe desfazer.
 */
export async function efetiva(p: PedidoDeAgendamento): Promise<never> {
  throw new Error(
    `endpoint de escrita do iClinic não descoberto; pedido ${p.codigo} não foi efetivado`,
  );
}
