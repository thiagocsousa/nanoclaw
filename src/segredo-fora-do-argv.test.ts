import fs from 'fs';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ Nenhum VALOR de credencial entra na linha de comando do container.
 *
 * ## O vazamento, medido em 30/10/2026
 *
 * `buildContainerArgs` passava `-e CHAVE=valor`, e linha de comando não é
 * privada. Na VM da clínica, que tem três usuários:
 *
 *     /proc/<pid>/cmdline   -r--r--r--   qualquer usuário lê
 *     /proc/<pid>/environ   -r--------   só o dono
 *
 * Logado como um usuário comum, sem sudo, um `ps -eo args` devolvia o token do
 * Meta, as quatro chaves do X, TikTok, YouTube, LinkedIn, Cloudinary, FLAGO,
 * 2captcha, o `CNN_CLIENT_SECRET`, a senha do portal da NFS-e e — o pior — o
 * `NFSE_CERT_B64` junto do `NFSE_CERT_PASSWORD`: o certificado A1 da clínica e
 * a senha dele, na mesma linha.
 *
 * Achei por acidente, rodando `ps` para contar processos pendurados. Nenhum
 * teste olhava a forma do argumento, e o `CLAUDE.md` declarava o contrário do
 * que o código fazia ("nenhuma chave ou token é passado aos containers
 * diretamente").
 *
 * ## Por que a forma sem valor resolve
 *
 * `docker run -e CHAVE` (sem `=valor`) herda do ambiente de quem chama. O
 * valor passa a viajar pelo `environ` do processo docker, que o Linux protege
 * com 0400 do dono — e some do `cmdline`, que é world-readable.
 *
 * ## O que este teste trava
 *
 * Que nenhum argumento `-e` carregue um valor que veio do `.env`. Placeholders
 * e variáveis não-secretas (`TZ`, `HOME`, `NANOCLAW_CHAT_JID`) continuam
 * podendo levar valor: o que não pode é SEGREDO.
 */
describe('segredo não entra no argv do container', () => {
  const fonte = fs.readFileSync('src/container-runner.ts', 'utf-8');

  /**
   * As chaves encaminhadas, lidas da própria lista do módulo — não copiadas.
   * Copiar faria o teste parar de cobrir a chave seguinte que alguém adicionar.
   */
  function chavesEncaminhadas(): string[] {
    const bloco = /const FORWARDED_ENV_VARS = \[([\s\S]*?)\n\];/.exec(fonte);
    if (!bloco) throw new Error('não achei FORWARDED_ENV_VARS');
    return [...bloco[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  }

  it('a lista de chaves encaminhadas é encontrável e não está vazia', () => {
    // Se o nome ou a forma da lista mudar, o resto deste arquivo viraria um
    // teste que não testa nada. Melhor falhar aqui, dizendo o porquê.
    expect(chavesEncaminhadas().length).toBeGreaterThan(10);
  });

  it('nenhuma chave encaminhada aparece como `-e CHAVE=` no código', () => {
    const achados: string[] = [];
    for (const chave of chavesEncaminhadas()) {
      // A forma perigosa literal, e a interpolada.
      if (new RegExp(`'-e',\\s*\`?${chave}=`).test(fonte)) achados.push(chave);
    }
    expect(achados).toEqual([]);
  });

  /**
   * ⛔ A forma interpolada genérica — `'-e', \`${key}=${algo}\`` — é a que
   * estava lá, e nenhuma lista de chaves a pegaria, porque o nome da chave é
   * uma variável. Por isso se procura a FORMA, não o nome.
   */
  it('não existe `-e` com interpolação de valor', () => {
    const perigoso = /'-e',\s*`\$\{[^}]+\}=\$\{/.test(fonte);
    expect(perigoso, 'voltou o `-e CHAVE=valor` interpolado').toBe(false);
  });

  it('o detector funciona: reconhece a forma que vazava', () => {
    const antes = "args.push('-e', `${key}=${integrationSecrets[key]}`);";
    expect(/'-e',\s*`\$\{[^}]+\}=\$\{/.test(antes)).toBe(true);
  });

  /**
   * A forma sem valor só funciona se o valor estiver no ambiente de quem chama
   * o docker. O processo do app NÃO recebe o `.env` pelo ambiente — é a mesma
   * pegadinha que criou o `garanteCredenciais` —, então `spawn` TEM de levar um
   * `env` explícito. Sem isto o container sobe sem credencial, calado.
   */
  it('o spawn do container injeta os segredos no ambiente', () => {
    expect(fonte).toMatch(
      /env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.segredosDeIntegracao\(\)/,
    );
  });

  it('as duas pontas leem da MESMA função', () => {
    const usos = [...fonte.matchAll(/segredosDeIntegracao\(\)/g)].length;
    // Uma na declaração do argv, uma no env do spawn. Menos que isso significa
    // que alguma ponta voltou a filtrar por conta própria.
    expect(usos).toBeGreaterThanOrEqual(2);
  });
});
