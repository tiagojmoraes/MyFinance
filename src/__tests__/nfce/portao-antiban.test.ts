import {
  NfcePortao,
  NFCE_GAP_MS,
  NFCE_COOLDOWN_STEPS_MS,
} from '../../services/NfcePortao';

describe('v100 NfcePortao — portão anti-ban', () => {
  test('gap mínimo entre consultas', () => {
    const p = new NfcePortao();
    p.registerStart(1_000);
    expect(p.waitRemaining(1_000 + NFCE_GAP_MS - 1)).toBeGreaterThan(0);
    expect(p.waitRemaining(1_000 + NFCE_GAP_MS)).toBe(0);
  });

  test('1ª rejeição NÃO gera cooldown (sessão nova já nasce limpa)', () => {
    const p = new NfcePortao();
    expect(p.registerRejection(10_000)).toBe(0);
    expect(p.waitRemaining(10_001)).toBe(0);
  });

  test('rejeição repetida entra em backoff crescente 60 s → 180 s → 600 s (teto)', () => {
    const p = new NfcePortao();
    p.registerRejection(1_000);
    expect(p.registerRejection(2_000)).toBe(NFCE_COOLDOWN_STEPS_MS[0]);
    expect(p.waitRemaining(2_001)).toBe(NFCE_COOLDOWN_STEPS_MS[0] - 1);
    p.resetForTests();
    p.registerRejection(1_000);
    p.registerRejection(2_000);
    expect(p.registerRejection(3_000)).toBe(NFCE_COOLDOWN_STEPS_MS[1]);
    p.resetForTests();
    p.registerRejection(1_000);
    p.registerRejection(2_000);
    p.registerRejection(3_000);
    expect(p.registerRejection(4_000)).toBe(NFCE_COOLDOWN_STEPS_MS[2]);
    expect(p.registerRejection(5_000)).toBe(NFCE_COOLDOWN_STEPS_MS[2]); // teto
  });

  test('sucesso zera o ciclo de rejeição e o cooldown', () => {
    const p = new NfcePortao();
    p.registerRejection(1_000);
    p.registerRejection(2_000);
    p.registerSuccess(3_000);
    expect(p.waitRemaining(3_001)).toBe(0);
    expect(p.registerRejection(4_000)).toBe(0);
  });

  test('blockedReason explica o que está esperando', () => {
    const p = new NfcePortao();
    p.registerRejection(1_000);
    p.registerRejection(2_000);
    expect(p.blockedReason(2_500)).toMatch(/bloqueio da SEFAZ/);
    expect(p.blockedReason(2_000 + NFCE_COOLDOWN_STEPS_MS[0])).toBeNull();
  });
});
