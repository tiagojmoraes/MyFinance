/**
 * Utilitários monetários — ARQUIVO ÚNICO DA VERDADE para valores em centavos (ARQ-001).
 * Todos os valores monetários no banco são INTEGER (centavos).
 * v63.1 — reconciliado: fix v52 (negativos) + cache de Intl.NumberFormat (v43/v46).
 */

const _fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const _fmtInput = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Converte entrada de UI ("12,34" | "12.34" | "R$ 12,34") em centavos. */
export function parseMoneyToCents(input: string): number {
  const cleaned = input.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return 0;
  let normalized: string;
  if (cleaned.includes(',')) {
    // Formato pt-BR: 1.234,56
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned;
  }
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return 0;
  // Regra da spec: Math.round(input * 100)
  return Math.round(value * 100);
}

/** Formata centavos para exibição em BRL. */
export function formatBRL(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  return _fmtBRL.format(value);
}

/**
 * Formata centavos para INPUT/valor puro em pt-BR ESTRITO (v7.1):
 * separador de milhar ponto e decimal vírgula — ex.: 123456 -> "1.234,56".
 */
export function formatCentsInput(cents: number): string {
  // v52 FIX — antes Math.max(0, ...) zerava negativos: -5000 virava "0,00". Agora preserva sinal.
  const safe = Math.round(cents || 0);
  return _fmtInput.format(safe / 100);
}

/** Formata centavos sem símbolo (para inputs). */
export function centsToDecimalString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Soma sempre em inteiros (evita float drift). */
export function sumCents(values: number[]): number {
  return values.reduce((acc, v) => acc + (v | 0), 0);
}

/** Divide total em n parcelas de inteiros, com resto na última (sem perder centavos). */
export function divideCents(totalCents: number, n: number): number[] {
  if (n <= 0) return [];
  // v52 FIX — negativo: antes Math.floor(-100/3)=-34 gerava [-34,-34,-32] (diferença 2).
  // Agora: divide o absoluto e aplica o sinal — [-33,-33,-34] (diferença 1, soma exata).
  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;
  const out: number[] = new Array(n).fill(base * sign);
  if (n > 0) out[n - 1] = (base + remainder) * sign;
  return out;
}
