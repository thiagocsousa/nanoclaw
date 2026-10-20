import { describe, expect, it, vi, beforeEach } from 'vitest';

// ⚠️ `code` é `number | string | null`, e os três casos importam: número é
// saída própria do processo, string é erro do CLIENTE
// (ERR_CHILD_PROCESS_STDIO_MAXBUFFER, ENOENT) e null vem junto com um sinal.
// É essa união que `rodaScript` usa para decidir se há container para colher.
type Cb = (
  err:
    | (Error & { signal?: string | null; code?: number | string | null })
    | null,
  stdout: string,
  stderr: string,
) => void;

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execSync: vi.fn(() => ''),
}));
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  GROUPS_DIR: '/groups',
}));
// ⚠️ `importOriginal`, não um objeto escrito à mão. O ponto de
// CONTAINER_NAME_PREFIX e nomeValidoDeContainer morarem em container-runtime.ts
// é não existirem duas cópias; um mock literal aqui recriaria exatamente a
// transcrição que a mudança eliminou, e o teste passaria com o módulo real
// divergindo.
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: 'docker',
}));

import { CONTAINER_NAME_PREFIX, psArgs } from './container-runtime.js';
import {
  IDADE_DE_ORFAO_MS,
  LIMITES_DE_RECURSO,
  PREFIXO_DE_SCRIPT,
  colheContainer,
  colheScriptsEsquecidos,
  montaArgs,
  nomeiaContainer,
  rodaScript,
} from './script-container.js';

/** Dispara o callback do execFile da chamada `i`. */
function responde(
  i: number,
  err: Parameters<Cb>[0],
  stdout = '',
  stderr = '',
): void {
  const call = mockExecFile.mock.calls[i];
  (call[call.length - 1] as Cb)(err, stdout, stderr);
}

beforeEach(() => mockExecFile.mockReset());

describe('nomeiaContainer', () => {
  it('usa o prefixo que cleanupOrphans varre', () => {
    // ⚠️ Este é o teste que importa. `cleanupOrphans()` filtra por
    // `name=nanoclaw-`, e o órfão de uma hora achado em 19/10/2026 se chamava
    // `inspiring_hofstadter` — nome do Docker — então a varredura passava por
    // cima dele. Vem da constante compartilhada, então mudar o filtro quebra
    // aqui em vez de cegar a varredura em silêncio.
    expect(nomeiaContainer('vagas').startsWith(CONTAINER_NAME_PREFIX)).toBe(
      true,
    );
    expect(PREFIXO_DE_SCRIPT.startsWith(CONTAINER_NAME_PREFIX)).toBe(true);
  });

  it('separa script de agente no nome', () => {
    // A varredura periódica SÓ pode tocar em script: ela roda a cada minuto e
    // os containers de agente estão vivos com paciente dentro.
    expect(nomeiaContainer('vagas').startsWith(PREFIXO_DE_SCRIPT)).toBe(true);
  });

  it('não repete entre execuções simultâneas', () => {
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
  it('usa peso relativo, NÃO teto rígido de CPU', () => {
    // ⚠️ Correção de um gol contra. `--cpus 1` é teto rígido de CFS e morde
    // mesmo com o segundo núcleo ocioso: 1,75x de perda medida no mesmo
    // trabalho, justamente no container do caminho de resposta ao paciente,
    // enquanto o container do AGENTE não tem limite nenhum. `--cpu-shares` só
    // vale sob disputa.
    // Sem `--memory`: teto baixo faz o OOM killer derrubar o chromium no meio
    // da navegação e o erro que chega é outro igualmente enganoso. E com os
    // 64 MB padrão de /dev/shm o chromium não falha, PENDURA: `Page.goto`
    // estourando 30 s enquanto um curl da mesma imagem respondia 200 em 2 s.
    expect(LIMITES_DE_RECURSO).toEqual([
      '--cpu-shares',
      '512',
      '--shm-size=1g',
    ]);
  });
});

describe('montaArgs', () => {
  it('nomeia, limita e monta a pasta somente-leitura', () => {
    const { nome, args } = montaArgs({
      rotulo: 'vagas',
      dir: '/groups/teste',
      script: 'iclinic_vagas.py',
      envKeys: [],
      argv: ['--perfil', 'particular'],
    });
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--name', nome]);
    for (const f of LIMITES_DE_RECURSO) expect(args).toContain(f);
    expect(args).toContain('/groups/teste:/workspace/group:ro');
    expect(args).toContain('/workspace/group/scripts/iclinic_vagas.py');
    expect(args.slice(-2)).toEqual(['--perfil', 'particular']);
  });

  it('passa só as credenciais presentes no ambiente', () => {
    process.env.CRED_PRESENTE_TESTE = 'x';
    delete process.env.CRED_AUSENTE_TESTE;
    const { args } = montaArgs({
      rotulo: 'x',
      dir: '/d',
      script: 's.py',
      envKeys: ['CRED_PRESENTE_TESTE', 'CRED_AUSENTE_TESTE'],
    });
    expect(args).toContain('CRED_PRESENTE_TESTE');
    expect(args).not.toContain('CRED_AUSENTE_TESTE');
    // Nunca `-e NOME=valor`: isso deixaria a senha visível em `ps`.
    expect(args.join(' ')).not.toContain('CRED_PRESENTE_TESTE=');
    delete process.env.CRED_PRESENTE_TESTE;
  });
});

describe('rodaScript', () => {
  it('colhe o container no TIMEOUT', async () => {
    const p = rodaScript({
      nome: 'nanoclaw-script-vagas-abc',
      args: ['run'],
      timeoutMs: 10,
      maxBuffer: 1,
    });
    const err = Object.assign(new Error('Command failed'), {
      signal: 'SIGTERM',
      code: null,
    });
    responde(0, err, '', 'traceback');
    const r = await p;
    expect(r.timeout).toBe(true);
    expect(r.erro).toContain('signal=SIGTERM');
    expect(r.erro).toContain('traceback');
    // A 2ª chamada é o `rm -f`: o timeout mata o CLIENTE docker, não o
    // container, e foi assim que um iclinic_vagas.py viveu uma hora.
    expect(mockExecFile.mock.calls[1][1]).toEqual([
      'rm',
      '-f',
      'nanoclaw-script-vagas-abc',
    ]);
  });

  it('NÃO colhe em saída não-zero, que o --rm já removeu', async () => {
    // ⚠️ Controle negativo e a economia que ele guarda: colher aqui custava
    // 0,11 s e 22 MB de RSS por falha, sem nem deixar log, disparados no
    // momento em que a VM tinha 166 MiB livres.
    const p = rodaScript({
      nome: 'nanoclaw-script-vagas-def',
      args: ['run'],
      timeoutMs: 10,
      maxBuffer: 1,
    });
    const err = Object.assign(new Error('Command failed'), {
      signal: null,
      code: 3,
    });
    responde(0, err, '', 'erro do script');
    const r = await p;
    expect(r.timeout).toBe(false);
    expect(r.erro).toContain('erro do script');
    expect(r.erro).not.toContain('signal=');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['maxBuffer', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', undefined],
    ['binário ausente', 'ENOENT', undefined],
  ])('colhe quando o cliente morreu: %s', async (_nome, code, signal) => {
    // ⚠️ A primeira versão testava só `signal`, e o maxBuffer passava batido:
    // medido, `signal` vem UNDEFINED ali, então o chromium ficava vivo até a
    // varredura de 5 minutos. Achado do review adversarial do Codex em
    // 20/10/2026. O predicado certo é "o processo saiu sozinho?", e só
    // `typeof code === 'number'` responde sim.
    const p = rodaScript({
      nome: 'nanoclaw-script-vagas-cli',
      args: ['run'],
      timeoutMs: 10,
      maxBuffer: 1,
    });
    responde(0, Object.assign(new Error('x'), { code, signal }), '', '');
    await p;
    expect(mockExecFile.mock.calls[1]?.[1]).toEqual([
      'rm',
      '-f',
      'nanoclaw-script-vagas-cli',
    ]);
  });

  it('arma a rede de segunda chance SÓ quando o cliente morreu', async () => {
    // ⚠️ Isto substituiu uma varredura de 60 s que rodava para sempre: medido,
    // um fork/exec de 22 MB do CLI do docker caía 1 a 3 vezes DENTRO de cada
    // execução de script, na mesma VM de 2 núcleos. O one-shot é equivalente
    // porque `rodaScript` é o único dono de spawn — um container só vaza onde a
    // colheita foi tentada.
    vi.useFakeTimers();
    try {
      const p = rodaScript({
        nome: 'nanoclaw-script-vagas-rede',
        args: ['run'],
        timeoutMs: 10,
        maxBuffer: 1,
      });
      responde(
        0,
        Object.assign(new Error('x'), { code: null, signal: 'SIGTERM' }),
        '',
        '',
      );
      await p;
      // 1ª chamada: o run. 2ª: o `rm -f` imediato. Nada de `ps` ainda.
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(IDADE_DE_ORFAO_MS + 1);
      // Agora sim a varredura, UMA vez.
      expect((mockExecFile.mock.calls[2][1] as string[])[0]).toBe('ps');
      vi.advanceTimersByTime(IDADE_DE_ORFAO_MS * 5);
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saída não-zero NÃO arma varredura nenhuma', async () => {
    // Controle negativo: o `--rm` já removeu, não há o que colher nem varrer.
    vi.useFakeTimers();
    try {
      const p = rodaScript({
        nome: 'nanoclaw-script-vagas-semrede',
        args: ['run'],
        timeoutMs: 10,
        maxBuffer: 1,
      });
      responde(0, Object.assign(new Error('x'), { code: 3, signal: null }));
      await p;
      vi.advanceTimersByTime(IDADE_DE_ORFAO_MS * 5);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('devolve stdout e stderr também na FALHA', async () => {
    // ⚠️ É disso que `agendamento.ts` depende: o motivo que chega à RECEPÇÃO
    // sai do stdout do `iclinic_marcar.py`, que é onde ele escreve por que
    // recusou. Um ponto único que devolvesse só `erro` faria a escalada chegar
    // com a linha de comando em vez do motivo.
    const p = rodaScript({
      nome: 'nanoclaw-script-marcar-xyz',
      args: ['run'],
      timeoutMs: 10,
      maxBuffer: 1,
    });
    const err = Object.assign(new Error('Command failed'), {
      signal: null,
      code: 2,
    });
    responde(0, err, '{"ok": false, "erro": "escrita_indisponivel"}', 'warn');
    const r = await p;
    expect(r.stdout).toContain('escrita_indisponivel');
    expect(r.stderr).toBe('warn');
  });

  it('devolve stdout no sucesso e não colhe nada', async () => {
    const p = rodaScript({
      nome: 'nanoclaw-script-vagas-ghi',
      args: ['run'],
      timeoutMs: 10,
      maxBuffer: 1,
    });
    responde(0, null, '{"ok": true}', '');
    expect(await p).toEqual({
      stdout: '{"ok": true}',
      stderr: '',
      timeout: false,
    });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe('colheContainer', () => {
  it('manda remover o container pelo nome', () => {
    colheContainer('nanoclaw-script-vagas-abc123');
    expect(mockExecFile.mock.calls[0][1]).toEqual([
      'rm',
      '-f',
      'nanoclaw-script-vagas-abc123',
    ]);
  });

  it('recusa nome que não passa na validação, sem executar nada', () => {
    // Controle negativo: o nome entra numa linha de comando.
    for (const ruim of ['-rf /', 'a b', '', 'x;docker rm -f outro']) {
      colheContainer(ruim);
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('colheScriptsEsquecidos', () => {
  it('filtra por script e colhe só o velho', () => {
    colheScriptsEsquecidos(180_000);
    expect(mockExecFile.mock.calls[0][1]).toEqual([
      'ps',
      '--filter',
      `name=${PREFIXO_DE_SCRIPT}`,
      '--format',
      '{{.Names}}\t{{.CreatedAt}}',
    ]);
    const velho = new Date(Date.now() - 600_000).toISOString();
    const novo = new Date(Date.now() - 5_000).toISOString();
    responde(
      0,
      null,
      `nanoclaw-script-vagas-velho\t${velho}\n` +
        `nanoclaw-script-vagas-novo\t${novo}\n`,
    );
    const removidos = mockExecFile.mock.calls
      .slice(1)
      .map((c) => (c[1] as string[])[2]);
    expect(removidos).toEqual(['nanoclaw-script-vagas-velho']);
  });

  it('usa psArgs, que é o que a migração de runtime conserta', () => {
    // ⚠️ `.claude/skills/convert-to-apple-container/SKILL.md` nomeia este
    // `docker ps --filter` como passo de migração, e a skill edita
    // container-runtime.ts. Se esta chamada voltar a ser montada à mão aqui,
    // depois da migração a varredura devolve vazio e cega em silêncio.
    colheScriptsEsquecidos(180_000);
    expect(mockExecFile.mock.calls[0][1]).toEqual(
      psArgs(PREFIXO_DE_SCRIPT, '{{.Names}}\t{{.CreatedAt}}'),
    );
  });

  it('o piso de idade é derivado dos timeouts, não um literal', () => {
    // A relação "o piso tem de passar do maior timeout de script" morava só na
    // prosa, e levantar VAGAS_TIMEOUT_MS deixaria o piso de ser teto em
    // silêncio.
    expect(IDADE_DE_ORFAO_MS).toBeGreaterThan(180_000);
  });

  it('o filtro é de script, nunca de agente', () => {
    // ⚠️ O controle negativo que me impediu de pendurar `cleanupOrphans()` num
    // tique: ela derruba todo `nanoclaw-*`, incluindo o container de AGENTE
    // vivo, com paciente dentro. A cada 60 s isso mataria conversa no meio.
    expect(PREFIXO_DE_SCRIPT).not.toBe(CONTAINER_NAME_PREFIX);
    colheScriptsEsquecidos(180_000);
    const filtro = (mockExecFile.mock.calls[0][1] as string[])[2];
    expect(filtro).toBe(`name=${PREFIXO_DE_SCRIPT}`);
    expect(
      'nanoclaw-whatsapp-atendimento-teste-123'.startsWith(PREFIXO_DE_SCRIPT),
    ).toBe(false);
    // ⚠️ E o caso que quase passou: com o nome antigo do container de agente
    // (`nanoclaw-${pasta}-${ts}`), uma pasta chamada `script` produzia
    // `nanoclaw-script-<ts>`, casava este filtro e era colhida à força NO MEIO
    // da conversa do paciente. Por isso o agente tem infixo próprio.
    expect('nanoclaw-agent-script-123'.startsWith(PREFIXO_DE_SCRIPT)).toBe(
      false,
    );
    expect('nanoclaw-script-1770000000000'.startsWith(PREFIXO_DE_SCRIPT)).toBe(
      true,
    );
  });

  it('ignora data que não parseia, em vez de colher tudo', () => {
    colheScriptsEsquecidos(1);
    responde(0, null, 'nanoclaw-script-vagas-x\tsei-la-quando\n');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
