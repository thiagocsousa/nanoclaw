import fs from 'fs';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ A frase de acolhimento de SINTOMA sai numa intenção só.
 *
 * Caso real da semana de observação, em 26/10/2026 (revisão 9KE3). A paciente
 * escreveu:
 *
 *   "Ela me falou que talvez a retroativa poderia voltar a ter grau, não
 *    zerar. No caso voltaria o grau todo? Que uso hoje?"
 *
 * e a Lara respondeu *"Entendo, isso deve estar incomodando bastante. Só um
 * instante."* — a frase de acolhimento de DOR para quem não relatou dor
 * nenhuma. O Thiago: *"errou a classificação, é uma dúvida, não uma dor"*.
 *
 * ⚠️ Escalar estava CERTO: "voltaria o grau todo?" é detalhe de prognóstico, e
 * a Marina liberou uma frase sobre óculos e nada além. O defeito era o texto.
 *
 * ## Por que o modelo errava, e por que instrução não resolvia
 *
 * O `CLAUDE.md` da pasta já gastava parágrafos dizendo "não rotule `clinico`
 * para X" — grau de passagem, escolha de lente, diagnóstico mencionado — sem
 * oferecer ONDE X cai. E o modelo evita `DESCONHECIDO` quando entendeu a
 * pergunta: está documentado no próprio arquivo, no caso de 05/10 em que ele
 * devolveu `DESCONHECIDO` com 0,95 anotando que tinha entendido tudo.
 *
 * Faltava o rótulo, não o aviso. `duvida_clinica` escala como `clinico` e sai
 * com o texto neutro, que já era aprovado (é o do `DESCONHECIDO`).
 *
 * ## O que este teste trava
 *
 * Que a frase de acolhimento não se espalhe. Ela presume um fato sobre o
 * paciente — que algo o incomoda —, e texto que presume fato só pode existir
 * no caminho em que o fato foi dito. Uma segunda intenção com essa frase é uma
 * segunda chance de mandá-la a quem não tem queixa.
 */
describe('a frase de acolhimento de sintoma', () => {
  const tabela = JSON.parse(
    fs.readFileSync(
      'groups/whatsapp_atendimento-teste/templates.json',
      'utf-8',
    ),
  ) as {
    intencoes: Record<
      string,
      { acao?: string; urgente?: boolean; textos?: string[] }
    >;
  };

  /** O trecho que presume incômodo. Sem o fecho, que é comum a toda escalada. */
  const ACOLHIMENTO = /isso deve estar incomodando/i;

  it('existe em `clinico` e em mais nenhuma', () => {
    const comAcolhimento = Object.entries(tabela.intencoes)
      .filter(([, i]) => (i.textos || []).some((t) => ACOLHIMENTO.test(t)))
      .map(([nome]) => nome);
    expect(comAcolhimento).toEqual(['clinico']);
  });

  it('`duvida_clinica` escala sem presumir dor, e sem ser urgente', () => {
    const d = tabela.intencoes.duvida_clinica;
    expect(d, 'duvida_clinica saiu da tabela').toBeTruthy();
    expect(d.acao).toBe('escalar');
    // Dor é urgente; dúvida não. Marcar urgente aqui faria a escada de cobrança
    // do SLA tratar pergunta de prognóstico como pós-operatório com dor.
    expect(d.urgente).toBe(false);
    expect(d.textos).toEqual(['Só um instante.']);
  });

  /**
   * ⚠️ O texto dela é o MESMO do `DESCONHECIDO`, de propósito: é frase já
   * aprovada pela clínica. Se alguém "melhorar" uma das duas, isto avisa — o
   * caminho de aprovação de texto para paciente é humano, e não passa por aqui.
   */
  it('o texto neutro é literalmente o que o `DESCONHECIDO` já usava', () => {
    expect(tabela.intencoes.duvida_clinica.textos).toEqual(
      tabela.intencoes.DESCONHECIDO.textos,
    );
  });
});
