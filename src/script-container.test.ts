import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
}));

import {
  LIMITES_DE_RECURSO,
  colheContainer,
  nomeiaContainer,
} from './script-container.js';

describe('nomeiaContainer', () => {
  it('usa o prefixo que cleanupOrphans varre', () => {
    // ⚠️ Este é o teste que importa. `cleanupOrphans()` filtra por
    // `name=nanoclaw-`, e o órfão de uma hora achado em 19/10/2026 se chamava
    // `inspiring_hofstadter` — nome do Docker — então a varredura passava por
    // cima dele. Se alguém trocar o prefixo, a colheita na subida volta a ser
    // cega sem nenhum outro sintoma.
    expect(nomeiaContainer('vagas').startsWith('nanoclaw-')).toBe(true);
  });

  it('não repete entre execuções simultâneas', () => {
    // Dois containers com o mesmo nome: o segundo `docker run` recusa, e o
    // sintoma seria uma busca falhando sem motivo aparente.
    const nomes = new Set(
      Array.from({ length: 200 }, () => nomeiaContainer('vagas')),
    );
    expect(nomes.size).toBe(200);
  });

  it('cabe na validação de nome de container', () => {
    for (const rotulo of ['vagas', 'paciente', 'marcar']) {
      expect(nomeiaContainer(rotulo)).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    }
  });
});

describe('LIMITES_DE_RECURSO', () => {
  it('limita CPU e NÃO limita memória', () => {
    // A ausência de `--memory` é decisão, não esquecimento: teto baixo faz o
    // OOM killer derrubar o chromium no meio da navegação e o erro que chega é
    // outro igualmente enganoso. Ver o comentário em script-container.ts.
    expect(LIMITES_DE_RECURSO).toEqual(['--cpus', '1', '--shm-size=1g']);
    expect(LIMITES_DE_RECURSO).not.toContain('--memory');
  });

  it('carrega o /dev/shm que o chromium precisa', () => {
    // ⚠️ Com os 64 MB padrão do Docker o chromium não falha, PENDURA: medido em
    // 19/10/2026, `Page.goto` estourando 30 s em app.iclinic.com.br enquanto um
    // curl da mesma imagem e da mesma rede respondia 200 em 2 s. Um flag de
    // diferença fez o goto completar. Se alguém tirar isto, o sintoma volta
    // disfarçado de "iClinic fora do ar".
    expect(LIMITES_DE_RECURSO).toContain('--shm-size=1g');
  });
});

describe('colheContainer', () => {
  beforeEach(() => mockExecFile.mockReset());

  it('manda remover o container pelo nome', () => {
    colheContainer('nanoclaw-script-vagas-abc123');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [bin, args] = mockExecFile.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args).toEqual(['rm', '-f', 'nanoclaw-script-vagas-abc123']);
  });

  it('recusa nome que não passa na validação, sem executar nada', () => {
    // Controle negativo: o nome entra numa linha de comando.
    for (const ruim of ['-rf /', 'a b', '', 'x;docker rm -f outro']) {
      colheContainer(ruim);
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
