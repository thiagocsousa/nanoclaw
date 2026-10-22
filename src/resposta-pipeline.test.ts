import { describe, expect, it } from 'vitest';

import { DM_ALLOWED_ORIGINS } from './ipc.js';
import {
  CONFIRMACOES,
  JANELA_DO_PIPELINE,
  VALIDADE_DO_PIPELINE,
  ehConfirmacaoCurta,
  normalizaConfirmacao,
  podaPipelines,
  respostaDePipeline,
  soEcoDePipeline,
} from './resposta-pipeline.js';

const AGORA = 1_700_000_000_000;
const MIN = 60_000;
const H = 3600_000;

describe('ehConfirmacaoCurta', () => {
  it.each(['SIM', 'sim!', 'Confirmado', 'ok', 'Obrigada!', 'tá bom', 'recebi'])(
    'reconhece %s',
    (t) => {
      expect(ehConfirmacaoCurta(t)).toBe(true);
    },
  );

  /**
   * ⛔ O caso que define o recorte. Quem responde ao lembrete e PEDE algo tem de
   * ser atendido — é a conversa que a recepção mais quer ver.
   */
  it.each([
    'sim, mas posso remarcar?',
    'posso remarcar?',
    'não vou poder ir',
    'sim. e o valor do exame?',
    'ok, mas preciso mudar o horário',
  ])('NÃO suprime "%s"', (t) => {
    expect(ehConfirmacaoCurta(t)).toBe(false);
  });

  it('frase longa não é confirmação, mesmo começando com sim', () => {
    expect(ehConfirmacaoCurta('sim senhora muito obrigada mesmo')).toBe(false);
  });

  it('vazio não é confirmação', () => {
    expect(ehConfirmacaoCurta('   ')).toBe(false);
  });
});

describe('respostaDePipeline', () => {
  const lembrete = { origin: 'send_reminder', quando: AGORA - 2 * H };

  it('suprime o SIM que responde ao lembrete', () => {
    expect(respostaDePipeline('SIM', lembrete, AGORA)).toBe(true);
  });

  // ⚠️ Os três controles negativos, um por condição.
  it('NÃO suprime sem pipeline na conversa', () => {
    expect(respostaDePipeline('SIM', undefined, AGORA)).toBe(false);
  });

  it('NÃO suprime fora da janela', () => {
    expect(
      respostaDePipeline(
        'SIM',
        { origin: 'send_reminder', quando: AGORA - 40 * H },
        AGORA,
      ),
    ).toBe(false);
  });

  it('NÃO suprime quando a resposta traz pedido', () => {
    expect(respostaDePipeline('sim, posso remarcar?', lembrete, AGORA)).toBe(
      false,
    );
  });

  it('origem desconhecida não suprime nada', () => {
    expect(
      respostaDePipeline('SIM', { origin: 'inventada', quando: AGORA }, AGORA),
    ).toBe(false);
  });

  /**
   * ⛔ A exceção do lembrete de 1 ano: quem responde QUER MARCAR, e suprimir
   * seria perder a conversão que o pipeline existe para gerar. A janela dele é
   * curta, então só o "ok" imediato é suprimido.
   */
  describe('lembrete de 1 ano', () => {
    it('suprime o "obrigado" imediato', () => {
      expect(
        respostaDePipeline(
          'obrigado',
          { origin: 'send_retorno', quando: AGORA - 5 * MIN },
          AGORA,
        ),
      ).toBe(true);
    });

    it('NÃO suprime uma hora depois: aí é conversa', () => {
      expect(
        respostaDePipeline(
          'ok',
          { origin: 'send_retorno', quando: AGORA - 60 * MIN },
          AGORA,
        ),
      ).toBe(false);
    });

    it('NUNCA suprime interesse em marcar', () => {
      expect(
        respostaDePipeline(
          'quero marcar sim',
          { origin: 'send_retorno', quando: AGORA - MIN },
          AGORA,
        ),
      ).toBe(false);
    });

    it('a janela é bem menor que a do lembrete de consulta', () => {
      expect(JANELA_DO_PIPELINE.send_retorno).toBeLessThan(
        JANELA_DO_PIPELINE.send_reminder,
      );
    });
  });
});

describe('soEcoDePipeline', () => {
  const lembrete = { origin: 'send_reminder', quando: AGORA - 2 * H };
  const sim = { content: 'SIM', is_from_me: false };
  const daClinica = {
    content: 'Olá! Passando para lembrar…',
    is_from_me: true,
  };

  it('lote só com a confirmação é eco: não abre turno', () => {
    expect(soEcoDePipeline([sim], lembrete, AGORA)).toBe(true);
  });

  it('confirmação junto da fala da clínica também é eco', () => {
    expect(soEcoDePipeline([daClinica, sim], lembrete, AGORA)).toBe(true);
  });

  /**
   * ⛔ A trava que eu sabotei e nenhum teste pegou. Sem exigir ao menos uma
   * mensagem RECEBIDA, um lote só de `is_from_me` — o Thiago escrevendo no
   * grupo principal — satisfaz o `every` por vacuidade e é suprimido. O grupo
   * principal pararia de funcionar.
   */
  it('lote só da clínica NÃO é eco de pipeline', () => {
    expect(soEcoDePipeline([daClinica, daClinica], lembrete, AGORA)).toBe(
      false,
    );
  });

  it('lote vazio não é eco', () => {
    expect(soEcoDePipeline([], lembrete, AGORA)).toBe(false);
  });

  // Veio pedido junto: o turno acontece, e o "SIM" entra como contexto.
  it('lote misto NÃO é eco', () => {
    expect(
      soEcoDePipeline(
        [sim, { content: 'posso remarcar?', is_from_me: false }],
        lembrete,
        AGORA,
      ),
    ).toBe(false);
  });

  it('sem pipeline na conversa, nada é eco', () => {
    expect(soEcoDePipeline([sim], undefined, AGORA)).toBe(false);
  });
});

/**
 * ⚠️ Travas ESTRUTURAIS. As duas falhas que elas pegam são silenciosas: nada
 * quebra, a supressão só deixa de acontecer (ou passa a acontecer) e ninguém
 * descobre até alguém estranhar a fila.
 */
describe('travas estruturais', () => {
  /**
   * ⛔ Toda entrada da lista tem de SOBREVIVER à normalização, e a asserção é
   * contra a normalização, não contra `ehConfirmacaoCurta`: `'sim?'` passaria
   * pela segunda (normaliza para `'sim'`, que está na lista) sendo uma entrada
   * morta. O normalizador não tira acento, então `'tá bom'` precisa estar
   * escrito com acento — a entrada que a normalização alteraria nunca casaria
   * com nada, em silêncio.
   */
  it.each([...CONFIRMACOES])('a entrada %s é igual à sua normalização', (c) => {
    expect(normalizaConfirmacao(c)).toBe(c);
  });

  /**
   * ⛔ Pipeline AUTORIZADO a falar com paciente e SEM janela é a falha calada:
   * `respostaDePipeline` devolve `false` para origem desconhecida, e o ruído de
   * 24/55 volta sem nenhum log dizendo por quê. O contrário (janela sem
   * autorização) é inofensivo, então a asserção é de subconjunto.
   */
  it('todo pipeline que pode falar com paciente tem janela', () => {
    const semJanela = [...DM_ALLOWED_ORIGINS].filter(
      (o) => JANELA_DO_PIPELINE[o] === undefined,
    );
    expect(semJanela).toEqual([]);
  });
});

describe('podaPipelines', () => {
  it('mantém o que ainda decide algo e descarta o resto', () => {
    const agora = AGORA;
    const mapa = {
      vivo: { origin: 'send_reminder', quando: agora - 10 * H },
      morto: {
        origin: 'send_reminder',
        quando: agora - VALIDADE_DO_PIPELINE - 1,
      },
    };
    expect(Object.keys(podaPipelines(mapa, agora))).toEqual(['vivo']);
  });

  // A validade é DERIVADA da tabela: um pipeline novo com janela maior não
  // pode ser podado antes da hora.
  it('a validade é a maior janela da tabela', () => {
    expect(VALIDADE_DO_PIPELINE).toBe(
      Math.max(...Object.values(JANELA_DO_PIPELINE)),
    );
  });
});
