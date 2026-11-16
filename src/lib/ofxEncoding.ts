/**
 * Leitura de arquivo OFX com o ENCODING CERTO (v87).
 *
 * O OFX dos bancos brasileiros vem quase sempre em ISO-8859-1/CP1252.
 * Lido como UTF-8, cada byte acentuado vira U+FFFD (�) e o limpador do
 * parser troca por ESPAÇO — "AÇOUGUE" virava "A OUGUE": o texto do lançamento
 * ficava ilegível e o casamento automático por similaridade degradava.
 *
 * Estratégia (sem dependência nova):
 *  1) lê o arquivo como UTF-8;
 *  2) se NÃO apareceu o caractere de substituição (� = byte inválido), o
 *     arquivo era UTF-8 mesmo — devolve o texto;
 *  3) se apareceu, relê o arquivo em BASE64 e devolve os bytes lidos como
 *     Latin-1/CP1252 (o que o banco gravou).
 */

/** Base64 → bytes (sem dependência de Buffer/Buffer não existe no RN). */
export function base64ParaBytes(b64: string): number[] {
  const limpo = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < limpo.length; i += 4) {
    const c1 = limpo.charCodeAt(i);
    const c2 = limpo.charCodeAt(i + 1);
    const c3 = limpo.charCodeAt(i + 2);
    const c4 = limpo.charCodeAt(i + 3);
    const n =
      (valorBase64(c1) << 18) |
      (valorBase64(c2) << 12) |
      ((isBase64Valido(c3) ? valorBase64(c3) : 0) << 6) |
      (isBase64Valido(c4) ? valorBase64(c4) : 0);
    bytes.push((n >> 16) & 0xff);
    if (isBase64Valido(c3)) bytes.push((n >> 8) & 0xff);
    if (isBase64Valido(c4)) bytes.push(n & 0xff);
  }
  return bytes;
}

function isBase64Valido(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47
  );
}

function valorBase64(c: number): number {
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 71;
  if (c >= 48 && c <= 57) return c + 4;
  if (c === 43) return 62;
  if (c === 47) return 63;
  return 0;
}

/** Bytes → texto Latin-1/CP1252 (1 byte = 1 caractere). */
export function bytesParaLatin1(bytes: number[]): string {
  let s = '';
  const passo = 4096;
  for (let i = 0; i < bytes.length; i += passo) {
    s += String.fromCharCode.apply(null, bytes.slice(i, i + passo) as unknown as number[]);
  }
  return s;
}

/** O texto tem byte inválido para UTF-8 (sinal de arquivo Latin-1)? */
export function pareceLatin1(texto: string): boolean {
  return texto.includes('\uFFFD');
}

/** Monta o texto final a partir do UTF-8 lido e (se precisar) do Base64. */
export function textoOfx(utf8: string, base64: string | null): string {
  if (!pareceLatin1(utf8)) return utf8;
  if (!base64) return utf8;
  return bytesParaLatin1(base64ParaBytes(base64));
}
