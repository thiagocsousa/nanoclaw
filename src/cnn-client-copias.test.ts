import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ O `cnn.py` é COPIADO entre pastas de grupo, e as cópias têm de ser
 * idênticas.
 *
 * O container monta só `/workspace/group` — a pasta do próprio grupo —, então
 * um script de `whatsapp_marina` não consegue importar de
 * `whatsapp_atendimento-dra-marina`. Não há mount comum, e por isso não há
 * módulo comum: a saída é duplicar o arquivo.
 *
 * Duplicar é aceitável; divergir em silêncio não. O que este teste protege é
 * concreto: a tabela `TIPOS_DE_CONSULTA` decide quem recebe lembrete e
 * `STATUS_SEM_VALOR` decide o que conta como horário válido. Uma cópia
 * atualizada e outra não é o paciente de um pipeline sendo lembrado e o de
 * outro não, sem nada explodir.
 */
describe('cnn.py: as cópias entre grupos são idênticas', () => {
  const raiz = path.join(process.cwd(), 'groups');
  const copias = fs
    .readdirSync(raiz)
    .map((g) => path.join(raiz, g, 'scripts', 'cnn.py'))
    .filter((p) => fs.existsSync(p));

  it('existe pelo menos uma', () => {
    expect(copias.length).toBeGreaterThan(0);
  });

  it('todas têm exatamente o mesmo conteúdo', () => {
    const porConteudo = new Map<string, string[]>();
    for (const c of copias) {
      const texto = fs.readFileSync(c, 'utf-8');
      const grupo = path.relative(raiz, c);
      porConteudo.set(texto, [...(porConteudo.get(texto) ?? []), grupo]);
    }
    // Uma única entrada = todas iguais. Mais de uma = divergiram, e a mensagem
    // mostra quais pastas estão em cada versão.
    expect([...porConteudo.values()]).toHaveLength(1);
  });
});
