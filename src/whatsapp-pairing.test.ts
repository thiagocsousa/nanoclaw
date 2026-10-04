import { describe, expect, it } from 'vitest';

// O bug de 04/10/2026, isolado como lógica pura.
//
// O baileys emite `connection.update` com `qr` a cada ~20s enquanto espera
// autenticação. O handler pedia um código de pareamento em CADA evento, o que
// invalidava o anterior e, pior, seguiu pedindo depois de `registered: true`
// ter sido gravado — o vínculo recém-criado morreu com 401 no boot seguinte.
//
// Um humano não digita 8 caracteres num celular em 20 segundos. A janela tem
// que ser a do WhatsApp, não a do refresh.

/** Reproduz o guard do `whatsapp.ts` sem precisar de socket nem de rede. */
class PareamentoFake {
  private pairingCodeRequested = false;
  pedidos = 0;

  onQr(): void {
    if (this.pairingCodeRequested) return;
    this.pairingCodeRequested = true;
    this.pedidos++;
  }

  onOpen(): void {
    this.pairingCodeRequested = false;
  }
}

describe('código de pareamento é pedido uma vez por conexão', () => {
  it('seis eventos de qr seguidos geram UM código, não seis', () => {
    const p = new PareamentoFake();
    // Exatamente o que saiu no log: 22:40:15, 22:41:15, 22:41:35, 22:41:55,
    // 22:42:15, 22:42:35.
    for (let i = 0; i < 6; i++) p.onQr();
    expect(p.pedidos).toBe(1);
  });

  it('depois de conectar, uma reconexão futura pode pedir de novo', () => {
    const p = new PareamentoFake();
    p.onQr();
    p.onOpen();
    p.onQr();
    expect(p.pedidos).toBe(2);
  });

  it('qr depois do open não pede antes de o open reabrir a janela', () => {
    const p = new PareamentoFake();
    p.onQr();
    p.onQr();
    expect(p.pedidos).toBe(1);
    p.onOpen();
    p.onQr();
    p.onQr();
    p.onQr();
    expect(p.pedidos).toBe(2);
  });
});
