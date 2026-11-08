/**
 * v25 — ORÁCULO INDEPENDENTE do "Saldo do dia" (Previsto/Efetivado) + utilitários
 * das 400 simulações de datas.
 *
 * O oráculo NÃO usa nenhuma função do BalanceService: relê o banco bruto
 * (accounts/financial_moves/transactions/installments/installment_plans/invoices)
 * e reduz TUDO em JavaScript, dia a dia. Qualquer divergência entre a rotina do
 * app (getDailyBalancesDual) e o oráculo indica bug de cálculo, de acumulação,
 * de âncora ou de reagendamento.
 *
 * Regras do oráculo (spec consolidada v18–v25):
 *  · ESCOPO: contas include_in_general_balance = 1 e não arquivadas.
 *  · EFETIVADO(d) = Σ contas [ âncora ≤ d ? saldo_inicial : 0 ]
 *      + Σ movimentos CONFIRMED da conta com effective_date ∈ [âncora, d],
 *        EXCETO movimento de parcela (installments) ainda PENDING;
 *  · PREVISTO(d) = EFETIVADO(d)
 *      + Σ lançamentos PENDING em conta do escopo (INCOME + / EXPENSE −),
 *        occurred_on ∈ [âncora, d]
 *      + Σ pernas de TRANSFERÊNCIA PENDING (VOIDED): DEBIT − na origem,
 *        CREDIT + no destino, effective_date ∈ [âncora, d]
 *      + Σ parcelas PENDING de planos em CONTA do escopo (sinal do movimento),
 *        effective_date ∈ [âncora, d]
 *      − Σ faturas de cartão não quitadas com due_date ≤ d (saldo devido > 0).
 */

import type { DbDriver } from '../db/types';

/** PRNG determinístico (mulberry32) — simulações reproduzíveis. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T,>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
export const randInt = (r: () => number, min: number, max: number): number =>
  min + Math.floor(r() * (max - min + 1));

/** Meses de 28/29/30/31 dias — a simulação cobre todos os formatos. */
export const lastDayOf = (month: string): number => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const ymd = (month: string, day: number): string =>
  `${month}-${String(day).padStart(2, '0')}`;

export interface Dual {
  efetivado: Record<string, number>;
  previsto: Record<string, number>;
}

/** ORÁCULO — recomputação independente, dia a dia, direto do banco bruto. */
export async function oracleDual(db: DbDriver, month: string): Promise<Dual> {
  const last = lastDayOf(month);
  const accounts = await db.getAllAsync<{ id: string; initial: number; anchor: string | null }>(
    `SELECT id, initial_balance_cents AS initial, initial_balance_date AS anchor
       FROM accounts WHERE include_in_general_balance = 1 AND archived_at IS NULL`
  );
  const ids = accounts.map((a) => a.id);
  const marks = ids.map(() => '?').join(',') || "''";

  // Movimentos das contas do escopo (com status da parcela e da transação)
  const moves = ids.length
    ? await db.getAllAsync<{
        account_id: string;
        direction: string;
        amount_cents: number;
        effective_date: string;
        move_status: string;
        inst_status: string | null;
        tx_status: string | null;
        tx_type: string | null;
      }>(
        `SELECT fm.account_id, fm.direction, fm.amount_cents, fm.effective_date, fm.status AS move_status,
                (SELECT i.status FROM installments i WHERE i.id = fm.installment_id) AS inst_status,
                (SELECT t.status FROM transactions t WHERE t.id = fm.transaction_id) AS tx_status,
                (SELECT t.type FROM transactions t WHERE t.id = fm.transaction_id) AS tx_type
           FROM financial_moves fm
          WHERE fm.account_id IN (${marks})`,
        ids as never
      )
    : [];

  // Pendências simples (à vista/fixa em conta) — card entra pela fatura
  const pendTxs = ids.length
    ? await db.getAllAsync<{ account_id: string; type: string; amount_cents: number; occurred_on: string }>(
        `SELECT account_id, type, amount_cents, occurred_on FROM transactions
          WHERE status = 'PENDING' AND card_id IS NULL AND type IN ('INCOME','EXPENSE')
            AND account_id IN (${marks})`,
        ids as never
      )
    : [];

  // Faturas de cartão não quitadas (sem filtro de âncora — dívida de cartão)
  const invoices = await db.getAllAsync<{ due_date: string; due: number }>(
    `SELECT due_date, MAX(0, total_cents - credit_from_prev_cents - paid_cents) AS due
       FROM invoices
      WHERE due_date IS NOT NULL AND status != 'PAID'
        AND MAX(0, total_cents - credit_from_prev_cents - paid_cents) > 0`
  );

  const out: Dual = { efetivado: {}, previsto: {} };
  for (let day = 1; day <= last; day++) {
    const d = ymd(month, day);
    let efet = 0;
    let pend = 0;
    for (const acc of accounts) {
      const anchor = acc.anchor ?? '0000-01-01';
      if (d >= (acc.anchor ?? '0000-00-00')) efet += acc.initial;
      for (const mv of moves) {
        if (mv.account_id !== acc.id) continue;
        if (mv.effective_date > d || mv.effective_date < anchor) continue;
        const signed = mv.direction === 'CREDIT' ? mv.amount_cents : -mv.amount_cents;
        if (mv.move_status === 'CONFIRMED') {
          if (mv.inst_status === 'PENDING') {
            // Parcela EM ABERTO de plano em CONTA do escopo — previsão pelo vencimento
            pend += signed;
            continue;
          }
          efet += signed;
        } else {
          // VOIDED: só a perna de TRANSFERÊNCIA futura (PENDING) vira previsão;
          // à vista pendente conta pela TRANSAÇÃO (pendTxs), não pelo movimento.
          if (mv.tx_status === 'PENDING' && mv.tx_type === 'TRANSFER') pend += signed;
        }
      }
      for (const p of pendTxs) {
        if (p.account_id !== acc.id) continue;
        if (p.occurred_on > d || p.occurred_on < anchor) continue;
        pend += p.type === 'INCOME' ? p.amount_cents : -p.amount_cents;
      }
    }
    for (const inv of invoices) {
      if (inv.due_date! <= d) pend -= inv.due;
    }
    out.efetivado[d] = efet;
    out.previsto[d] = efet + pend;
  }
  return out;
}

/** Compara os dois mapas dia a dia; devolve lista de divergências. */
export function diffDual(month: string, got: Dual, want: Dual): string[] {
  const errors: string[] = [];
  const last = lastDayOf(month);
  for (let day = 1; day <= last; day++) {
    const d = ymd(month, day);
    if (got.efetivado[d] !== want.efetivado[d]) {
      errors.push(`EFETIVADO ${d}: app=${got.efetivado[d]} oráculo=${want.efetivado[d]}`);
    }
    if (got.previsto[d] !== want.previsto[d]) {
      errors.push(`PREVISTO ${d}: app=${got.previsto[d]} oráculo=${want.previsto[d]}`);
    }
  }
  return errors;
}

/**
 * PIPELINE da tela Fluxo (o mesmo que o app roda a cada carga):
 * promoção de vencidas → recorrências → previsão até o mês → saldos.
 */
export async function fluxoPipeline(
  services: {
    transactions: { promoteDuePendings: (t?: string) => Promise<number> };
    recurrences: {
      runDueRecurrences: (t?: string) => Promise<unknown>;
      ensureForecastThrough: (m: string, t?: string) => Promise<unknown>;
    };
    balance: { getDailyBalancesDual: (m: string) => Promise<Dual> };
  },
  month: string,
  today: string
): Promise<Dual> {
  await services.transactions.promoteDuePendings(today);
  await services.recurrences.runDueRecurrences(today);
  await services.recurrences.ensureForecastThrough(month, today);
  return services.balance.getDailyBalancesDual(month);
}
