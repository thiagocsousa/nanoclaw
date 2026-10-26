import { execFileSync } from 'child_process';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ Script Python que importa um irmão chama função que EXISTE nele.
 *
 * Nasceu de um estrago de verdade, em 26/10/2026. Em 25/10 eu reescrevi o
 * `nfse_coletar.py` para a Clínica nas Nuvens e não olhei o único arquivo que
 * o chama: o `nfse_coletar_pipeline.py` continuou chamando `nc.login(pw)`, que
 * deixou de existir, e `nc.coletar` com cinco argumentos, que passou a receber
 * três.
 *
 * O que custou não foi o erro — foi o silêncio. O `pending_nfse.json` ficou no
 * disco com a coleta de 23/10, a emissão seguiu lendo aquele retrato, e a
 * recepção tentou emitir a mesma paciente TRÊS vezes preenchendo o cadastro
 * entre as tentativas, enquanto o coletor lia dado de três dias antes.
 * Pareceu cache; era a coleta morta.
 *
 * TypeScript pega isso no `tsc`. Python só em execução — e esta execução é um
 * cron das 18:30 que ninguém vê falhar. A guarda é o `tsc` que falta.
 *
 * A lógica mora em `scripts/checar-chamadas-python.py` (AST, não regex) e é
 * invocada daqui para entrar na suíte que já roda. Ver também
 * `cnn-client-copias.test.ts`, que guarda a outra metade: as cópias do cliente.
 */
describe('chamadas entre scripts Python', () => {
  const checker = path.resolve('scripts/checar-chamadas-python.py');

  it('toda chamada a módulo irmão existe e a aridade cabe', () => {
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
