import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * ⛔ A poda do cache de build roda DEPOIS do build.
 *
 * O `deploy.sh` já podava antes de 11/11/2026 — no passo [7/8], com
 * `--filter until=168h`. E o build do container é o passo [8/8]. Ou seja: a
 * poda limpava o lixo do deploy anterior e poupava, por idade, exatamente o
 * cache que o build seguinte acabava de criar.
 *
 * O resultado foi 9 GB de cache, disco de 20 G em 100%, e o processo seguinte
 * morrendo no boot com `ENOSPC: no space left on device` — sockets abertos,
 * scheduler vivo, loop de mensagens morto, 21 minutos surdo sem ninguém saber.
 * A poda existia; corria no lugar errado da ordem.
 *
 * Este teste é de ORDEM, porque foi a ordem que falhou. E exige teto por
 * TAMANHO: o cache que encheu o disco tinha minutos de vida e sobreviveria a
 * qualquer filtro por idade.
 */
describe('deploy.sh: poda depois do build, com teto por tamanho', () => {
  const fonte = fs.readFileSync(path.resolve('scripts/deploy.sh'), 'utf-8');

  it('existe uma poda DEPOIS do `container/build.sh`', () => {
    const build = fonte.indexOf('bash container/build.sh');
    expect(build, 'não achei o build do container').toBeGreaterThan(-1);
    const depois = fonte.slice(build);
    expect(
      depois,
      'nenhuma poda de builder depois do build — é o bug de 11/11/2026',
    ).toMatch(/docker builder prune/);
  });

  it('a poda de depois tem teto por TAMANHO, não por idade', () => {
    const build = fonte.indexOf('bash container/build.sh');
    const depois = fonte.slice(build);
    const poda = /docker builder prune[^\n]*/.exec(depois)?.[0] ?? '';
    expect(poda, 'poda sem --max-used-space').toContain('--max-used-space');
    expect(
      poda,
      'filtro por idade poupa justamente o cache novo',
    ).not.toContain('until=');
  });

  it('a guarda independente é instalada pelo deploy', () => {
    // Alarme que mora dentro do app morre com o app: em 11/11 o monitor de SLA
    // não avisou porque estava no processo que o ENOSPC derrubou.
    expect(fonte).toContain('scripts/disco-guarda.sh');
    expect(fonte).toMatch(/crontab/);
    expect(fonte).toContain('SystemMaxUse=200M');
  });
});

describe('disco-guarda.sh: cura antes de avisar', () => {
  const guarda = fs.readFileSync(
    path.resolve('scripts/disco-guarda.sh'),
    'utf-8',
  );

  it('poda com teto por tamanho', () => {
    expect(guarda).toContain('--max-used-space');
  });

  it('sai sem fazer nada abaixo do limite', () => {
    expect(guarda).toMatch(/-lt "\$PODA_EM"\s*\]\s*&&\s*exit 0/);
  });

  it('age ANTES de tentar avisar — aviso depende de entrega, cura não', () => {
    const poda = guarda.indexOf('docker builder prune');
    const aviso = guarda.indexOf('ipc/$AVISA_PASTA/messages');
    expect(poda).toBeGreaterThan(-1);
    expect(aviso).toBeGreaterThan(-1);
    expect(
      poda,
      'o aviso vem antes da poda: se a entrega falhar, o disco segue cheio',
    ).toBeLessThan(aviso);
  });
});

describe('as duas armadilhas de 12/11/2026', () => {
  const deploy = fs.readFileSync(path.resolve('scripts/deploy.sh'), 'utf-8');
  const guarda = fs.readFileSync(
    path.resolve('scripts/disco-guarda.sh'),
    'utf-8',
  );

  /**
   * O cron ficou VAZIO no primeiro deploy. Com `set -e`, `crontab -l` sem
   * crontab sai 1 e o `grep -v` com entrada vazia também — o subshell morria
   * antes do `echo`, e `crontab -` recebia nada. O status do pipeline era o do
   * `crontab -` (0), então o deploy reportou sucesso instalando um crontab
   * vazio.
   */
  it('a montagem do cron não morre com set -e', () => {
    const bloco = /ATUAL=\$\(sudo crontab -l[^\n]*\n/.exec(deploy)?.[0] ?? '';
    expect(bloco, 'não achei a montagem do cron').not.toBe('');
    expect(bloco, 'grep sem `|| true` derruba o subshell').toContain('|| true');
  });

  it('o deploy FALHA se o cron não ficou instalado', () => {
    // Promessa não verificada é promessa quebrada em silêncio — foi assim que
    // o crontab vazio passou por sucesso.
    expect(deploy).toMatch(/crontab -l \| grep -q nanoclaw-disco-guarda/);
    expect(deploy).toMatch(/FALHOU: cron da guarda/);
  });

  /**
   * `--max-used-space` só remove registro RECUPERÁVEL. Medido em 12/11: cache
   * de 2,654 GB com 99,93 kB recuperáveis — o teto não tira nada, porque o
   * resto é a imagem viva. O que liberou 7,83 GB no incidente foi `prune -af`.
   */
  it('a guarda escala para prune -af quando o teto não basta', () => {
    expect(
      guarda,
      'sem escalonamento, a guarda liberaria 2,4 GB onde precisava de 7,8',
    ).toMatch(/docker builder prune -af/);
    const teto = guarda.indexOf('--max-used-space');
    const af = guarda.indexOf('prune -af');
    expect(teto).toBeGreaterThan(-1);
    expect(
      af,
      'o -af deve ser o ESCALONAMENTO, não a primeira ação',
    ).toBeGreaterThan(teto);
  });
});
