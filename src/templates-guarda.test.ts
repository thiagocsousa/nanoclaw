import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { inspecionaSaida } from './output-guard.js';

/**
 * Todo texto aprovado da tabela, passado pela guarda.
 *
 * Existe porque a revisão de tom de 17/10/2026 chegou com 8 de 12 textos
 * terminando em "Posso verificar os horários disponíveis para você?" — frase que
 * a guarda marca como pedir permissão para fazer o próprio trabalho. Eu só
 * descobri porque fui ler as regras uma por uma; nada no projeto perguntava
 * isso. Texto aprovado por humano é dado de entrada como outro qualquer, e a
 * guarda existe justamente porque humano aprova texto com deslize dentro.
 *
 * É o teste estrutural contra dado aprovado, não revisão à mão: ele roda em
 * milissegundos, sem VM e sem app, e falha no `npm test` de quem editar a
 * tabela.
 */
const TABELA = JSON.parse(
  fs.readFileSync(
    path.join(
      process.cwd(),
      'groups/whatsapp_atendimento-teste/templates.json',
    ),
    'utf-8',
  ),
) as {
  intencoes: Record<
    string,
    { acao: string; textos?: string[]; textos_sem_slot?: string[] }
  >;
};

/**
 * Valores de slot plausíveis. Não são os de produção: só precisam ter a FORMA
 * certa, porque é da forma que a guarda trata — dinheiro perto de "cirurgia",
 * telefone, CPF, caixa alta.
 */
const SLOTS: Record<string, string> = {
  valor_consulta: '430,00',
  valor_desconto: '300,00',
  valor_retorno: '0,00',
  dia: 'segunda',
  data: '20/10',
  hora: '09:00',
  dia_pedido: 'sábado',
  paciente: 'Marcos',
  nome: 'Marcos',
  codigo: 'A3F',
  convenio: 'Unimed',
  hospital: 'Hospital Vilar',
  necessidade: 'cirurgia de catarata',
};

function preenche(texto: string): string {
  return texto.replace(/\{(\w+)\}/g, (inteiro, chave: string) =>
    chave in SLOTS ? SLOTS[chave] : inteiro,
  );
}

describe('a tabela de templates passa pela guarda', () => {
  const casos: Array<[string, string, string]> = [];
  for (const [nome, def] of Object.entries(TABELA.intencoes)) {
    if (nome.startsWith('_')) continue;
    for (const t of def.textos ?? []) casos.push([nome, 'textos', t]);
    for (const t of def.textos_sem_slot ?? []) {
      casos.push([nome, 'textos_sem_slot', t]);
    }
  }

  it('tem texto para inspecionar', () => {
    expect(casos.length).toBeGreaterThan(40);
  });

  it.each(casos)('%s · %s', (nome, _campo, texto) => {
    const v = inspecionaSaida(preenche(texto), {
      // A confirmação de agendamento DIZ que está marcado, e deve: o que a
      // guarda proíbe é dizer isso sem ter marcado. Aqui o fato é dado.
      agendouDeVerdade: TABELA.intencoes[nome].acao === 'marcar',
      intencao: nome,
    });
    const graves = v.achados.filter((a) => a.nivel !== 'sanitize');
    expect(
      graves.map((a) => `${a.regra} (${a.nivel}): ${a.motivo}`),
      texto.slice(0, 120),
    ).toEqual([]);
  });

  // A tabela ficar verde não prova que a guarda olhou. Estes são os dois textos
  // que ela PRECISA pegar: a frase literal que veio na revisão de tom do Thiago,
  // e a frase da abertura usada fora da abertura. Sem eles, afrouxar a guarda
  // deixaria este arquivo passando igual.
  it('pega o convite em forma de permissão', () => {
    const v = inspecionaSaida(
      'As consultas para esse convênio são particulares, no valor de R$ 430,00.' +
        '\n\nPosso verificar os horários disponíveis para você?',
      { intencao: 'convenio_nao_atendido' },
    );
    expect(v.achados.map((a) => a.regra)).toContain('frase_proibida');
  });

  it('pega a frase da abertura fora da abertura', () => {
    const v = inspecionaSaida('Claro, em que posso te ajudar?', {
      intencao: 'convenio_consulta',
    });
    expect(v.achados.map((a) => a.regra)).toContain('frase_proibida');
    // E não pega na abertura, que é onde ela é a resposta certa.
    const na = inspecionaSaida('Em que posso ajudar?', {
      intencao: 'abertura',
    });
    expect(na.achados.map((a) => a.regra)).not.toContain('frase_proibida');
  });
});
