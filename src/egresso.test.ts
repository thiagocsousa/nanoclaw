import { describe, expect, it } from 'vitest';

import { podeEntregar } from './revisao-humana.js';

/**
 * O contrato do ponto único de egresso, visto do lado da POLÍTICA.
 *
 * ⛔ Nasceu do incidente de 20/10/2026: com a observação ligada, 13 mensagens
 * "Só um instante." chegaram a 5 pacientes reais a partir do número principal.
 * A política estava num PONTO do fluxo e os egressos estavam espalhados antes e
 * depois dele.
 *
 * ⚠️ O que derrubou o primeiro desenho: `sendImage`, `sendDocument` e o flush
 * da fila de reconexão chamavam `sock.sendMessage` DIRETO, sem passar pelo
 * `sendMessage` do canal. Travar só o `sendMessage` deixaria imagem, PDF e
 * texto atrasado abertos. Por isso a política é consultada por TIPO, e o canal
 * pergunta nos cinco egressos.
 *
 * Este arquivo testa a política pura. O canal perguntar é verificado por
 * inspeção do `podeSair` em `channels/whatsapp.ts`, que é o único lugar que
 * toca o socket — não há como um egresso novo nascer sem passar por lá sem que
 * alguém escreva `sock.sendMessage` de novo à mão.
 */
describe('política de egresso: a matriz que importa', () => {
  const DM = '558699999999@s.whatsapp.net';
  const GRUPO = '120363000@g.us';
  const PASTA = 'whatsapp_atendimento-teste';

  // Sem OBSERVACAO_FOLDERS no ambiente, `emObservacao` é falso para tudo e a
  // política libera — é o estado normal da clínica, e o controle negativo mais
  // importante do arquivo: a trava não pode derrubar o funcionamento de sempre.
  it('com observação DESLIGADA, todo tipo e toda origem passam', () => {
    for (const origem of [undefined, 'turno', 'script', 'revisao', 'alerta']) {
      expect(
        podeEntregar({
          alvo: DM,
          origem: origem as never,
          folderDoAlvo: PASTA,
        }),
      ).toBe(true);
    }
  });

  it('grupo passa sempre, qualquer origem', () => {
    // A revisão POSTA no grupo, e o alerta de SLA também. Se a política
    // barrasse grupo, a observação ficaria cega em vez de silenciosa.
    for (const origem of [undefined, 'turno', 'script', 'revisao', 'alerta']) {
      expect(podeEntregar({ alvo: GRUPO, origem: origem as never })).toBe(true);
    }
  });
});
