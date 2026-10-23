import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { podeEntregar, soFalaDaClinica } from './revisao-humana.js';

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

/**
 * ⛔ A trava que separa "não responda a isto" de "não leia isto".
 *
 * Nasceu em 22/10/2026, do primeiro dia de observação: a fala da secretária era
 * DESCARTADA pelo canal, e a Lara lia metade do diálogo — a paciente respondia
 * "Particular" e "Como faço?" a alguém que a Lara não via, e a resposta saía
 * fora de contexto. Agora a fala dela é gravada; esta função é o que impede que
 * ela vire turno e a Lara responda à própria clínica.
 */
describe('soFalaDaClinica: contexto sem gatilho', () => {
  const daClinica = { is_from_me: true };
  const doPaciente = { is_from_me: false };

  it('lote só da clínica NÃO é turno', () => {
    expect(soFalaDaClinica([daClinica, daClinica])).toBe(true);
  });

  it('lote só do paciente é turno', () => {
    expect(soFalaDaClinica([doPaciente])).toBe(false);
  });

  // ⚠️ O caso que `some` erraria: a secretária responde e o paciente escreve
  // logo depois, e os dois caem no mesmo lote. Tem de virar turno, com a fala
  // dela como contexto — senão a mensagem do paciente fica sem resposta.
  it('lote MISTO é turno', () => {
    expect(soFalaDaClinica([daClinica, doPaciente])).toBe(false);
    expect(soFalaDaClinica([doPaciente, daClinica])).toBe(false);
  });

  it('lote vazio não é "da clínica": quem chama não deve pular', () => {
    expect(soFalaDaClinica([])).toBe(false);
  });

  // Campo ausente é o caso das linhas gravadas antes de 22/10/2026.
  it('sem o campo, trata como paciente', () => {
    expect(soFalaDaClinica([{}])).toBe(false);
  });
});

/**
 * ⛔ Trava ESTRUTURAL contra o preview de link voltar sem ninguém decidir.
 *
 * O baileys tenta gerar preview para todo texto com URL, e `link-preview-js` é
 * peer dependency OPCIONAL que não está instalada: cada tentativa despejava um
 * `ERR_MODULE_NOT_FOUND` com stack trace no log. O conserto foi DESLIGAR a
 * geração (`linkPreview: null` no conteúdo), e não instalar a dependência —
 * instalar faria os cards aparecerem, e isso muda o que o paciente vê em
 * template que a Marina aprovou (seis endereços em Google Maps, mais o pedido
 * de avaliação).
 *
 * Um `sock.sendMessage(jid, { text })` escrito à mão reabre as duas coisas de
 * uma vez: o lixo no log hoje, e o card sem aprovação no dia em que alguém
 * instalar a dependência por outro motivo. Daí a trava ser no texto do arquivo.
 */
describe('nenhum egresso de texto monta o conteúdo à mão', () => {
  const fonte = fs.readFileSync(
    path.join(process.cwd(), 'src/channels/whatsapp.ts'),
    'utf-8',
  );

  it('todo texto passa por `textoParaOSocket`', () => {
    // `{ text:` como conteúdo de envio — o que havia antes do conserto.
    const aMao = fonte.match(/sendMessage\([^)]*\{\s*text:/g) ?? [];
    expect(aMao).toEqual([]);
  });

  it('e o helper desliga a geração de preview', () => {
    expect(fonte).toContain('linkPreview: null');
  });
});
