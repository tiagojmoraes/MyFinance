/**
 * v72 — CONSOLIDADO CALCULA O VALOR (pedido do usuário): no Novo Lançamento,
 * o tipo "Consolidado" tem de mostrar o valor calculado do grupo como os
 * outros tipos mostram o deles — atualizando a cada linha digitada.
 *
 * O "Resumo do grupo" passa a somar TODAS as linhas (antes só as À vista
 * entravam no total):
 *  · À vista      → o valor inteiro entra no mês;
 *  · Fixo         → o valor mensal entra todo mês;
 *  · Parcelado    → entra a PARCELA do mês:
 *      - "Parcela fixa"   → o valor digitado (cada parcela é igual);
 *      - "Dividir total"  → a 1ª parcela do reparte (divisão de centavos
 *        com resto na última — a mesma conta do Parcelado simples).
 *
 * Função PURA (sem RN) — testável e reusável pela tela.
 */

import { divideCents } from './money';

export type GrupoDir = 'DEBIT' | 'CREDIT';
export type GrupoModality = 'AVISTA' | 'FIXO' | 'PARCELADO';
export type GrupoPlanMode = 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';

export interface ConsolidatedLineInput {
  dir: GrupoDir;
  cents: number;
  modality: GrupoModality;
  planMode?: GrupoPlanMode;
  parcelas?: string | number | null;
}

/** O que ESTA linha faz entrar no MÊS do grupo (parcela do mês, não o total do plano). */
export function lineMonthlyCents(l: ConsolidatedLineInput): number {
  if (l.cents <= 0) return 0;
  if (l.modality === 'AVISTA' || l.modality === 'FIXO') return l.cents;
  const n = typeof l.parcelas === 'string' ? parseInt(l.parcelas, 10) : l.parcelas ?? 0;
  if (!Number.isInteger(n) || (n as number) < 2) return l.cents; // parcelas inválidas: valor cru
  if (l.planMode === 'FIXED_PER_MONTH') return l.cents;
  return divideCents(l.cents, n as number)[0];
}

export interface GrupoTotals {
  /** Débitos do mês (todas as linhas — à vista, fixa e parcela). */
  debitCents: number;
  /** Créditos do mês (todas as linhas). */
  creditCents: number;
  /** Quantas linhas com valor > 0. */
  lineCount: number;
  /** Linhas Fixo (conta fixa) e Parcelado (plano) com valor — informativo. */
  fixoCount: number;
  parceladoCount: number;
}

/** Totais CALCULADOS do grupo, no esquema do mês (como os outros tipos mostram o valor deles). */
export function consolidatedGroupTotals(lines: ConsolidatedLineInput[]): GrupoTotals {
  let debitCents = 0;
  let creditCents = 0;
  let lineCount = 0;
  let fixoCount = 0;
  let parceladoCount = 0;
  for (const l of lines) {
    if (l.cents <= 0) continue;
    lineCount++;
    if (l.modality === 'FIXO') fixoCount++;
    if (l.modality === 'PARCELADO') parceladoCount++;
    const m = lineMonthlyCents(l);
    if (l.dir === 'DEBIT') debitCents += m;
    else creditCents += m;
  }
  return { debitCents, creditCents, lineCount, fixoCount, parceladoCount };
}
