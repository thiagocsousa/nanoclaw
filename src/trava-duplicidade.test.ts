import { execFileSync } from 'child_process';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ Nota fiscal não se emite duas vezes.
 *
 * Em 12/11/2026 saíram SEIS notas para três serviços da mesma paciente. O
 * coletor deduplicava por `receita_id`; o emissor não, porque escolhe por
 * ÍNDICE da lista pendente — reaprovar a mesma lista emitia de novo. E a
 * proteção do `emitir_com_protecao` não salva: ela é por `id_dps`, derivado do
 * contador `nDPS`, então contador novo dá nota nova.
 *
 * As três duplicadas foram canceladas na prefeitura (motivo 1, "Erro na
 * Emissão"), confirmado pela resposta dela: "Nota fiscal não está ativa.
 * Situação atual Cancelada".
 *
 * A lógica mora em `scripts/checar-trava-duplicidade.py`, que roda o `main()`
 * do emissor DE VERDADE — sem certificado no ambiente, então em nenhum caminho
 * toca a rede. Rodar o código real, e não uma cópia da regra, é deliberado:
 * cópia da regra é o que deixou o `send_avaliacao` quebrado seis meses.
 *
 * Irmão de `chamadas-python.test.ts` e `contrato-nfse.test.ts`: Python só
 * falha em execução, e esta execução é um cron das 18:30 que ninguém vê.
 */
describe('emissor de NFS-e recusa item que já tem nota', () => {
  const checker = path.resolve('scripts/checar-trava-duplicidade.py');

  it('não reemite, não barra demais, e avisa qual item repetiu', () => {
    let saida = '';
    let codigo = 0;
    try {
      saida = execFileSync('python3', [checker], { encoding: 'utf-8' });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      codigo = e.status ?? 1;
      saida = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(saida.trim(), saida).toBe('');
    expect(codigo).toBe(0);
  });
});
