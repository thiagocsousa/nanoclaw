import fs from 'fs';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ Nenhum texto aprovado AFIRMA o que o paciente está sentindo.
 *
 * ## Como esta guarda chegou aqui, em três passos
 *
 * **26/10/2026** — revisão 9KE3. A paciente perguntou se o grau poderia voltar
 * depois da refrativa e recebeu *"Entendo, isso deve estar incomodando
 * bastante. Só um instante."*. Criei `duvida_clinica` para a dúvida de
 * prognóstico não cair em `clinico`, e esta guarda nasceu travando que a frase
 * de acolhimento existisse em `clinico` e em mais nenhuma intenção.
 *
 * **28/10/2026** — revisão UHCB: *"Os colírios eu inicio com quanto tempo pós
 * cirurgia?"*, mesma frase de novo. O `duvida_clinica` não pegou porque eu o
 * havia escrito em torno de prognóstico — o caso que eu tinha na mão. Conserto
 * feito sobre um exemplo cobre o exemplo. O eixo do `clinico` virou QUEIXA
 * versus PERGUNTA, em vez de uma lista de assuntos.
 *
 * **Ainda em 28/10** — decisão do Thiago: *"deixa isso mais genérico, pra não
 * acolher dor quando não é"*. O texto do `clinico` passou a ser
 * *"Entendo. Só um instante."*, que é subconjunto literal do que a Marina já
 * tinha aprovado.
 *
 * ## Por que a asserção mudou de forma
 *
 * As duas primeiras versões travavam ONDE a frase podia estar. Agora ela não
 * está em lugar nenhum, e travar presença viraria uma guarda que exige o
 * defeito. O que importa não era aquela frase: era a CLASSE dela.
 *
 * Afirmar um sentimento é diferente de acolher. "Entendo" acolhe sem afirmar
 * nada; "isso deve estar incomodando bastante" afirma um fato sobre o corpo de
 * alguém a partir de uma mensagem que pode ser uma pergunta de horário. E a
 * fronteira entre queixa e pergunta nunca vai ser perfeita — o desempate que
 * escrevi manda preferir `clinico` na dúvida, porque só ele dispara alarme
 * sonoro. Ou seja: o caminho clínico VAI receber pergunta sem queixa, por
 * desenho. O texto é que não pode presumir.
 *
 * ⚠️ Varri os 74 textos antes de escrever os padrões, e nenhum casava. Guarda
 * que nasce vermelha é guarda que alguém desliga no mesmo dia.
 */
describe('nenhum texto afirma o que o paciente sente', () => {
  const tabela = JSON.parse(
    fs.readFileSync(
      'groups/whatsapp_atendimento-teste/templates.json',
      'utf-8',
    ),
  ) as {
    intencoes: Record<
      string,
      {
        acao?: string;
        urgente?: boolean;
        textos?: string[];
        texto_sem_slots?: string;
      }
    >;
  };

  /**
   * Afirmações sobre o estado do paciente. Estreito de propósito: cada padrão
   * é uma forma concreta de dizer "eu sei o que você está sentindo", não uma
   * heurística de empatia. "Entendo", "claro" e "perfeito" passam, e devem.
   */
  const PRESUNCOES: Array<[string, RegExp]> = [
    ['deve estar <sentindo>', /deve estar\s+\w+ndo/i],
    ['deve ser <difícil>', /deve ser (difícil|ruim|chato|angustiante)/i],
    ['imagino', /\bimagino\b/i],
    ['sei como é', /\bsei como\b/i],
    ['entendo sua dor', /entendo (a )?sua (dor|afli|preocupa|ang)/i],
    ['sinto muito', /\bsinto muito\b/i],
  ];

  function todosOsTextos(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [nome, i] of Object.entries(tabela.intencoes)) {
      for (const t of i.textos || []) out.push([nome, t]);
      if (i.texto_sem_slots) out.push([nome, i.texto_sem_slots]);
    }
    return out;
  }

  it('nenhuma intenção afirma o sentimento de quem escreveu', () => {
    const achados: string[] = [];
    for (const [nome, texto] of todosOsTextos()) {
      for (const [rotulo, rx] of PRESUNCOES) {
        if (rx.test(texto)) achados.push(`${nome} [${rotulo}]: ${texto}`);
      }
    }
    expect(achados).toEqual([]);
  });

  /** O detector funciona: a frase que motivou tudo isto seria pega. */
  it('pega a frase original, que é o caso que criou a regra', () => {
    const antiga =
      'Entendo, isso deve estar incomodando bastante. Só um instante.';
    expect(PRESUNCOES.some(([, rx]) => rx.test(antiga))).toBe(true);
  });

  it('e deixa passar o acolhimento que NÃO afirma nada', () => {
    for (const ok of [
      'Entendo. Só um instante.',
      'Claro, vou ver isso para você.',
      'Perfeito.',
    ]) {
      expect(
        PRESUNCOES.some(([, rx]) => rx.test(ok)),
        `bloqueou indevidamente: ${ok}`,
      ).toBe(false);
    }
  });

  it('`clinico` e `duvida_clinica` escalam, e só o clínico é urgente', () => {
    const c = tabela.intencoes.clinico;
    const d = tabela.intencoes.duvida_clinica;
    expect(c.acao).toBe('escalar');
    expect(d.acao).toBe('escalar');
    // Só `urgente` dispara o alarme sonoro do ntfy (`escalation-sla.ts`), e o
    // desempate da instrução manda preferir `clinico` na dúvida justamente por
    // isso: perder o alarme de quem tem dor custa mais que o contrário.
    expect(c.urgente).toBe(true);
    expect(d.urgente).toBe(false);
  });
});
