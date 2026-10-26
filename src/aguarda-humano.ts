/**
 * Escalou e mandou texto? Então a conversa é de gente, e a Lara cala.
 *
 * ⛔ Nasceu de uma observação do Thiago em 26/10/2026: *"não é legal ficar
 * respondendo 'Só um instante.' várias vezes seguidas, respondeu uma vez,
 * significa que escalou e tem que esperar o humano responder"*.
 *
 * Estava repetindo. Medido na passada 4, caso O06:
 *
 *     paciente: operei ontem e ta doendo muito
 *     LARA:     Entendo, isso deve estar incomodando muito. Só um instante.
 *     paciente: [áudio 30s]
 *     LARA:     Só um instante.
 *
 * E nas M02/N05 da passada 3. A causa não era descuido: a trava de insistência
 * (`escalaSeInsistiu`) deixa `escalar` de fora de propósito, com o comentário
 * "marcar e escalar já têm desfecho". Têm — **para a recepção**. Nenhuma
 * escalada deixava estado dizendo que AQUELA CONVERSA está esperando gente, e
 * a mensagem seguinte rodava o classificador do zero.
 *
 * ## O sinal de que o humano respondeu
 *
 * O core já grava os dois lados das DMs do atendimento em
 * `atendimento_sla.jsonl` (`captureSlaTimeline`), com `direction: 'out'` para
 * o eco `fromMe` do device da recepção. Mas `out` **também** cobre o que a
 * própria Lara mandou — e tratar o próprio eco como "o humano respondeu" faria
 * ela destravar sozinha, que é exatamente o bug de volta.
 *
 * O discriminador já existe: `recordBotSentId` grava em
 * `atendimento_bot_sent.jsonl` o id de tudo que o host enviou. Um `out` cujo id
 * NÃO está lá é gente. É a mesma regra do `sla_monitor.py`, que já media isso
 * em Python desde 01/10 — aqui ela só passa a valer dentro do turno.
 *
 * ⚠️ **A pasta não é a do turno.** Os dois arquivos são gravados na pasta do
 * `groupFolderOwner` do canal de atendimento (`PASTA_DO_SLA`,
 * `whatsapp_atendimento-dra-marina`), e o turno da Lara roda na pasta de
 * observação (`whatsapp_atendimento-teste`). Ler a pasta do turno abriria um
 * arquivo que não existe e devolveria "ninguém respondeu" para sempre — ou
 * seja, Lara muda. O `index.ts:166` já avisa disso para o `semear-historico`,
 * e o erro aqui seria pior, porque silencioso nos dois sentidos.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, isBotText } from './config.js';
import { leEventosSla } from './semear-historico.js';

const ARQUIVO_SLA = 'atendimento_sla.jsonl';
const ARQUIVO_BOT = 'atendimento_bot_sent.jsonl';

/** Ids que o HOST enviou. Tudo que sair daqui e for `out` é gente. */
export function idsDoBot(arquivo: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(arquivo)) return ids;
  let bruto = '';
  try {
    bruto = fs.readFileSync(arquivo, 'utf-8');
  } catch {
    // Arquivo ilegível é indistinguível de arquivo vazio para esta pergunta, e
    // conjunto vazio é o lado SEGURO: todo `out` conta como humano, a Lara
    // volta a falar. O contrário — assumir que todo `out` é dela — a deixaria
    // muda por causa de um erro de leitura.
    return ids;
  }
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue;
    try {
      const e = JSON.parse(linha) as { id?: string };
      if (e.id) ids.add(e.id);
    } catch {
      // Linha truncada: o append não é atômico e a última pode estar partida.
      continue;
    }
  }
  return ids;
}

/**
 * Um humano respondeu nesta conversa depois de `desde` (epoch ms)?
 *
 * `pastaDoSla` é a pasta que GRAVA os jsonl, não a pasta do turno — ver o
 * aviso no cabeçalho.
 */
export function humanoRespondeuDepois(
  pastaDoSla: string,
  chatJid: string,
  desde: number,
): boolean {
  const dir = path.join(GROUPS_DIR, pastaDoSla);
  const doBot = idsDoBot(path.join(dir, ARQUIVO_BOT));
  for (const e of leEventosSla(path.join(dir, ARQUIVO_SLA), chatJid)) {
    // ⛔ `leEventosSla` é SUPERCONJUNTO, por desenho: ele casa a linha por
    // substring para não parsear 900 KB a cada pergunta, e o próprio docstring
    // dele diz que quem decide é o chamador. Sem esta linha, um `out` de OUTRA
    // conversa que citasse este jid no texto destrancaria o silêncio daqui.
    if (e.jid !== chatJid) continue;
    if (e.direction !== 'out') continue;
    if (e.id && doBot.has(e.id)) continue; // eco da própria Lara, por id
    // ⚠️ Segundo discriminador, e não redundância: `atendimento_bot_sent.jsonl`
    // só tem o que ESTE host enviou desde que `recordBotSentId` existe, e a
    // marca invisível viaja no texto. É a mesma dedução em que o
    // `mensagensDoHistorico` já confia para não atribuir fala do bot à
    // secretária. Dois sinais independentes para a mesma pergunta, porque errar
    // aqui faz a Lara voltar a falar sozinha — o bug que isto conserta.
    if (isBotText(e.text || '')) continue;
    const t = Date.parse(e.timestamp || '');
    // ⚠️ `>=` e não `>`: a marca da escalada e o eco do envio nascem no mesmo
    // milissegundo às vezes, e o eco do PRÓPRIO envio já foi descartado acima
    // pelo id. O que sobra com o mesmo timestamp é gente que respondeu junto.
    if (Number.isFinite(t) && t >= desde) return true;
  }
  return false;
}
