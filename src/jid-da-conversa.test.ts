import { describe, expect, it } from 'vitest';

import { jidDaConversa } from './channels/whatsapp.js';

/**
 * ⛔ DM endereçada por LID tem de virar o JID de telefone.
 *
 * Em 07/11/2026 a DM no número principal passou a chegar assim:
 *
 *     {"remoteJid":"202842866507806@lid",
 *      "remoteJidAlt":"558999204306@s.whatsapp.net",
 *      "addressingMode":"lid"}
 *
 * O host casa pasta e conversa por `@s.whatsapp.net`. A mensagem chegava, não
 * batia com nada e sumia — sem erro e sem log. Foi assim que a DM da Dra.
 * Marina parou de ser ouvida, e com ela o pipeline de avaliação: a lista era
 * apresentada seis vezes por dia e a aprovação nunca voltava. Última avaliação
 * enviada a paciente: 02/10.
 *
 * ⚠️ O `senderJid` JÁ fazia esta resolução para o REMETENTE, com a mesma
 * precedência. Faltava para a CONVERSA — e é por isso que o grupo do
 * atendimento continuou funcionando (lá o `participantAlt` já era usado) e só
 * a DM quebrou. Meia correção aplicada a um problema de duas metades.
 *
 * ⛔ E o diagnóstico levou uma noite por um erro meu, não pelo bug: eu li o
 * `nanoclaw-out.log` e o instrumento escreve no `nanoclaw-error.log`, porque
 * usa `logger.warn` e o pino manda `warn` para stderr. Concluí "nada chega" de
 * três fontes que eram a mesma, e quase mandei repareamento de dois números.
 */
describe('jidDaConversa', () => {
  it('DM por LID vira o telefone do remoteJidAlt', () => {
    expect(
      jidDaConversa({
        remoteJid: '202842866507806@lid',
        remoteJidAlt: '558999204306@s.whatsapp.net',
      }),
    ).toBe('558999204306@s.whatsapp.net');
  });

  it('a DM da Marina resolve para a pasta dela', () => {
    expect(
      jidDaConversa({
        remoteJid: '130520398753941@lid',
        remoteJidAlt: '558699635479@s.whatsapp.net',
      }),
    ).toBe('558699635479@s.whatsapp.net');
  });

  /**
   * ⚠️ Grupo NÃO muda de caminho. O `remoteJid` é `@g.us` e o telefone do autor
   * vem em `participantAlt`, que o `senderJid` já trata. Devolver algo aqui
   * trocaria o id do grupo pelo telefone de quem escreveu — e aí cada
   * participante viraria uma "conversa" diferente.
   */
  it('grupo devolve vazio: o caminho dele já funcionava', () => {
    expect(jidDaConversa({ remoteJid: '120363287717747603@g.us' })).toBe('');
  });

  it('DM já endereçada por telefone devolve vazio', () => {
    expect(jidDaConversa({ remoteJid: '558699488647@s.whatsapp.net' })).toBe(
      '',
    );
  });

  /**
   * ⛔ O caso que a primeira versão deste teste NÃO cobria, e que a sabotagem
   * expôs: tirar a checagem de `@lid` não derrubava nada, porque nenhum caso
   * tinha `remoteJidAlt` ao lado de um `remoteJid` que não é LID.
   *
   * Esse stanza existe. Visto no log em 07/11:
   *
   *     {"remoteJid":"status@broadcast",
   *      "remoteJidAlt":"558698195438@s.whatsapp.net"}
   *
   * Sem a checagem, um STATUS viraria conversa com a pessoa — e o host
   * passaria a tratar publicação de status como DM de paciente.
   */
  it('status@broadcast com alt NÃO vira conversa com a pessoa', () => {
    expect(
      jidDaConversa({
        remoteJid: 'status@broadcast',
        remoteJidAlt: '558698195438@s.whatsapp.net',
      }),
    ).toBe('');
  });

  it('grupo com alt também não troca de identidade', () => {
    expect(
      jidDaConversa({
        remoteJid: '120363287717747603@g.us',
        remoteJidAlt: '558681512111@s.whatsapp.net',
      }),
    ).toBe('');
  });

  /**
   * O servidor não garante o alt. Sem ele não há telefone a usar, e inventar um
   * seria pior: o chamador cai no `translateJid`, que é o comportamento
   * anterior.
   */
  it('LID sem alt devolve vazio, em vez de chutar', () => {
    expect(jidDaConversa({ remoteJid: '202842866507806@lid' })).toBe('');
    expect(
      jidDaConversa({ remoteJid: '202842866507806@lid', remoteJidAlt: null }),
    ).toBe('');
  });
});
