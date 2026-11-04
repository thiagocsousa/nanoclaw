import { execFileSync } from 'child_process';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ O tomador que o COLETOR da NFS-e produz satisfaz o que o EMISSOR lê.
 *
 * Em 25/10/2026 reescrevi o `nfse_coletar.py` para a Clínica nas Nuvens e
 * nomeei o campo do endereço como `rua` — o nome dele na CNN — sem olhar quem
 * consome. O `nfse_emitir_pipeline.py` lê `end.get("logradouro")` para montar
 * o `xLgr` da DPS, então TODO item da era CNN morria no emissor com "cadastro
 * incompleto, faltou xLgr".
 *
 * Ficou dez dias assim. Não apareceu antes porque a lista vinha quase sempre
 * vazia — a única nota automática do período teria falhado igual, e só se
 * descobriu ao emitir três à mão.
 *
 * ⚠️ `chamadas-python.test.ts` NÃO pega isto. Lá o contrato é chamada de
 * função; aqui é chave de dicionário entre dois módulos que não se importam.
 * Nenhum `import` liga os dois, e `.get()` de chave ausente devolve `None` em
 * silêncio — a falha só aparece três passos adiante, na resposta da
 * prefeitura, com uma mensagem que fala de um campo (`xLgr`) cujo nome não
 * existe em nenhum dos dois arquivos.
 *
 * A lógica mora em `scripts/checar-contrato-nfse.py` (AST) e é chamada daqui
 * para entrar na suíte que já roda.
 */
describe('contrato do tomador entre coletor e emissor da NFS-e', () => {
  it('toda chave que o emissor lê, o coletor produz', () => {
    const checker = path.resolve('scripts/checar-contrato-nfse.py');
    let saida = '';
    let codigo = 0;
    try {
      saida = execFileSync('python3', [checker], { encoding: 'utf-8' });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      codigo = e.status ?? 1;
      saida = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(saida, saida).toContain('contrato ok');
    expect(codigo).toBe(0);
  });
});
