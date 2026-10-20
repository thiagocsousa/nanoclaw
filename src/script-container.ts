import { execFile } from 'node:child_process';
import path from 'node:path';

import { CONTAINER_IMAGE } from './config.js';
import {
  CONTAINER_NAME_PREFIX,
  CONTAINER_RUNTIME_BIN,
  nomeValidoDeContainer,
  psArgs,
  readonlyMountArgs,
} from './container-runtime.js';
import { logger } from './logger.js';

/**
 * Dono do ciclo de vida dos containers de script (Playwright no iClinic).
 *
 * ⚠️ O PROBLEMA: `execFile(docker, args, { timeout })` mata o CLIENTE `docker
 * run`, não o container. Quando o host desiste, o container continua rodando
 * sozinho, para sempre, com o chromium dentro.
 *
 * Medido na VM em 19/10/2026, às 22:06: um `iclinic_vagas.py --perfil
 * particular` criado às 21:04:48 ainda estava no ar uma HORA depois, com 80%
 * de um dos dois núcleos e seis chromium pendurados. A máquina tem 2 CPUs e
 * 1,9 GiB; estava com load 6,85, 166 MiB livres e 1 GiB de swap em uso.
 *
 * O efeito disso no atendimento não parece um vazamento de container, parece
 * iClinic quebrado — e foi assim que apareceu:
 *
 *   - `Page.goto: Timeout 30000ms exceeded` em app.iclinic.com.br, enquanto
 *     um curl da MESMA VM e de dentro da MESMA imagem respondia 200 em 2 s;
 *   - `<input disabled ... placeholder="Email de acesso">` e "element is not
 *     enabled" por 30 s — o React da tela de login sem CPU para hidratar.
 *
 * Com isso, a busca por telefone falhou em A07 e E08 e passou em E05 na mesma
 * passada, e a leitura fácil (e errada) era "o iClinic está bloqueando a
 * conta".
 *
 * ⚠️ E a PRIMEIRA versão deste módulo era só um punhado de helpers, com cada
 * chamador fiando `execFile` + timeout + colheita por conta própria. O cheiro
 * que denunciou: `vagas.ts` recuperava o nome do container varrendo o próprio
 * array de argumentos (`args[args.indexOf('--name') + 1]`) — e bastava alguém
 * reordenar os argumentos para aquilo devolver `'run'`, que passa na validação
 * de nome, e o host mandar `docker rm -f run`. Agora quem spawna é
 * `rodaScript`: nenhum chamador escreve `--name` nem lembra de colher.
 *
 * O preço de não ter um dono já estava pago em `src/audio-transcribe.ts`, um
 * QUARTO `docker run` com timeout, sem `--name`, sem colheita e com `'docker'`
 * no lugar de `CONTAINER_RUNTIME_BIN`.
 */

/** Prefixo só dos containers de SCRIPT, para a varredura não tocar no agente. */
export const PREFIXO_DE_SCRIPT = `${CONTAINER_NAME_PREFIX}script-`;

/**
 * Um nome por execução, para poder colher depois.
 *
 * ⚠️ O prefixo vem de `container-runtime.ts`: `cleanupOrphans()` varre por ele,
 * e enquanto era literal repetido os dois lados podiam divergir sem nada
 * reprovar. O coletor existia e estava CEGO — o órfão de uma hora encontrado em
 * 19/10/2026 se chamava `inspiring_hofstadter`, nome aleatório do Docker,
 * porque estes scripts subiam sem `--name`.
 */
export function nomeiaContainer(rotulo: string): string {
  const unico = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `${PREFIXO_DE_SCRIPT}${rotulo}-${unico}`;
}

/**
 * Limites e ajustes dos containers de script.
 *
 * ⚠️ `--shm-size=1g` é REDE, não requisito — e isso mudou depois que os nove
 * scripts passaram a mandar `--disable-dev-shm-usage` no próprio navegador.
 * Com aquele arg o chromium não aloca em /dev/shm, então este teto não muda
 * nada nos três caminhos que o host spawna: é config morta para eles. Fica
 * porque custa ZERO (tmpfs é teto preguiçoso, não reserva: o container mostra
 * `size=1048576k` com `Used 0`) e porque cobre o script que alguém escrever
 * amanhã e esquecer o arg. O Docker dá 64 MB de /dev/shm por padrão, e com
 * 64 MB o chromium não derruba com erro: ele PENDURA.
 *
 * Medido na VM em 19/10/2026: o mesmo `iclinic_paciente_por_telefone.py`, com
 * a carga da máquina já normalizada em 1.70, falhava em
 * `Page.goto: Timeout 30000ms exceeded` em app.iclinic.com.br enquanto um curl
 * da MESMA imagem e da MESMA rede respondia 200 em 2 s. Trocando um único
 * flag — `--shm-size=1g` — o `goto` passou a completar. É TETO de tmpfs, não
 * reserva: o container mostra `size=1048576k` com `Used 0` e as páginas entram
 * sob demanda, então 1g não tira nada da máquina de 1,9 GiB.
 *
 * Isso também é a resposta para o diagnóstico errado que eu defendi antes: o
 * container órfão de uma hora era real e o vazamento era real, mas a carga
 * alta era CONSEQUÊNCIA, não causa. Com load 1.70 o sintoma continuava.
 *
 * ⚠️ `--cpu-shares`, NÃO `--cpus` — e isto é correção de um gol contra. A
 * primeira versão usava `--cpus 1`, que é teto RÍGIDO de CFS (`cpu.max` vira
 * `100000 100000`) e morde mesmo com o segundo núcleo ocioso: 1,75x de perda
 * medida no mesmo trabalho. Ou seja, o dia 19/10 inteiro consertando respostas
 * de 55 s e 68 s na agenda, e no fim um imposto permanente justamente neste
 * container — enquanto o container do AGENTE, que disputa a mesma máquina de 2
 * CPUs, não tem limite nenhum (`container-runner.ts`). `--cpu-shares` é peso
 * relativo: só vale sob disputa, então um script sozinho usa a máquina toda e
 * o host continua ganhando quando os dois brigam.
 *
 * Sem `--memory`: teto baixo faz o OOM killer derrubar o navegador no meio da
 * navegação, e o erro que chega é outro igualmente enganoso. A pressão de
 * memória do dia 19/10 vinha de containers ACUMULADOS, e quem resolve isso é a
 * colheita, não um teto por container.
 */
export const LIMITES_DE_RECURSO = ['--cpu-shares', '512', '--shm-size=1g'];

/**
 * Monta o `docker run` de um script do grupo.
 *
 * `envKeys` entra por parâmetro em vez de importar `CREDENCIAIS` de
 * `vagas.ts`: `vagas.ts` importa este módulo, e o caminho de volta seria ciclo.
 */
export function montaArgs(opts: {
  rotulo: string;
  dir: string;
  script: string;
  envKeys: readonly string[];
  argv?: readonly string[];
}): { nome: string; args: string[] } {
  const nome = nomeiaContainer(opts.rotulo);
  const args = [
    'run',
    '--rm',
    '--name',
    nome,
    ...LIMITES_DE_RECURSO,
    '--network',
    'bridge',
  ];
  for (const k of opts.envKeys) {
    if (process.env[k]) args.push('-e', k);
  }
  args.push(
    ...readonlyMountArgs(opts.dir, '/workspace/group'),
    '--entrypoint',
    'python3',
    CONTAINER_IMAGE,
    path.posix.join('/workspace/group/scripts', opts.script),
    ...(opts.argv ?? []),
  );
  return { nome, args };
}

/**
 * Roda o container e garante que ele morre.
 *
 * Devolve `stdout` no sucesso; na falha, `erro` com o que o provedor disse —
 * mensagem, sinal e o fim do `stderr`. A versão anterior era
 * `(err, stdout) => resolve(err ? undefined : stdout)`, que jogava os três no
 * lixo: em 19/10/2026 a busca por telefone falhou em A07 e E08 e passou em E05
 * na mesma passada, e o log não dizia se tinha sido timeout, login do iClinic
 * ou credencial faltando — e as três exigem conserto diferente.
 */
export function rodaScript(opts: {
  nome: string;
  args: readonly string[];
  timeoutMs: number;
  maxBuffer: number;
}): Promise<{
  stdout: string;
  stderr: string;
  erro?: string;
  timeout: boolean;
}> {
  return new Promise((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      [...opts.args],
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer },
      (err, stdout, stderr) => {
        // ⚠️ `stdout` e `stderr` voltam SEMPRE, inclusive na falha. Um ponto
        // único não pode engolir o que o chamador precisa: `agendamento.ts`
        // monta o motivo que chega à RECEPÇÃO a partir do stdout, porque é ali
        // que o `iclinic_marcar.py` escreve por que recusou. Devolver só `erro`
        // faria a escalada chegar com a linha de comando em vez do motivo.
        if (!err) return resolve({ stdout, stderr, timeout: false });
        // ⚠️ Só o TIMEOUT vaza container. Saída não-zero o `--rm` já removeu, e
        // colher ali custava um fork/exec do CLI do Docker por nada: 0,11 s e
        // 22 MB de RSS, disparados justamente no momento que o incidente de
        // 19/10 registra como 166 MiB livres e load 6,85 — e sem nem deixar
        // linha de log, porque o callback só loga quando dá certo.
        //
        // `signal` separa os dois: timeout chega como
        // `{code: null, signal: 'SIGTERM', killed: true}`; saída não-zero como
        // `{code: 3, signal: null, killed: false}`.
        // ⚠️ O predicado é "o processo SAIU sozinho?", não "houve sinal?".
        //
        // `typeof err.code === 'number'` só acontece quando o container
        // terminou com status próprio — e aí o `--rm` já removeu. Todo o resto
        // é cliente morto por nós, com o container vivo do outro lado:
        //
        //   saída não-zero   code=3                                signal=null
        //   timeout          code=null                             signal=SIGTERM
        //   maxBuffer        code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER signal=undefined
        //   binário ausente  code=ENOENT                           signal=undefined
        //
        // A primeira versão testava só `signal`, e o maxBuffer passava batido
        // (medido: `signal` vem undefined) — o chromium ficava vivo até a
        // varredura de 5 minutos. Achado do review adversarial do Codex em
        // 20/10/2026. No ENOENT não há container e o `rm -f` erra sem
        // consequência, que é o preço certo a pagar pela regra simples.
        const sinal = err.signal;
        const saiuSozinho = typeof err.code === 'number';
        if (!saiuSozinho) {
          colheContainer(opts.nome);
          // ⚠️ Rede de segunda chance, armada AQUI e uma vez só.
          //
          // A primeira versão varria a cada 60 s, para sempre, e isso era um
          // fork/exec de 22 MB do CLI do docker caindo 1 a 3 vezes DENTRO de
          // cada execução de script (um script leva ~87 s típicos, 180 s no
          // teto) — na mesma VM de 2 núcleos e no exato caminho que este módulo
          // existe para proteger. 1440 invocações por dia, inclusive em
          // instalação que nunca subiu container de script.
          //
          // O one-shot é EQUIVALENTE porque `rodaScript` é o único dono de
          // spawn: um container só vaza onde a colheita foi tentada, e é
          // justamente aqui. Se o processo morrer antes disso, quem cobre é o
          // `cleanupOrphans()` da subida. Regime permanente: zero `docker ps`.
          const t = setTimeout(
            () => colheScriptsEsquecidos(),
            IDADE_DE_ORFAO_MS,
          );
          // Não segura o processo no ar só por causa da rede.
          t.unref?.();
        }
        resolve({
          stdout,
          stderr,
          timeout: !!sinal,
          erro: [
            err.message,
            sinal ? `signal=${sinal}` : '',
            stderr.trim().slice(-800),
          ]
            .filter(Boolean)
            .join(' · '),
        });
      },
    );
  });
}

/**
 * Mata e remove o container, se ele ainda estiver de pé.
 *
 * Melhor esforço: se já saiu, `--rm` cuidou dele e o `rm -f` erra sem
 * consequência. O que não pode é o caminho de erro terminar sem ninguém ter
 * tentado.
 */
export function colheContainer(nome: string): void {
  // Mesma validação de `stopContainer`, agora pela função dele: o nome entra
  // numa linha de comando.
  if (!nomeValidoDeContainer(nome)) {
    logger.warn({ container: nome }, 'script: nome de container recusado');
    return;
  }
  // ⚠️ Não reusa `stopContainer` de propósito: ele é `execSync`, e isto roda no
  // caminho de erro de uma requisição de paciente — travar o loop de eventos
  // por até um segundo ali atrasa TODAS as conversas, não só a que falhou.
  execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', nome], (err) => {
    if (!err) {
      logger.warn({ container: nome }, 'script: container colhido após falha');
    }
  });
}

/**
 * Varredura periódica dos containers de script esquecidos.
 *
 * ⚠️ Por que NÃO pendurar `cleanupOrphans()` num tique, que é o conselho
 * óbvio: ela derruba todo container com o prefixo `nanoclaw-`, e isso inclui os
 * containers de AGENTE VIVOS. Na subida do processo é inofensivo, porque nada
 * nosso deveria estar rodando; a cada minuto, mataria conversa de paciente no
 * meio. Esta função filtra por `PREFIXO_DE_SCRIPT` e exige idade mínima.
 *
 * A idade é o que a torna segura: um container de script mais velho que o
 * timeout do host é, por definição, um que ninguém está mais esperando. É a
 * rede que pega o órfão de quem esquecer de colher — e alguém esquece, como
 * `audio-transcribe.ts` mostra.
 */
/**
 * Idade a partir da qual um container de script é órfão por definição.
 *
 * ⚠️ DERIVADO dos tempos limite reais, não um literal. A primeira versão
 * passava `300_000` na chamada, com o comentário dizendo "o teto é o maior
 * timeout de script (180 s) com folga" — a relação existia só na prosa, e
 * levantar `VAGAS_TIMEOUT_MS` deixaria o piso de ser teto em silêncio.
 *
 * Lê as mesmas variáveis que os scripts leem. O dobro é a folga: um container
 * vivo além do dobro do tempo que alguém esperaria por ele não tem mais ninguém
 * esperando.
 */
export const IDADE_DE_ORFAO_MS =
  2 *
  Math.max(
    Number(process.env.VAGAS_TIMEOUT_MS) || 180_000,
    Number(process.env.STT_TIMEOUT_MS) || 90_000,
    90_000, // `paciente.ts`, fixo no código
  );

export function colheScriptsEsquecidos(
  idadeMinimaMs: number = IDADE_DE_ORFAO_MS,
): void {
  execFile(
    CONTAINER_RUNTIME_BIN,
    // ⚠️ `psArgs` de `container-runtime.ts`, não a linha de comando montada
    // aqui. `.claude/skills/convert-to-apple-container/SKILL.md` nomeia
    // exatamente este `docker ps --filter` como passo de migração, e a skill
    // edita `container-runtime.ts`. Com a chamada montada aqui, depois da
    // migração esta varredura devolveria vazio e cegaria em SILÊNCIO — que é o
    // modo de falha do `inspiring_hofstadter`, recriado pela migração.
    psArgs(PREFIXO_DE_SCRIPT, '{{.Names}}\t{{.CreatedAt}}'),
    (err, stdout) => {
      if (err) return;
      const agora = Date.now();
      for (const linha of stdout.trim().split('\n').filter(Boolean)) {
        const [nome, criadoEm] = linha.split('\t');
        if (!nome || !criadoEm) continue;
        const criado = Date.parse(criadoEm);
        if (Number.isNaN(criado)) continue;
        if (agora - criado < idadeMinimaMs) continue;
        logger.warn(
          { container: nome, idadeS: Math.round((agora - criado) / 1000) },
          'script: container esquecido, colhendo na varredura',
        );
        colheContainer(nome);
      }
    },
  );
}
