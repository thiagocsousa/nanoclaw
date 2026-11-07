import { describe, it, expect } from 'vitest';

import {
  VigiaDeDescriptografia,
  contaParaVigia,
} from './vigia-descriptografia.js';

const T0 = 1_762_500_000_000; // instante arbitrário, só precisa ser estável

describe('contaParaVigia', () => {
  it('conversa de gente conta', () => {
    expect(contaParaVigia('558699635479@s.whatsapp.net')).toBe(true);
    expect(contaParaVigia('130520398753941@lid')).toBe(true);
    expect(contaParaVigia('120363287717747603@g.us')).toBe(true);
  });

  it('status e newsletter não contam', () => {
    // Entregam evento sem conteúdo por desenho — não são mensagem perdida.
    expect(contaParaVigia('status@broadcast')).toBe(false);
    expect(contaParaVigia('120363154081218773@newsletter')).toBe(false);
    expect(contaParaVigia('')).toBe(false);
  });
});

describe('VigiaDeDescriptografia', () => {
  it('falha sem versão legível vira aviso depois da graça', () => {
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('A1', '558699635479@s.whatsapp.net', T0);

    expect(v.expirados(T0 + 59_999)).toEqual([]);
    expect(v.expirados(T0 + 60_000)).toEqual([
      { id: 'A1', jid: '558699635479@s.whatsapp.net', esperaMs: 60_000 },
    ]);
  });

  it('recuperada na retentativa não avisa', () => {
    // 262 dos 604 ids medidos em 07/11 se recuperaram assim. Avisar na
    // primeira falha erraria em 43% dos casos.
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('A1', '558699635479@s.whatsapp.net', T0);
    expect(v.chegou('A1')).toBe(true);
    expect(v.expirados(T0 + 600_000)).toEqual([]);
  });

  it('retentativa repetida não adia o aviso', () => {
    // O baileys repete o mesmo id 8 a 12 vezes. Se cada repetição renovasse o
    // prazo, a mensagem que ele repete sem parar nunca venceria.
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('A1', '558699635479@s.whatsapp.net', T0);
    for (let i = 1; i <= 12; i++) {
      v.falhou('A1', '558699635479@s.whatsapp.net', T0 + i * 10_000);
    }
    const fora = v.expirados(T0 + 60_000);
    expect(fora).toHaveLength(1);
    expect(fora[0].esperaMs).toBe(60_000);
  });

  it('avisa uma vez só', () => {
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('A1', '558699635479@s.whatsapp.net', T0);
    expect(v.expirados(T0 + 60_000)).toHaveLength(1);
    expect(v.expirados(T0 + 120_000)).toEqual([]);
  });

  it('chegada de id que nunca falhou não é recuperação', () => {
    const v = new VigiaDeDescriptografia(60_000);
    expect(v.chegou('nunca-falhou')).toBe(false);
    expect(v.chegou('')).toBe(false);
  });

  it('status não entra na lista nem com id válido', () => {
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('A1', 'status@broadcast', T0);
    v.falhou('A2', '120363154081218773@newsletter', T0);
    expect(v.aguardando).toBe(0);
    expect(v.expirados(T0 + 600_000)).toEqual([]);
  });

  it('evento sem id é ignorado', () => {
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('', '558699635479@s.whatsapp.net', T0);
    expect(v.aguardando).toBe(0);
  });

  it('não cresce além do teto, descartando o mais antigo', () => {
    const v = new VigiaDeDescriptografia(60_000, 3);
    for (let i = 1; i <= 5; i++) {
      v.falhou(`A${i}`, '558699635479@s.whatsapp.net', T0 + i);
    }
    expect(v.aguardando).toBe(3);
    const ids = v.expirados(T0 + 600_000).map((p) => p.id);
    expect(ids).toEqual(['A3', 'A4', 'A5']);
  });

  it('não depende da ordem de inserção ser cronológica', () => {
    // `Date.now()` anda para trás (ajuste de relógio na VM). Se a varredura
    // parasse no primeiro não-vencido, a falha antiga atrás de uma recente
    // ficaria presa para sempre.
    const v = new VigiaDeDescriptografia(60_000);
    v.falhou('RECENTE', '558699635479@s.whatsapp.net', T0 + 100_000);
    v.falhou('ANTIGA', '558681142212@s.whatsapp.net', T0);

    const fora = v.expirados(T0 + 60_000);
    expect(fora.map((p) => p.id)).toEqual(['ANTIGA']);
    expect(v.aguardando).toBe(1);
  });

  it('cada instância é independente (principal e atendimento)', () => {
    const principal = new VigiaDeDescriptografia(60_000);
    const atendimento = new VigiaDeDescriptografia(60_000);
    principal.falhou('A1', '558699635479@s.whatsapp.net', T0);
    expect(atendimento.chegou('A1')).toBe(false);
    expect(atendimento.aguardando).toBe(0);
    expect(principal.aguardando).toBe(1);
  });
});
