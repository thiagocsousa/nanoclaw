/**
 * As DMs de paciente que o host acompanha, SEM fingir que são grupos.
 *
 * ⛔ Substitui o `registraDmEmObservacao`, que registrava a DM em
 * `registered_groups` só para reusar o laço de grupos. Aquilo estava quebrado
 * desde que nasceu — passava `triggerPattern` onde o tipo pede `trigger` e não
 * passava `added_at`, os dois escondidos por um `as never` —, e funcionava por
 * acidente: `registerGroup` grava no mapa em MEMÓRIA antes de a escrita no
 * banco lançar. Turnos aconteciam, nada persistia, e o reinício esquecia tudo.
 *
 * ⚠️ E o conserto óbvio era pior que o defeito, por três motivos medidos (ver
 * `docs/DM-SEM-REGISTRO.md`): `folder` é UNIQUE e o insert é
 * `INSERT OR REPLACE`, então o registro da DM APAGARIA a linha do grupo de
 * atendimento; registrar desarma o gate de DM do `ipc.ts`
 * (`if (isRegisteredChat) return false`), que é o que impede o agente de falar
 * com paciente sem origem de script; e `pasta → grupo` deixaria de ser único em
 * sete lugares, podendo fazer uma tarefa agendada da clínica disparar na DM de
 * um paciente qualquer.
 *
 * A informação de que o registro precisava — "esta DM pertence a esta pasta" —
 * já existe explícita em `pastaDeObservacaoDeDm`. Este módulo só guarda a
 * associação e o cursor, e deixa `registered_groups` significar o que o nome
 * diz: chats que a clínica possui.
 */

/** Uma DM acompanhada: a pasta a que pertence e desde quando. */
export interface DmObservada {
  folder: string;
  /**
   * O piso do cursor, em ISO.
   *
   * ⛔ Começa 1ms ANTES da mensagem que descobriu a DM. Sem isso
   * `getOrRecoverCursor` devolve '' para chat desconhecido e a primeira rodada
   * varreria todo o histórico já gravado daquele chat — "só mensagens novas"
   * (Thiago, 19/10/2026).
   */
  desde: string;
  /** Última vez que a DM deu sinal. Serve só para a poda. */
  vistaEm: string;
}

export type DmsObservadas = Record<string, DmObservada>;

/**
 * Anota a DM, sem mexer no cursor de quem já é conhecida.
 *
 * ⚠️ Idempotente de propósito. Reescrever `desde` a cada mensagem devolveria o
 * cursor para o presente e o host perderia as mensagens que chegaram entre uma
 * rodada e outra. Quem já está anotada só tem o `vistaEm` atualizado.
 */
export function anotaDm(
  dms: DmsObservadas,
  chatJid: string,
  folder: string,
  desde: string,
  agora: string,
): DmsObservadas {
  const atual = dms[chatJid];
  if (atual) {
    // A pasta pode mudar se a configuração mudar; o cursor, não.
    return { ...dms, [chatJid]: { ...atual, folder, vistaEm: agora } };
  }
  return { ...dms, [chatJid]: { folder, desde, vistaEm: agora } };
}

/**
 * Tira do registro quem sumiu. Sem isto o estado cresce sem teto, uma entrada
 * por paciente que já escreveu uma vez.
 */
export function podaDms(
  dms: DmsObservadas,
  agoraMs: number,
  validadeMs: number,
): DmsObservadas {
  const vivas: DmsObservadas = {};
  for (const [jid, dm] of Object.entries(dms)) {
    const visto = Date.parse(dm.vistaEm);
    // Data ilegível não é motivo para apagar: o estado seguro é manter, porque
    // apagar devolve a DM ao estado "desconhecida" e o cursor dela some junto.
    if (!Number.isFinite(visto) || agoraMs - visto <= validadeMs) {
      vivas[jid] = dm;
    }
  }
  return vivas;
}

/**
 * Os chats que o laço principal acompanha: grupos ∪ DMs.
 *
 * ⚠️ É o coração da opção C, e por isso mora aqui, testável. Enquanto estava
 * inline no laço, sabotá-lo não derrubava teste nenhum — o que quer dizer que
 * "a DM entra no laço" não estava medido, e é justamente o que faz o host
 * acompanhar paciente sem registrar a DM como grupo.
 *
 * Sem duplicata: um JID que por algum motivo esteja nos dois lugares entra uma
 * vez só, senão o lote dele seria processado em dobro.
 */
export function chatsAcompanhados(
  grupos: Record<string, unknown>,
  dms: DmsObservadas,
): string[] {
  return [...new Set([...Object.keys(grupos), ...Object.keys(dms)])];
}

/**
 * O descritor que o laço de grupos espera, montado a partir da DM.
 *
 * ⚠️ `requiresTrigger: false` porque **paciente não escreve "@Andy"** — exigir
 * gatilho faria o host não acompanhar nada. `isMain: false` porque DM nenhuma
 * tem privilégio: o Remote Control checa `isMain` e tem de recusar.
 *
 * Não vai para `registered_groups`. É um objeto de passagem, montado a cada
 * leitura, justamente para não voltar a existir um registro que mente.
 */
export function grupoDaDm(
  chatJid: string,
  dm: DmObservada,
  trigger: string,
): {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean;
  isMain: boolean;
} {
  return {
    name: chatJid,
    folder: dm.folder,
    trigger,
    added_at: dm.desde,
    requiresTrigger: false,
    isMain: false,
  };
}
