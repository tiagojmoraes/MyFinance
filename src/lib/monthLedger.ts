/**
 * v16 — livro-razão mensal (month ledger).
 *
 * O saldo de cada dia do Fluxo passa a ser calculado em duas camadas:
 *   1) BASE (já existe hoje em BalanceService.getDailyBalancesDual): contas
 *      do escopo + transações em aberto + parcelas + faturas — soma bruta
 *      das movimentações até a data.
 *   2) HIERARQUIA DE FIM DE MÊS (este arquivo): aplicada UMA VEZ por mês,
 *      Persistida em `month_ledger`, e encadeada — o fechamento de um mês
 *      É a abertura do mês seguinte.
 *
 * Hierarquia, na ordem (regra preservada):
 *   a) Saldo sem poupança = Previsto + Efetivado no dia-alvo,
 *      já com budAdj/savAdj somados.
 *   b) − max(0, orçado − gasto) do mês. O restante volta COMO capacidade
 *      (não é consumo físico de dinheiro), então subtraímos apenas a parte
 *      que NÃO cabe — convenção do código legado.
 *   c) − Programação de Compra (cascade P → N → D), só para o mês
 *      corrente e os futuros (em passado a reserva já é transferência real).
 *   d) − Poupança mensal do mês, uma vez.
 *   e) Resto: se Fechamento ativo e resto > 0, vira poupança de fechamento
 *      e o Previsto do dia-alvo EXIBE 0; senão carrega (positivo = sobra,
 *      negativo = dívida).
 *   f) Efetivado do dia-alvo = saldo_efet − consumo. Invariante:
 *      Previsto − Efetivado = pendências líquidas em aberto.
 */

import type { Ymd, Ym } from './dates';
import { monthAdd, monthOf } from './dates';

/** Versão das regras do livro. Bump invalidar tudo o cache do ledger. */
export const LEDGER_RULES_VERSION = 1;

/** Marca d'água que significa "tudo sujo, recalcular do zero". */
export const DIRTY_ALL = '0000-00';

/** Marca d'água que significa "calcular do zero a partir deste mês". */
export type DirtyFrom = Ym | '0000-00';

/** Entrada para a hierarquia de fechamento (pura — sem IO). */
export interface ClosingHierarchyInput {
  /** Saldo Previsto no dia-alvo, ANTES da hierarquia (com budAdj/savAdj). */
  balancePrevCents: number;
  /** Saldo Efetivado no dia-alvo, ANTES da hierarquia. */
  balanceEfetCents: number;
  /** orçado − gasto, do mês. Se budgets OFF, 0. */
  budgetRemainingCents: number;
  /** Falta total da Programação que cabe no mês (cascade já resolveu). */
  wishlistTotalCents: number;
  /** Poupança mensal do mês, plan ativa ou entry MONTHLY. */
  monthlySavingsCents: number;
  /** Fechamento de Mês ativo e o mês está dentro do regime. */
  closingModeActive: boolean;
  /** true = mês ≥ corrente (cascade da Programação acontece). */
  isCurrentOrFuture: boolean;
}

/** Saída da hierarquia (pura). */
export interface ClosingHierarchyOutput {
  /** max(0, orçado−gasto) — quanto "sobrou" do orçamento (consumido). */
  budgetConsumedCents: number;
  /** Quanto da Programação foi coberta NAQUELE mês. */
  wishlistAllocatedCents: number;
  /** Poupança mensal debitada. */
  savingsMonthlyCents: number;
  /** Poupança de fechamento aplicada (0 se Fechamento off ou resto ≤ 0). */
  savingsClosingCents: number;
  /** Previsto final do mês (carry para o mês seguinte). */
  closingPrevCents: number;
  /** Efetivado final do mês. */
  closingEfetCents: number;
}

/**
 * Resolve a hierarquia pura do fim do mês. Reaproveita a convenção do
 * `monthEndBalance.ts` legado (orçamento + wishlist + poupança mensal) e
 * aplica o Fechamento do Mês (sobra → poupança de fechamento, display 0).
 */
export function applyClosingHierarchy(input: ClosingHierarchyInput): ClosingHierarchyOutput {
  const budgetRemaining = Math.max(0, input.budgetRemainingCents);
  const afterBudget = input.balancePrevCents - budgetRemaining;
  // Programação só vale do mês corrente em diante: em meses passados as
  // reservas são transferências reais e o cascade já está refletido em
  // saldo_base/reserved_cents.
  const wishAlloc = input.isCurrentOrFuture
    ? Math.min(Math.max(0, afterBudget), Math.max(0, input.wishlistTotalCents))
    : 0;
  const afterWish = afterBudget - wishAlloc;
  const monthlySav = Math.max(0, input.monthlySavingsCents);
  const remainderRaw = afterWish - monthlySav;

  let closingSaving = 0;
  let closingPrev = remainderRaw;
  if (input.closingModeActive && remainderRaw > 0) {
    closingSaving = remainderRaw;
    closingPrev = 0;
  }

  // Efetivado: consumo = max(0, balance_antes - carry_final).
  const consumedPrev = Math.max(0, input.balancePrevCents - closingPrev);
  const closingEfet = input.balanceEfetCents - consumedPrev;

  return {
    budgetConsumedCents: budgetRemaining,
    wishlistAllocatedCents: wishAlloc,
    savingsMonthlyCents: monthlySav,
    savingsClosingCents: closingSaving,
    closingPrevCents: closingPrev,
    closingEfetCents: closingEfet,
  };
}

/** Item de wishlist com a falta naquele instante. */
export interface WishItemRef {
  itemId: string;
  classificacao: 'PRIORIDADE' | 'NECESSARIO' | 'DESEJO';
  /** Falta no INÍCIO do mês sendo calculado (= target − reserved até o dia). */
  faltaInicioCents: number;
}

/** Cascade P → N → D em uma capacidade. Devolve a cobertura por item. */
export interface WishItemResult {
  itemId: string;
  classificacao: 'PRIORIDADE' | 'NECESSARIO' | 'DESEJO';
  shortageStartCents: number;
  coveredCents: number;
  shortageEndCents: number;
}

/**
 * Cascade P → N → D POR CAPACIDADE. Cada classe esgota a capacidade antes
 * da seguinte começar; o rateio entre os itens da mesma classe é
 * PROPORCIONAL à `faltaInicioCents` de cada item.
 */
export function cascadeWishlist(
  items: WishItemRef[],
  capacityCents: number
): WishItemResult[] {
  const order: Array<'PRIORIDADE' | 'NECESSARIO' | 'DESEJO'> = [
    'PRIORIDADE',
    'NECESSARIO',
    'DESEJO',
  ];
  let remaining = Math.max(0, capacityCents);
  const out: WishItemResult[] = items.map((i) => ({
    itemId: i.itemId,
    classificacao: i.classificacao,
    shortageStartCents: Math.max(0, i.faltaInicioCents),
    coveredCents: 0,
    shortageEndCents: Math.max(0, i.faltaInicioCents),
  }));
  for (const cls of order) {
    if (remaining <= 0) break;
    const clsItems = out.filter(
      (r) => r.classificacao === cls && r.shortageStartCents > 0
    );
    if (clsItems.length === 0) continue;
    const clsTotal = clsItems.reduce((s, r) => s + r.shortageStartCents, 0);
    if (clsTotal <= 0) continue;
    // quanto cabe na classe — limitado pelo que falta na classe e pelo
    // que ainda resta de capacidade
    const clsCapacity = Math.min(clsTotal, remaining);
    if (clsCapacity <= 0) break;
    // rateio proporcional entre os itens da mesma classe (proporcional à
    // falta inicial; sem centavos restantes — redistribute via largest first)
    const distributed = distributeProportional(
      clsItems.map((r) => r.shortageStartCents),
      clsCapacity
    );
    for (let i = 0; i < clsItems.length; i++) {
      const r = clsItems[i];
      const covered = distributed[i];
      r.coveredCents = covered;
      r.shortageEndCents = r.shortageStartCents - covered;
    }
    remaining -= clsCapacity;
  }
  return out;
}

/**
 * Rateio proporcional sem perder centavos: a maior sobra recebe o ajuste
 * para que a soma fique exata. `weights` em centavos.
 */
function distributeProportional(weights: number[], amount: number): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / total) * amount);
  const floors = exact.map((x) => Math.floor(x));
  let leftover = Math.round(amount - floors.reduce((a, b) => a + b, 0));
  // distribui o resto para os itens com maior fração fracionária
  const order = exact
    .map((x, idx) => ({ idx, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { idx } of order) {
    if (leftover <= 0) break;
    floors[idx] += 1;
    leftover -= 1;
  }
  return floors;
}

/** Min entre dois 'YYYY-MM': '0000-00' sempre vence como mínimo. */
export function minDirty(a: DirtyFrom, b: DirtyFrom): DirtyFrom {
  if (a === DIRTY_ALL || b === DIRTY_ALL) return DIRTY_ALL;
  return a < b ? a : b;
}

/** 'YYYY-MM-DD' do último dia do mês. */
export function lastYmdOf(month: Ym): Ymd {
  const [yStr, mStr] = month.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** Converte qualquer data em mês: usa substr(0,7) — só serve para valores 'YYYY-MM-DD'/'YYYY-MM'. */
export function safeMonthOf(d: string | null | undefined): Ym | null {
  if (!d) return null;
  if (d.length < 7) return null;
  const ym = d.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  return ym;
}

/** Próximo mês em relação a `dirty_from`. */
export function nextMonthAfter(dirty: DirtyFrom): Ym | null {
  if (dirty === DIRTY_ALL) return null;
  return monthAdd(dirty, 1);
}

/** 'YYYY-MM' a partir de 'YYYY-MM-DD' aceitando entrada do mês de hoje. */
export function currentMonthOf(today: string): Ym {
  return monthOf(today);
}

/**
 * Meses a manter no livro (limite de horizonte): de `m0` até `target`,
 * nunca mais que 24 meses no passado além de `m0`.
 */
export function horizonOf(referenceMonth: Ym, m0: Ym, lookbackMax = 24): Ym {
  // m0 é o limite inferior: nada anterior é persistido no ledger.
  // Se m0 > reference − 24, fixa m0 (já é a fronteira histórica).
  const limit = monthAdd(referenceMonth, -lookbackMax);
  return m0 > limit ? m0 : limit;
}

export type { Ym, Ymd };
