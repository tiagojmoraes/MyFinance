export function availableForWishlistAtMonthEnd(
  balanceCents: number,
  budgetRemainingCents: number
): number {
  return Math.max(0, balanceCents - Math.max(0, budgetRemainingCents));
}

export function removeClosingMonthOpening(
  balanceByDay: Record<string, number>,
  openingBalanceCents: number,
  closingMode: boolean
): Record<string, number> {
  const opening = closingMode ? Math.max(0, openingBalanceCents) : 0;
  if (opening === 0) return balanceByDay;

  return Object.fromEntries(
    Object.entries(balanceByDay).map(([date, balance]) => [date, balance - opening])
  );
}

export function remainderAfterWishlistAtMonthEnd(input: {
  balanceCents: number;
  budgetRemainingCents: number;
  monthlySavingsCents: number;
  wishlistOutstandingCents: number;
}): number {
  const afterBudget = input.balanceCents - Math.max(0, input.budgetRemainingCents);
  const wishlistAllocation = Math.min(
    Math.max(0, afterBudget),
    Math.max(0, input.wishlistOutstandingCents)
  );
  return afterBudget - wishlistAllocation - Math.max(0, input.monthlySavingsCents);
}

export function applyMonthEndBalanceHierarchy(input: {
  balanceCents: number;
  budgetRemainingCents: number;
  monthlySavingsCents: number;
  wishlistOutstandingCents: number;
  closingMode: boolean;
}): number {
  const remainder = remainderAfterWishlistAtMonthEnd(input);
  return input.closingMode && remainder > 0 ? 0 : remainder;
}

/**
 * v89 (BUG relatado) — "Saldo do dia" EXIBIDO: a compensação da POUPANÇA
 * (getMonthFluxAdjust) SAIU do número que o usuário vê.
 *
 * Antes: a transferência efetivada/previsa para a poupança (conta destino
 * fora do escopo do Fluxo) era DEVOLVIDA ao saldo do dia — o dinheiro "não
 * saía" do número. Resultado: lançar a Poupança Mensal com dia ANTERIOR ao
 * último lançamento não mexia no saldo ("calculava o mesmo valor"), e a
 * devolução se repetia em TODOS os meses subsequentes (nunca expirava).
 *
 * Regra nova: o Saldo do dia é o dinheiro DISPONÍVEL — a transferência para
 * a poupança DIMINUI o número (Efetivado e Previsto), como qualquer despesa.
 * A compensação continua existindo, mas SÓ para os cálculos internos de
 * "sobra do mês" (estimativa do Fechamento e capacidade da Programação de
 * Compra) — lá o dinheiro da poupança não pode abater a si mesmo.
 *
 * O ajuste do ORÇAMENTO (budAdj) continua entrando no número exibido.
 */
export function mergeDailyAdjust(
  base: Record<string, number>,
  budAdj: Record<string, number> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  const days = new Set([...Object.keys(base), ...Object.keys(budAdj ?? {})]);
  for (const d of days) out[d] = (base[d] ?? 0) + (budAdj?.[d] ?? 0);
  return out;
}
