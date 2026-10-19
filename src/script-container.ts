import { execFile } from 'node:child_process';

import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';

/**
 * Nome e colheita dos containers de script (Playwright no iClinic).
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
 */

/**
 * Um nome por execução, para poder colher depois.
 *
 * ⚠️ O prefixo `nanoclaw-` não é enfeite: `cleanupOrphans()` em
 * `container-runtime.ts` já derruba todo container com esse prefixo, e roda na
 * subida do processo. O coletor existia e estava CEGO — o órfão de uma hora
 * encontrado em 19/10/2026 se chamava `inspiring_hofstadter`, nome aleatório do
 * Docker, porque estes três scripts subiam sem `--name`. Nomear aqui conserta
 * duas coisas de uma vez: a colheita no caminho de erro, abaixo, e a varredura
 * que já existia.
 */
export function nomeiaContainer(rotulo: string): string {
  const unico = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `nanoclaw-script-${rotulo}-${unico}`;
}

/**
 * Limites e ajustes dos containers de script.
 *
 * ⚠️ `--shm-size=1g` não é otimização, é requisito. O Docker dá 64 MB de
 * /dev/shm por padrão, e o chromium usa /dev/shm para a memória compartilhada
 * entre seus processos. Com 64 MB ele não derruba com erro: ele PENDURA.
 *
 * Medido na VM em 19/10/2026: o mesmo `iclinic_paciente_por_telefone.py`, com
 * a carga da máquina já normalizada em 1.70, falhava em
 * `Page.goto: Timeout 30000ms exceeded` em app.iclinic.com.br enquanto um curl
 * da MESMA imagem e da MESMA rede respondia 200 em 2 s. Trocando um único
 * flag — `--shm-size=1g` — o `goto` passou a completar.
 *
 * Isso também é a resposta para o diagnóstico errado que eu defendi antes: o
 * container órfão de uma hora era real e o vazamento era real, mas a carga
 * alta era CONSEQUÊNCIA, não causa. Com load 1.70 o sintoma continuava.
 *
 * ⚠️ Só CPU, de propósito. `--memory` num chromium é troca de sintoma: o
 * limite baixo faz o OOM killer derrubar o navegador no meio da navegação, e
 * o erro que chega é outro igualmente enganoso. A pressão de memória do dia
 * 19/10 vinha de containers ACUMULADOS, e quem resolve isso é a colheita
 * abaixo, não um teto por container.
 *
 * `--cpus 1` num host de 2 CPUs garante que um script desgovernado deixe um
 * núcleo para o host: é o que faltava quando o load bateu 6,85.
 */
export const LIMITES_DE_RECURSO = ['--cpus', '1', '--shm-size=1g'];

/**
 * Mata e remove o container, se ele ainda estiver de pé.
 *
 * Melhor esforço: se já saiu, `--rm` cuidou dele e o `rm -f` erra sem
 * consequência. O que não pode é o caminho de erro terminar sem ninguém ter
 * tentado.
 */
export function colheContainer(nome: string): void {
  // Mesma validação de `stopContainer`: o nome entra numa linha de comando.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(nome)) {
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
