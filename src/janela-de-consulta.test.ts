import { execFileSync } from 'child_process';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ A janela de consulta da Lara e a regra que confere a CNN são a MESMA.
 *
 * Decisão do Thiago em 26/10/2026: a agenda da CNN fica aberta, para a
 * secretária marcar exame e cirurgia nos outros dias, e quem restringe
 * consulta aos horários da Marina é a Lara. Isso criou duas cópias da regra:
 *
 *   - `groups/whatsapp_atendimento-teste/scripts/iclinic_vagas.py`
 *     → `JANELAS_DE_CONSULTA`, que decide o que a Lara OFERECE e MARCA;
 *   - `scripts/conferir-agenda-cnn.py`
 *     → `JANELAS`, que decide se a agenda da CNN está certa.
 *
 * Não dá para uma importar da outra: só `/workspace/group` é montado no
 * container, então script de grupo não importa script do repositório — a mesma
 * restrição que obriga as três cópias do `cnn.py` (ver
 * `cnn-client-copias.test.ts`).
 *
 * E divergir é o pior caso possível, não um incômodo: se a Marina mudar o
 * horário da quarta e só uma cópia for editada, o conferidor diz "agenda ok"
 * enquanto a Lara oferece noutro turno — exatamente a contradição que o
 * conferidor existe para impedir. Em 24/10/2026 isso quase aconteceu com a
 * janela morando num lugar só.
 *
 * ⚠️ Compara o VALOR, não o texto: lê os dois dicts com Python e confronta o
 * JSON. Comparar fonte faria o teste quebrar com uma vírgula a mais.
 */
describe('a janela de consulta tem uma fonte, em duas cópias idênticas', () => {
  function leDict(arquivo: string, nome: string): unknown {
    const py = [
      'import ast, json, sys',
      `arv = ast.parse(open(${JSON.stringify(arquivo)}, encoding="utf-8").read())`,
      'for n in arv.body:',
      '    if isinstance(n, ast.Assign) and any(',
      `        getattr(t, "id", None) == ${JSON.stringify(nome)} for t in n.targets`,
      '    ):',
      '        print(json.dumps(ast.literal_eval(n.value), sort_keys=True))',
      '        sys.exit(0)',
      `sys.exit("não achei ${nome} em ${arquivo}")`,
    ].join('\n');
    return JSON.parse(
      execFileSync('python3', ['-c', py], { encoding: 'utf-8' }),
    );
  }

  it('`JANELAS_DE_CONSULTA` da Lara == `JANELAS` do conferidor', () => {
    const daLara = leDict(
      'groups/whatsapp_atendimento-teste/scripts/iclinic_vagas.py',
      'JANELAS_DE_CONSULTA',
    );
    const doConferidor = leDict('scripts/conferir-agenda-cnn.py', 'JANELAS');
    expect(daLara).toEqual(doConferidor);
  });

  /**
   * Terça é cirurgia, quinta não tem atendimento, e sábado/domingo a clínica
   * fecha. Os quatro entram por AUSÊNCIA, e esta asserção existe para que
   * acrescentar um deles por engano doa — em 26/10 a grade da CNN oferecia
   * sábado, terça e quinta, e a Lara entra no ar em 03/11.
   */
  it('só segunda, quarta e sexta têm janela', () => {
    const daLara = leDict(
      'groups/whatsapp_atendimento-teste/scripts/iclinic_vagas.py',
      'JANELAS_DE_CONSULTA',
    ) as Record<string, unknown>;
    expect(Object.keys(daLara).sort()).toEqual(['0', '2', '4']);
  });
});
