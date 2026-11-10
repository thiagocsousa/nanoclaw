import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { PrimeiroOpen } from './primeiro-open.js';

/**
 * O estrago de 09/11/2026: o `resolve` do `connect()` viajava como argumento
 * de `connectInternal(onFirstOpen)`, e a reconexão chamava
 * `this.connectInternal()` sem ele. O pareamento fecha e reconecta, então o
 * primeiro boot depois de parear ficava conectado e MUDO — sem scheduler, sem
 * IPC watcher, sem loop de mensagens — e só um reinício resolvia.
 */
describe('PrimeiroOpen', () => {
  it('dispara no primeiro open', () => {
    const p = new PrimeiroOpen();
    let n = 0;
    p.arma(() => n++);
    expect(p.dispara()).toBe(true);
    expect(n).toBe(1);
  });

  it('SOBREVIVE à reconexão — o caso que quebrou', () => {
    // Sequência real do log: pairing code → Connection closed → Reconnecting
    // → Connected to WhatsApp. O `open` que resolve é o da SEGUNDA conexão.
    const p = new PrimeiroOpen();
    let resolvido = false;
    p.arma(() => {
      resolvido = true;
    });
    // fecha e reconecta sem ninguém repassar nada
    expect(p.armado).toBe(true);
    expect(p.dispara()).toBe(true);
    expect(resolvido).toBe(true);
  });

  it('dispara UMA vez só, por mais opens que venham', () => {
    const p = new PrimeiroOpen();
    let n = 0;
    p.arma(() => n++);
    p.dispara();
    expect(p.dispara()).toBe(false);
    expect(p.dispara()).toBe(false);
    expect(n).toBe(1);
  });

  it('open sem nada armado não explode', () => {
    const p = new PrimeiroOpen();
    expect(p.dispara()).toBe(false);
  });

  it('armado reflete o estado', () => {
    const p = new PrimeiroOpen();
    expect(p.armado).toBe(false);
    p.arma(() => {});
    expect(p.armado).toBe(true);
    p.dispara();
    expect(p.armado).toBe(false);
  });
});

/**
 * A guarda que pega a REINCIDÊNCIA, não o sintoma.
 *
 * O bug não foi uma condição errada: foi uma continuação viajando por
 * parâmetro, que um call site novo esqueceu de repassar — silenciosamente.
 * Enquanto `connectInternal` não aceitar argumento, nenhum call site pode
 * esquecer.
 */
describe('a continuação não viaja por parâmetro', () => {
  const fonte = fs.readFileSync(
    path.join(process.cwd(), 'src/channels/whatsapp.ts'),
    'utf-8',
  );

  it('connectInternal não declara parâmetro', () => {
    const m = fonte.match(/private async connectInternal\(([^)]*)\)/);
    expect(m, 'não achei a declaração de connectInternal').toBeTruthy();
    expect(m![1].trim()).toBe('');
  });

  it('nenhuma chamada a connectInternal passa argumento', () => {
    const chamadas = [...fonte.matchAll(/connectInternal\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((a) => a !== '');
    expect(chamadas, `chamadas com argumento: ${chamadas.join(' | ')}`).toEqual(
      [],
    );
  });

  it('o canal usa o PrimeiroOpen, e arma no connect', () => {
    expect(fonte).toContain("from '../primeiro-open.js'");
    expect(fonte).toContain('this.primeiroOpen.arma(resolve)');
    expect(fonte).toContain('this.primeiroOpen.dispara()');
  });
});
