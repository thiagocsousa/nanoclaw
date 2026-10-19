import { describe, expect, it } from 'vitest';

import {
  necessidadeDoMenu,
  necessidadeMencionada,
  temPlano,
} from './convenio.js';

/**
 * A regra de ORDEM, nos dois sentidos.
 *
 * Na passada 17 o C01 mostrou o lado fácil: "particular, nao tenho plano" virou
 * "plano não aceito" e a Lara deu R$ 300,00 a quem paga R$ 430,00. Eu alarguei a
 * lista de ausência e criei o lado inverso — o /simplify mediu no mesmo dia, e
 * os cinco primeiros casos de `TEM PLANO` abaixo são os que ele achou.
 *
 * Enumerar não converge em nenhuma das direções. A ordem converge.
 */
describe('temPlano: nome de plano vence palavra de ausência', () => {
  it.each([
    'não tenho certeza, acho que é Bradesco',
    'nao tenho o cartao aqui, mas é Amil',
    'não uso mais o Bradesco, agora é Amil',
    'Hapvida, mas pago por fora o que ele não cobre',
    'Bradesco Saúde particular',
    'SulAmérica (privado)',
    'Bradesco Saude',
    'Amil',
    'Unimed',
    'IASPI',
    'plano da empresa',
  ])('TEM plano: %s', (c) => {
    expect(temPlano(c), c).toBe(true);
  });

  it.each([
    'particular',
    'Particular',
    'não tenho plano',
    'nao tenho plano',
    'particular, nao tenho plano',
    'não tenho convênio',
    'nao possuo plano',
    'sem plano',
    'sem convênio',
    'sem seguro',
    'nenhum',
    'privado',
    'pago do meu bolso',
    'por fora',
  ])('NÃO tem plano: %s', (c) => {
    expect(temPlano(c), c).toBe(false);
  });

  it('vazio não é plano', () => {
    expect(temPlano('')).toBe(false);
    expect(temPlano(undefined)).toBe(false);
    expect(temPlano('   ')).toBe(false);
  });
});

/**
 * `necessidadeMencionada`: o host preenche o que o modelo deixou vazio.
 *
 * Saiu na passada 17 — a mesma pergunta com dois preços, porque o slot
 * `necessidade` vinha vazio quando "cirurgia" aparecia sem diagnóstico junto.
 */
describe('necessidadeMencionada', () => {
  // ⚠️ Devolve o termo ESPECÍFICO quando dá para saber, e o genérico só quando
  // não dá. A primeira versão devolvia sempre "cirurgia" — ver o describe do
  // Codex abaixo para o que isso custava.
  it.each([
    ['voces fazem cirurgia pelo PLAMTA?', 'cirurgia'],
    ['queria operar a vista', 'cirurgia'],
    ['quero fazer a operação', 'cirurgia'],
    ['quanto custa a cirurgia refrativa?', 'cirurgia refrativa'],
    ['fazem lasik?', 'cirurgia refrativa'],
    ['faz PRK?', 'cirurgia refrativa'],
    ['tenho catarata, queria marcar', 'catarata'],
  ])('%s -> %s', (msg, esperado) => {
    expect(necessidadeMencionada(undefined, msg), msg).toBe(esperado);
    expect(necessidadeMencionada('', msg), msg).toBe(esperado);
  });

  // ⚠️ NUNCA sobrescreve o que o modelo rotulou. Se ele disse catarata, é
  // catarata — o host não adivinha o procedimento, só não deixa o slot vazio.
  it.each(['catarata', 'cirurgia refrativa', 'rotina', 'retorno', 'exame'])(
    'não sobrescreve necessidade="%s"',
    (n) => {
      expect(necessidadeMencionada(n, 'voces fazem cirurgia?')).toBe(n);
    },
  );

  // ⚠️ E o par que segura: mensagem SEM menção a cirurgia não inventa nada.
  // Preencher no chute mandaria quem quer rotina para a agenda cirúrgica, que
  // tem duração e antecedência diferentes.
  it.each([
    'quanto custa a consulta?',
    'que dias a Dra. Marina atende?',
    'qual o endereço?',
    'oi',
    'preciso trocar o grau do óculos',
    'uso lente de contato',
  ])('não preenche: %s', (msg) => {
    expect(necessidadeMencionada(undefined, msg), msg).toBeUndefined();
  });
});

/**
 * Os dois achados do review adversarial do Codex, 19/10/2026.
 *
 * Os dois contra código que eu havia escrito no mesmo dia, e os dois
 * reproduzidos antes de consertar.
 */
describe('Codex: ausência explícita vence o nome do plano', () => {
  it.each([
    'particular, cancelei o Bradesco e não tenho mais plano',
    'cancelei o Bradesco',
    'cancelei meu convênio',
    'não tenho mais plano',
    'não tenho mais convênio',
    'não tenho nenhum plano',
  ])('NÃO tem plano: %s', (c) => {
    expect(temPlano(c), c).toBe(false);
  });

  // ⚠️ E a incerteza sobre QUAL plano continua sendo "tem plano". Confundir as
  // duas foi o que criou o bug inverso do desconto, horas antes.
  it.each([
    'não tenho certeza, acho que é Bradesco',
    'nao tenho o cartao aqui, mas é Amil',
    'não uso mais o Bradesco, agora é Amil',
    'tinha Amil, hoje é Bradesco',
  ])('TEM plano: %s', (c) => {
    expect(temPlano(c), c).toBe(true);
  });
});

describe('Codex: o fallback preserva a especificidade', () => {
  // ⚠️ Cada um desses valores liga uma trava diferente, e "cirurgia" genérico
  // não liga nenhuma: `retorno*` é soHumano, `cirurgia refrativa` dispara a
  // pergunta da lente e os 3 dias.
  it.each([
    ['é para o retorno da cirurgia', 'retorno de cirurgia'],
    ['queria marcar meu retorno', 'retorno'],
    ['quero marcar a cirurgia refrativa', 'cirurgia refrativa'],
    ['quero parar de usar óculos', 'cirurgia refrativa'],
    ['tenho miopia, quero operar', 'cirurgia refrativa'],
    ['quero operar a catarata', 'catarata'],
    ['voces fazem cirurgia?', 'cirurgia'],
  ])('%s -> %s', (msg, esperado) => {
    expect(necessidadeMencionada(undefined, msg), msg).toBe(esperado);
  });

  // ⚠️ E NUNCA atropela o que a conversa já estabeleceu. A primeira versão lia
  // só o slot do turno, então uma menção nova a "cirurgia" apagava o
  // "cirurgia refrativa" ou o "retorno" de dois turnos antes — e com ele a
  // pergunta da lente ou a trava do retorno.
  it.each(['cirurgia refrativa', 'retorno', 'catarata', 'rotina', 'exame'])(
    'memória "%s" sobrevive a uma menção genérica',
    (lembrado) => {
      expect(necessidadeMencionada(lembrado, 'voces fazem cirurgia?')).toBe(
        lembrado,
      );
    },
  );
});

/**
 * ⏳ O MENU DA BRUNA — temporário da semana de observação de 20/10/2026.
 *
 * Quando o menu sair ("depois vamos eliminar esse menu", Thiago), este describe
 * deve sair com ele. Deixei os dois primeiros casos dependendo do mapa para que
 * quem apagar o `MENU_DA_BRUNA` e esquecer o resto veja o teste reprovar.
 */
describe('necessidadeDoMenu', () => {
  it.each([
    ['1', 'cirurgia refrativa'],
    ['2', 'catarata'],
    ['3', 'rotina'],
    // Como o paciente de verdade digita.
    ['1 ', 'cirurgia refrativa'],
    [' 2', 'catarata'],
    ['3.', 'rotina'],
    ['1)', 'cirurgia refrativa'],
    ['2 -', 'catarata'],
  ])('%s -> %s', (msg, esperado) => {
    expect(necessidadeDoMenu(msg), msg).toBe(esperado);
  });

  // ⛔ "4 - Outros" significa "nenhuma das três". Adivinhar é pior que perguntar.
  it('4 (Outros) NÃO vira necessidade', () => {
    expect(necessidadeDoMenu('4')).toBeUndefined();
  });

  // ⛔ Número fora do menu não vira nada: escala, como o resto do que ela não
  // entendeu.
  it.each(['5', '7', '9', '0'])('%s não existe no menu', (msg) => {
    expect(necessidadeDoMenu(msg)).toBeUndefined();
  });

  // ⚠️ O par que segura: número DENTRO de frase não é escolha de menu. Sem
  // isto, "tenho 2 filhos" marcaria catarata e "nasci em 1980" marcaria
  // refrativa — e o paciente receberia triagem de uma cirurgia que não pediu.
  it.each([
    'tenho 2 filhos',
    'nasci em 1980',
    'quanto custa 1 consulta?',
    'sou o 3 da fila',
    '1 pergunta: atende Unimed?',
    'meu grau é 3',
    '',
    '   ',
  ])('NÃO é menu: %s', (msg) => {
    expect(necessidadeDoMenu(msg), msg).toBeUndefined();
  });
});
