/**
 * nfceGate — v40.1: O PORTÃO do acesso ao portal da SEFAZ-SP.
 *
 * O QUE O LOG DO APARELHO (v40) REVELOOU:
 *   3 recargas do mesmo canal no MESMO segundo e 4 rajadas de consulta em
 *   45 s. Acesso em rajada é EXATAMENTE o padrão de robô que o firewall F5
 *   bloqueia — cada tentativa furiosa estende o banimento do IP. Não existe
 *   portal nacional de NFC-e (a consulta é sempre no portal da UF emissora;
 *   os webservices oficiais exigem certificado e-CNPJ de contribuinte), então
 *   o caminho novo não é outro servidor: é PARAR DE ALIMENTAR O BLOQUEIO.
 *
 * O QUE ESTE MÓDULO GARANTE:
 *   1. ESPAÇO MÍNIMO entre acessos ao portal (gate): nenhum load/reload
 *      acontece a menos de MIN_GAP_MS do anterior — em qualquer canal,
 *      qualquer caminho do código;
 *   2. COOLDOWN após falha total (anti-ban): se TODOS os canais forem
 *      recusados, novas consultas ficam FECHADAS por um tempo que cresce a
 *      cada falha seguida (1 → 1 min, 2 → 3 min, 3+ → 10 min). O IP "esfria"
 *      e o app para de martelar;
 *   3. RESET no sucesso: a nota abriu? o contador de falhas volta a zero.
 *
 * Módulo 100% PURO (estado injetado, `now` injetado) — testável sem RN.
 * O singleton `nfcePortalGate` guarda o estado em memória do app (fechar o
 * app zera — aceitável: o portal também esfria com o tempo).
 */

/** Espaço mínimo REAL entre dois acessos ao portal (jitter já existe no chamador; este é a trava global). */
export const MIN_GAP_MS = 2_500;

/**
 * Cooldown após falha TOTAL (todos os canais recusados), por falha seguida:
 * 1ª falha → 1 min; 2ª seguida → 3 min; 3ª ou mais → 10 min (teto).
 * Base factual: bloqueios do F5 costumam cair em minutos; martelar renova o ban.
 */
export const BLOCK_BACKOFF_MS = [60_000, 180_000, 600_000];

export interface NfceGateState {
  /** epoch (ms) do último acesso efetivo ao portal. */
  lastHitAt: number;
  /** falhas totais seguidas (0 = última consulta abriu a nota ou nada falhou). */
  failStreak: number;
  /** epoch (ms) até o qual novas consultas estão FECHADAS (0 = aberto). */
  blockedUntil: number;
}

export function initialGateState(): NfceGateState {
  return { lastHitAt: 0, failStreak: 0, blockedUntil: 0 };
}

export type GateDecision =
  | { ok: true }
  | { ok: false; waitMs: number; motivo: 'gap' | 'cooldown' };

/** Posso acessar o portal AGORA? (decisão pura — nunca efeitos colaterais) */
export function gateDecision(state: NfceGateState, now: number): GateDecision {
  if (state.blockedUntil > now) {
    return { ok: false, waitMs: state.blockedUntil - now, motivo: 'cooldown' };
  }
  const since = now - state.lastHitAt;
  if (state.lastHitAt > 0 && since < MIN_GAP_MS) {
    return { ok: false, waitMs: MIN_GAP_MS - since, motivo: 'gap' };
  }
  return { ok: true };
}

/** Um acesso saiu de fato (load/reload real) — registra para o próximo respeitar o espaço. */
export function gateMarkHit(state: NfceGateState, now: number): void {
  state.lastHitAt = now;
}

/**
 * TODOS os canais recusados — fecha o portão pelo tempo do backoff.
 * Devolve quanto tempo ficou fechado (para a tela mostrar o contador).
 */
export function gateMarkAllRejected(
  state: NfceGateState,
  now: number
): { blockedUntil: number; waitMs: number; streak: number } {
  const streak = Math.min(state.failStreak + 1, BLOCK_BACKOFF_MS.length);
  state.failStreak = streak;
  const waitMs = BLOCK_BACKOFF_MS[streak - 1];
  state.blockedUntil = now + waitMs;
  return { blockedUntil: state.blockedUntil, waitMs, streak };
}

/** A nota abriu — histórico limpo (o próximo bloqueio recomeça no 1 min). */
export function gateMarkSuccess(state: NfceGateState, now: number): void {
  state.failStreak = 0;
  state.blockedUntil = 0;
  state.lastHitAt = now;
}

/**
 * Singleton do app: MESMO estado para NfceWebFetch (tela visível),
 * NfceService e qualquer tela — o portão é único por aparelho.
 */
export const nfcePortalGate = {
  state: initialGateState(),
  canHit(now: number = Date.now()): GateDecision {
    return gateDecision(this.state, now);
  },
  markHit(now: number = Date.now()): void {
    gateMarkHit(this.state, now);
  },
  markAllRejected(now: number = Date.now()) {
    return gateMarkAllRejected(this.state, now);
  },
  markSuccess(now: number = Date.now()): void {
    gateMarkSuccess(this.state, now);
  },
  /** Segundos restantes de bloqueio (0 = aberto) — para telas/contadores. */
  blockedSecondsLeft(now: number = Date.now()): number {
    return Math.max(0, Math.ceil((this.state.blockedUntil - now) / 1000));
  },
};
