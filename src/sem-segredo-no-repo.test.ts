import { execSync } from 'child_process';
import fs from 'fs';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ Nenhuma senha, token ou chave em texto aberto nos scripts.
 *
 * Nasceu de um achado de 25/10/2026, durante a migração para a Clínica nas
 * Nuvens: a senha do iClinic estava literal em CINCO arquivos de
 * `groups/*​/scripts/`, commitada. A regra do projeto sempre foi OneCLI +
 * `FORWARDED_ENV_VARS`, e mesmo assim passou — porque nada verificava.
 *
 * ⚠️ Isto NÃO limpa o histórico do git. O que já foi commitado continua lá, e
 * a única resposta para isso é ROTACIONAR a credencial. O teste impede a
 * próxima, não desfaz a anterior.
 *
 * O padrão procurado é deliberadamente estreito — atribuição literal a um nome
 * que cheira a segredo. Heurística larga em repositório com muito texto vira
 * ruído, e teste que grita sem motivo é teste que alguém desliga.
 */
describe('nenhum segredo literal nos scripts dos grupos', () => {
  const SUSPEITO =
    /^\s*(?:[A-Z_]*(?:SENHA|PASSWORD|SECRET|TOKEN|API_KEY|APIKEY)[A-Z_]*)\s*=\s*["'][^"']{6,}["']/;

  /**
   * ⚠️ Dívida CONHECIDA, com data. Estes três carregam o token do Meta Ads
   * literal e são de outro domínio (campanhas), fora da migração da clínica de
   * 25/10/2026 — mexer neles hoje seria mudar como campanhas autenticam, sem
   * tempo de testar.
   *
   * A lista existe para a dívida ser VISÍVEL e ENCOLHER, não para ser
   * esquecida: enquanto um nome estiver aqui, está dito que há um segredo em
   * texto aberto esperando conserto. Acrescentar nome novo é admitir uma
   * regressão, e isso tem de doer na revisão.
   */
  const DIVIDA_CONHECIDA = new Set([
    'groups/whatsapp_marina/instagram-posts.sh',
    'groups/whatsapp_marina/meta-ads-publish.sh',
    'groups/whatsapp_marina/meta-ads.sh',
  ]);

  function arquivos(): string[] {
    return execSync('git ls-files groups scripts container', {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(
        (f) =>
          (f.endsWith('.py') || f.endsWith('.mjs') || f.endsWith('.sh')) &&
          !DIVIDA_CONHECIDA.has(f),
      );
  }

  it('a dívida conhecida continua sendo dívida, não some sozinha', () => {
    // Se um destes for consertado, tirar daqui. Se o arquivo sumir, idem.
    for (const f of DIVIDA_CONHECIDA) {
      expect(fs.existsSync(f), `${f} saiu do repo — tire da lista`).toBe(true);
    }
  });

  it('nenhuma atribuição literal de senha/token', () => {
    const achados: string[] = [];
    for (const f of arquivos()) {
      // O WORKING TREE, não o HEAD: o que importa é impedir o PRÓXIMO commit.
      // Lendo do HEAD, um arquivo recém-limpo ainda aparecia sujo e as linhas
      // apontavam para o lugar errado — confuso na hora exata em que a pessoa
      // precisa de clareza.
      let texto = '';
      try {
        texto = fs.readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      texto.split('\n').forEach((linha, i) => {
        // `os.environ.get("X", "default")` não casa: o padrão exige que a
        // atribuição comece com o NOME do segredo.
        if (SUSPEITO.test(linha)) achados.push(`${f}:${i + 1}`);
      });
    }
    expect(achados).toEqual([]);
  });
});
