import { describe, expect, it } from 'vitest';

import {
  type DmsObservadas,
  anotaDm,
  chatsAcompanhados,
  grupoDaDm,
  podaDms,
} from './dm-observada.js';

const JID = '558699572370@s.whatsapp.net';
const PASTA = 'whatsapp_atendimento-teste';

describe('anotaDm', () => {
  it('anota a DM nova com pasta e piso', () => {
    const d = anotaDm({}, JID, PASTA, '2026-10-22T10:00:00.000Z', 'agora');
    expect(d[JID]).toEqual({
      folder: PASTA,
      desde: '2026-10-22T10:00:00.000Z',
      vistaEm: 'agora',
    });
  });

  /**
   * ⛔ O caso que o `registraDmEmObservacao` acertava e que não pode regredir:
   * reescrever `desde` a cada mensagem devolveria o cursor para o presente, e o
   * host perderia tudo que chegou entre uma rodada e outra.
   */
  it('NÃO move o piso de quem já é conhecida', () => {
    const antes: DmsObservadas = {
      [JID]: { folder: PASTA, desde: 'PISO-ORIGINAL', vistaEm: 'ontem' },
    };
    const d = anotaDm(antes, JID, PASTA, 'PISO-NOVO', 'hoje');
    expect(d[JID].desde).toBe('PISO-ORIGINAL');
    expect(d[JID].vistaEm).toBe('hoje');
  });

  it('a pasta acompanha a configuração, o piso não', () => {
    const antes: DmsObservadas = {
      [JID]: { folder: 'pasta-velha', desde: 'PISO', vistaEm: 'ontem' },
    };
    const d = anotaDm(antes, JID, 'pasta-nova', 'OUTRO', 'hoje');
    expect(d[JID].folder).toBe('pasta-nova');
    expect(d[JID].desde).toBe('PISO');
  });

  it('não muta a entrada', () => {
    const antes: DmsObservadas = {};
    anotaDm(antes, JID, PASTA, 'x', 'y');
    expect(antes).toEqual({});
  });
});

describe('podaDms', () => {
  const agora = Date.parse('2026-10-22T12:00:00.000Z');
  const SETE_DIAS = 7 * 24 * 3600 * 1000;

  it('mantém quem deu sinal dentro da validade', () => {
    const d = podaDms(
      { [JID]: { folder: PASTA, desde: 'x', vistaEm: '2026-10-21T12:00:00Z' } },
      agora,
      SETE_DIAS,
    );
    expect(Object.keys(d)).toEqual([JID]);
  });

  it('tira quem sumiu', () => {
    const d = podaDms(
      { [JID]: { folder: PASTA, desde: 'x', vistaEm: '2026-10-01T12:00:00Z' } },
      agora,
      SETE_DIAS,
    );
    expect(d).toEqual({});
  });

  // ⚠️ Apagar devolveria a DM ao estado "desconhecida", e o cursor dela sumiria
  // junto — a rodada seguinte varreria o histórico inteiro do chat.
  it('data ilegível não é motivo para apagar', () => {
    const d = podaDms(
      { [JID]: { folder: PASTA, desde: 'x', vistaEm: 'lixo' } },
      agora,
      SETE_DIAS,
    );
    expect(Object.keys(d)).toEqual([JID]);
  });
});

describe('grupoDaDm', () => {
  const dm = { folder: PASTA, desde: 'PISO', vistaEm: 'hoje' };

  it('não exige gatilho: paciente não escreve "@Andy"', () => {
    expect(grupoDaDm(JID, dm, '@Andy').requiresTrigger).toBe(false);
  });

  // ⛔ `isMain` abre o Remote Control. DM de paciente nunca pode ser principal.
  it('NUNCA é o grupo principal', () => {
    expect(grupoDaDm(JID, dm, '@Andy').isMain).toBe(false);
  });

  it('carrega a pasta da DM, que é de onde vêm os textos aprovados', () => {
    expect(grupoDaDm(JID, dm, '@Andy').folder).toBe(PASTA);
  });
});

/**
 * ⛔ O coração da opção C: sem a DM nesta lista, `getNewMessages` não traz as
 * mensagens dela e o host simplesmente não acompanha paciente — que é o estado
 * de antes, quando a DM precisava virar grupo registrado para ser vista.
 */
describe('chatsAcompanhados', () => {
  const GRUPO = '120363275085162068@g.us';
  const dms: DmsObservadas = {
    [JID]: { folder: PASTA, desde: 'x', vistaEm: 'y' },
  };

  it('junta grupos e DMs', () => {
    expect(chatsAcompanhados({ [GRUPO]: {} }, dms).sort()).toEqual(
      [GRUPO, JID].sort(),
    );
  });

  it('a DM entra mesmo sem grupo nenhum registrado', () => {
    expect(chatsAcompanhados({}, dms)).toEqual([JID]);
  });

  // Processar o mesmo lote duas vezes produziria resposta duplicada.
  it('sem duplicata quando o JID está nos dois', () => {
    expect(chatsAcompanhados({ [JID]: {} }, dms)).toEqual([JID]);
  });

  it('sem DM, só os grupos', () => {
    expect(chatsAcompanhados({ [GRUPO]: {} }, {})).toEqual([GRUPO]);
  });
});
