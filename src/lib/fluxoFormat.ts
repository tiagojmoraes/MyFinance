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

/** Linha ÚNICA "Orçado X • Previsto Y (p1%) • Gasto Z (p2%)" — a porcentagem
 *  é POR MOVIMENTO: fatia do valor sobre o total movimentado (previsto + gasto).
 *  Ex.: Orçado 350,00, Previsto 160,00, Gasto 0,00 → 100% / 0%.
 *       Orçado 350,00, Previsto 250,00, Gasto 100,00 → 71% / 29%. */
export function orcadoPrevistoGastoLinha(orcado: number, previsto: number, gasto: number): string {
  const movimento = previsto + gasto;
  return `Orçado ${formatBRL(orcado)} • Previsto ${formatBRL(previsto)} (${pctOf(previsto, movimento)}%) • Gasto ${formatBRL(gasto)} (${pctOf(gasto, movimento)}%)`;
}
