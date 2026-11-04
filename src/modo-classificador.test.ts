import fs from 'fs';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * ⛔ Pasta que responde por TABELA sobe sem ferramenta e sem preset.
 *
 * ## O custo que criou isto, medido em 04/11/2026
 *
 * Primeiro dia útil da Lara no ar: **669 DMs** de paciente num dia, contra
 * 6–29 na semana anterior, 53 conversas distintas. A cota de 5 horas estourou
 * **duas vezes** e o atendimento parou — inclusive uma aprovação de nota
 * fiscal que ficou sem resposta.
 *
 * Cada um desses turnos carregava o system prompt preset do Claude Code mais
 * DEZENOVE definições de ferramenta (Bash, Read, Write, Edit, Glob, Grep,
 * WebSearch, WebFetch, Task, TeamCreate, SendMessage, Skill…) para produzir
 * uma linha de JSON — porque o host escolhe todo o texto, e o agente só
 * rotula.
 *
 * A ironia: o `CLAUDE.md` da pasta abre com "⛔ Não leia arquivo nenhum, não
 * rode script". A instrução já proibia, em prosa paga a cada mensagem, o que
 * as ferramentas existiam para permitir. Aqui vira impossível em vez de
 * pedido — que é o que o Thiago chamou de "mais determinístico".
 *
 * ⚠️ O MODELO não muda aqui. `NANOCLAW_MODELO_CLASSIFICADOR` fica vazio por
 * padrão: trocar sem medir seria adivinhar, e a primeira tentativa de medir
 * (Haiku contra Sonnet) bateu no limite de 5 horas e devolveu 45% e 0% —
 * números que eram o limite, não os modelos.
 */
describe('modo classificador', () => {
  describe('o host liga o modo só na pasta de template', () => {
    let fakeProc: EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
    };
    // Tipado com os argumentos: sem isso o `mock.calls[0][1]` não compila,
    // porque `vi.fn(() => x)` declara uma tupla de aridade zero.
    const spawnMock = vi.fn(
      (_bin: string, _args: string[], _opts?: unknown) => fakeProc,
    );

    beforeEach(() => {
      vi.resetModules();
      const p = new EventEmitter() as typeof fakeProc;
      p.stdin = new PassThrough();
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = vi.fn();
      p.pid = 4242;
      fakeProc = p;
      spawnMock.mockClear();
    });

    async function argsDoSpawn(folder: string): Promise<string[]> {
      vi.doMock('./config.js', () => ({
        CONTAINER_IMAGE: 'nanoclaw-agent:latest',
        CONTAINER_MAX_OUTPUT_SIZE: 10485760,
        CONTAINER_TIMEOUT: 1800000,
        CREDENTIAL_PROXY_PORT: 3001,
        DATA_DIR: '/tmp/nc-test-data',
        GROUPS_DIR: '/tmp/nc-test-groups',
        IDLE_TIMEOUT: 1800000,
        ONECLI_API_KEY: '',
        ONECLI_URL: 'http://localhost:10254',
        TIMEZONE: 'America/Fortaleza',
        PASTA_DO_SLA: 'whatsapp_atendimento-dra-marina',
        wantsTemplates: (f?: string) => f === 'pasta-de-template',
      }));
      vi.doMock('./logger.js', () => ({
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      }));
      vi.doMock('./mount-security.js', () => ({
        validateAdditionalMounts: vi.fn(() => []),
      }));
      vi.doMock('./container-runtime.js', () => ({
        CONTAINER_RUNTIME_BIN: 'docker',
        CONTAINER_HOST_GATEWAY: 'host.docker.internal',
        hostGatewayArgs: () => [],
        readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
        stopContainer: vi.fn(),
      }));
      vi.doMock('./credential-proxy.js', () => ({
        detectAuthMode: vi.fn(() => 'api-key'),
      }));
      vi.doMock('child_process', async () => {
        const actual =
          await vi.importActual<typeof import('child_process')>(
            'child_process',
          );
        return { ...actual, spawn: spawnMock, exec: vi.fn() };
      });

      const mod = await import('./container-runner.js');
      void mod.runContainerAgent(
        { name: 'G', folder, trigger: '@A', added_at: '' },
        {
          prompt: 'oi',
          groupFolder: folder,
          chatJid: 'x@s.whatsapp.net',
          isMain: false,
        },
        () => {},
        async () => {},
      );
      await new Promise((r) => setImmediate(r));
      fakeProc.emit('close', 0);
      return spawnMock.mock.calls[0]?.[1] ?? [];
    }

    it('pasta de template recebe NANOCLAW_MODO_CLASSIFICADOR=1', async () => {
      const args = await argsDoSpawn('pasta-de-template');
      expect(args).toContain('NANOCLAW_MODO_CLASSIFICADOR=1');
    });

    it('pasta comum NÃO recebe — ela precisa das ferramentas', async () => {
      const args = await argsDoSpawn('whatsapp_marina');
      expect(args.join(' ')).not.toContain('NANOCLAW_MODO_CLASSIFICADOR');
    });
  });

  /**
   * O agent-runner roda DENTRO do container e não entra na suíte do host. O
   * que dá para travar daqui é a forma do código — e vale a pena, porque o
   * erro mais fácil aqui é silencioso: `allowedTools: undefined` cai no padrão
   * do SDK, que é TUDO. A diferença entre `[]` e `undefined` é o prompt
   * inteiro, e nenhuma delas falha em runtime.
   */
  describe('o agent-runner honra o modo', () => {
    const fonte = fs.readFileSync(
      'container/agent-runner/src/index.ts',
      'utf-8',
    );

    it('lê a env que o host manda', () => {
      expect(fonte).toContain(
        "process.env.NANOCLAW_MODO_CLASSIFICADOR === '1'",
      );
    });

    it('a lista de ferramentas é VAZIA no modo, não undefined', () => {
      expect(fonte).toMatch(/modoClassificador\s*\n?\s*\?\s*\[\]/);
      expect(fonte).not.toMatch(/modoClassificador\s*\?\s*undefined/);
    });

    it('troca o preset de agente de código por um prompt próprio', () => {
      expect(fonte).toContain('SYSTEM_PROMPT_CLASSIFICADOR');
      expect(fonte).toMatch(
        /systemPrompt:\s*modoClassificador\s*\n?\s*\?\s*SYSTEM_PROMPT_CLASSIFICADOR/,
      );
    });

    it('o modelo continua desligado por padrão, até ser medido', () => {
      expect(fonte).toMatch(
        /MODELO_CLASSIFICADOR\s*=\s*\n?\s*process\.env\.NANOCLAW_MODELO_CLASSIFICADOR \|\| undefined/,
      );
    });
  });
});
