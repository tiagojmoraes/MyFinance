/**
 * Geração de IDs UUID v4 — funciona em Node (testes) e Hermes/Expo (runtime).
 * Em Hermes, globalThis.crypto.randomUUID não existe; caímos para expo-crypto.
 */

export function genId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExpoCrypto = require('expo-crypto');
    if (ExpoCrypto && typeof ExpoCrypto.randomUUID === 'function') {
      return ExpoCrypto.randomUUID() as string;
    }
  } catch {
    // ambiente sem expo-crypto (ex.: Node antigo) — fallback abaixo
  }
  // Fallback v4 baseado em Math.random (apenas último recurso)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
