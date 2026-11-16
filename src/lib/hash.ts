/**
 * SHA-256 para deduplicação de importações OFX (ARQ-003).
 * Node (testes): globalThis.crypto.subtle. Hermes: expo-crypto.
 */

export async function sha256Hex(input: string): Promise<string> {
  const g = globalThis as unknown as {
    crypto?: { subtle?: { digest: (alg: string, data: Uint8Array) => Promise<ArrayBuffer> } };
  };
  if (g.crypto && g.crypto.subtle && typeof TextEncoder !== 'undefined') {
    const data = new TextEncoder().encode(input);
    const buf = await g.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExpoCrypto = require('expo-crypto');
    return (await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      input
    )) as string;
  } catch {
    throw new Error('Nenhuma implementação de SHA-256 disponível neste runtime');
  }
}
