/**
 * NfcePortao — v100: portão anti-ban da leitura NFC-e (100% puro, testável).
 *
 * Evidência dos testes de 20/11/2026:
 *  · o contador de consultas do F5 é por SESSÃO — sessão nova lê de novo na
 *    hora (por isso rejeição isolada NÃO gera cooldown: o incognito do motor
 *    já entrega a sessão seguinte limpa);
 *  · rejeição que se REPETE com sessões novas é indício de punição de IP —
 *    aí sim backoff crescente (60 s → 180 s → 600 s);
 *  · consultas em rajada martelam o portal — gap mínimo de 3 s entre leituras.
 */
export const NFCE_GAP_MS = 3_000;
export const NFCE_COOLDOWN_STEPS_MS = [60_000, 180_000, 600_000];

export class NfcePortao {
  private lastStart = 0;
  private rejectionStreak = 0;
  private cooldownUntil = 0;
  private cooldownStep = 0;

  /** Quanto ainda falta para poder consultar (0 = liberado). */
  waitRemaining(now: number = Date.now()): number {
    if (now < this.cooldownUntil) return this.cooldownUntil - now;
    return Math.max(0, this.lastStart + NFCE_GAP_MS - now);
  }

  /** Motivo do bloqueio atual (para o rodapé da tela). */
  blockedReason(now: number = Date.now()): string | null {
    const ms = this.waitRemaining(now);
    if (ms <= 0) return null;
    if (now < this.cooldownUntil) {
      return `bloqueio da SEFAZ (rede recusada) — tente em ${Math.ceil(ms / 1000)}s`;
    }
    return `aguardando espaçamento (${Math.ceil(ms / 1000)}s)`;
  }

  /** Marca o início de uma consulta. */
  registerStart(now: number = Date.now()): void {
    this.lastStart = now;
  }

  registerSuccess(_now: number = Date.now()): void {
    this.rejectionStreak = 0;
    this.cooldownStep = 0;
    this.cooldownUntil = 0;
  }

  /**
   * Registra rejeição e devolve o cooldown aplicado (0 = nenhum).
   * 1ª rejeição: 0 (a sessão nova já nasce limpa com o incognito).
   * 2ª consecutiva: backoff crescente — provável punição de IP.
   */
  registerRejection(now: number = Date.now()): number {
    this.rejectionStreak += 1;
    if (this.rejectionStreak < 2) return 0;
    const step = Math.min(this.cooldownStep, NFCE_COOLDOWN_STEPS_MS.length - 1);
    const ms = NFCE_COOLDOWN_STEPS_MS[step];
    this.cooldownStep += 1;
    this.cooldownUntil = now + ms;
    return ms;
  }

  /** Isolamento entre testes (singleton é compartilhado). */
  resetForTests(): void {
    this.lastStart = 0;
    this.rejectionStreak = 0;
    this.cooldownUntil = 0;
    this.cooldownStep = 0;
  }
}

/** Singleton usado pelo NfceService e pelos testes. */
export const nfcePortao = new NfcePortao();
