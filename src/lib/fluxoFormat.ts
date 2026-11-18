/**
 * v69 — FORMATO das linhas do Fluxo (funções PURAS, sem React — testáveis).
 */

import { formatBRL } from './money';

/** Porcentagem por movimento, SEMPRE número redondo sem decimal
 *  (ex.: Previsto 250 de 350 movimentados → 71%). */
export function pctOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/** Linha ÚNICA "Orçado X (p1%) • Gasto Z (p2%)" — a porcentagem é POR
 *  MOVIMENTO: fatia de cada valor sobre o total movimentado (orçado + gasto);
 *  mesmo critério do helper antigo (v69), só sem o "Previsto" (v94).
 *  Ex.: Orçado 350,00, Gasto 0,00 → 100% / 0%.
 *       Orçado 350,00, Gasto 100,00 → 78% / 22%. */
export function orcadoGastoLinha(orcado: number, gasto: number): string {
  const movimento = orcado + gasto;
  return `Orçado ${formatBRL(orcado)} (${pctOf(orcado, movimento)}%) • Gasto ${formatBRL(gasto)} (${pctOf(gasto, movimento)}%)`;
}

/** v69 — mantido para compat (lançamentos legados / testes até v94): mesma
 *  regra de fatia, com "Previsto" no meio. A partir de v94 o Fluxo usa
 *  `orcadoGastoLinha`. */
export function orcadoPrevistoGastoLinha(orcado: number, previsto: number, gasto: number): string {
  const movimento = previsto + gasto;
  return `Orçado ${formatBRL(orcado)} • Previsto ${formatBRL(previsto)} (${pctOf(previsto, movimento)}%) • Gasto ${formatBRL(gasto)} (${pctOf(gasto, movimento)}%)`;
}
