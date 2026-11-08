/**
 * nfceGate v40.1 — o PORTÃO anti-rajada/anti-ban do portal da SEFAZ-SP.
 *
 * Cenários derivados do LOG REAL do aparelho (v40): 2 reloads no mesmo
 * segundo por canal e 4 rajadas de consulta em 45 s — exatamente o padrão
 * de robô que o firewall F5 pune estendendo o bloqueio do IP.
 */
import {
  initialGateState,
  gateDecision,
  gateMarkHit,
  gateMarkAllRejected,
  gateMarkSuccess,
  nfcePortalGate,
  MIN_GAP_MS,
  BLOCK_BACKOFF_MS,
} from '../lib/nfceGate';

const T0 = 1_700_000_000_000; // epoch de referência (ms)

describe('nfceGate — espaço mínimo entre acessos (anti-rajada)', () => {
  test('1º acesso da vida é liberado', () => {
    const s = initialGateState();
    expect(gateDecision(s, T0)).toEqual({ ok: true });
  });

  test('2º acesso ANTES do espaço mínimo → espera com motivo gap', () => {
    const s = initialGateState();
    gateMarkHit(s, T0);
    const d = gateDecision(s, T0 + MIN_GAP_MS - 500);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.motivo).toBe('gap');
      expect(d.waitMs).toBe(500);
    }
  });

  test('2º acesso DEPOIS do espaço mínimo → liberado', () => {
    const s = initialGateState();
    gateMarkHit(s, T0);
    expect(gateDecision(s, T0 + MIN_GAP_MS + 1)).toEqual({ ok: true });
  });

  test('recargas que o app agendou em rajada ficam atrasadas uma a uma', () => {
    // simula o bug visto no log: 3 reloads agendados para o mesmo instante
    const s = initialGateState();
    gateMarkHit(s, T0);
    const p1 = gateDecision(s, T0 + 50);
    expect(p1.ok).toBe(false); // 1º reload atrasado
    const espera = !p1.ok ? p1.waitMs : 0;
    gateMarkHit(s, T0 + espera); // reload 1 executa quando o portão abre
    const p2 = gateDecision(s, T0 + espera + 50);
    expect(p2.ok).toBe(false); // 2º reload também atrasado
  });
});

describe('nfceGate — cooldown anti-ban após falha total', () => {
  test('1ª falha total fecha 1 min', () => {
    const s = initialGateState();
    const r = gateMarkAllRejected(s, T0);
    expect(r.waitMs).toBe(BLOCK_BACKOFF_MS[0]);
    expect(s.blockedUntil).toBe(T0 + BLOCK_BACKOFF_MS[0]);
    expect(gateDecision(s, T0 + 1000).ok).toBe(false);
  });

  test('2ª falha seguida fecha 3 min', () => {
    const s = initialGateState();
    gateMarkAllRejected(s, T0);
    // falha de novo logo depois (o gate ainda estava fechado — o usuário
    // forçou outra consulta e ela também falhou)
    const r2 = gateMarkAllRejected(s, T0 + 5000);
    expect(r2.waitMs).toBe(BLOCK_BACKOFF_MS[1]);
    expect(r2.streak).toBe(2);
  });

  test('3ª falha seguida fecha 10 min — e é o TETO', () => {
    const s = initialGateState();
    gateMarkAllRejected(s, T0);
    gateMarkAllRejected(s, T0 + 1000);
    const r3 = gateMarkAllRejected(s, T0 + 2000);
    expect(r3.waitMs).toBe(BLOCK_BACKOFF_MS[2]);
    const r4 = gateMarkAllRejected(s, T0 + 3000);
    expect(r4.waitMs).toBe(BLOCK_BACKOFF_MS[2]);
    expect(r4.streak).toBe(3);
  });

  test('durante o cooldown, o motivo é cooldown (não gap)', () => {
    const s = initialGateState();
    gateMarkAllRejected(s, T0);
    const d = gateDecision(s, T0 + 1000);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.motivo).toBe('cooldown');
  });

  test('cooldown expira → portão abre de novo', () => {
    const s = initialGateState();
    gateMarkAllRejected(s, T0);
    const d = gateDecision(s, T0 + BLOCK_BACKOFF_MS[0] + 1);
    expect(d.ok).toBe(true);
  });

  test('sucesso (nota abriu) zera falhas — próximo bloqueio recomeça no 1 min', () => {
    const s = initialGateState();
    gateMarkAllRejected(s, T0);
    gateMarkAllRejected(s, T0 + 1000);
    gateMarkSuccess(s, T0 + 2000);
    expect(s.failStreak).toBe(0);
    expect(s.blockedUntil).toBe(0);
    const r = gateMarkAllRejected(s, T0 + 3000);
    expect(r.waitMs).toBe(BLOCK_BACKOFF_MS[0]);
  });

  test('gateMarkSuccess também serve de último hit (espaço mínimo vale a seguir)', () => {
    const s = initialGateState();
    gateMarkSuccess(s, T0);
    const d = gateDecision(s, T0 + 100);
    expect(d.ok).toBe(false);
  });
});

describe('nfcePortalGate — singleton do app', () => {
  test('estado inicial aberto; falha total fecha; expira e reabre', () => {
    nfcePortalGate.state = initialGateState();
    expect(nfcePortalGate.blockedSecondsLeft(T0)).toBe(0);
    nfcePortalGate.markAllRejected(T0);
    expect(nfcePortalGate.blockedSecondsLeft(T0 + 500)).toBe(60);
    nfcePortalGate.state.blockedUntil = T0 + 2_500; // simula o tempo passando
    expect(nfcePortalGate.blockedSecondsLeft(T0 + 2_000)).toBe(1);
    nfcePortalGate.state.blockedUntil = 0;
    expect(nfcePortalGate.canHit(T0 + 3_000)).toEqual({ ok: true });
  });
});
