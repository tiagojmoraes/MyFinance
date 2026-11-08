/** Repositórios de transactions, financial_moves, installment_plans e installments. */

import type { DbDriver } from '../db/types';

export interface TransactionRow {
  id: string;
  kind: 'SIMPLE' | 'CONSOLIDATED';
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  amount_cents: number;
  occurred_on: string;
  occurred_at: string;
  description: string;
  category_id: string | null;
  account_id: string | null;
  transfer_account_id: string | null;
  card_id: string | null;
  source_system: 'MANUAL' | 'OFX_BANK' | 'OFX_CARD' | 'NFCE' | 'RECURRENCE' | 'INSTALLMENT';
  external_ref_id: string | null;
  recurrence_rule_id: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'VOIDED';
  /** v7.1: lançamento-filho de um grupo consolidado manual (aponta para o cabeçalho). */
  parent_transaction_id?: string | null;
}

export interface FinancialMoveRow {
  id: string;
  transaction_id: string | null;
  installment_id: string | null;
  invoice_payment_id: string | null;
  account_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
  effective_date: string;
  status: 'CONFIRMED' | 'VOIDED';
}

export interface InstallmentPlanRow {
  id: string;
  original_transaction_id: string | null;
  total_installments: number;
  mode: 'DIVIDE_TOTAL' | 'FIXED_PER_MONTH';
  total_cents: number | null;
  fixed_amount_cents: number | null;
  first_due_date: string;
  card_id: string | null;
  account_id: string | null;
  /** v11: grupo consolidado que originou o plano (linha Parcelado do consolidado). */
  group_transaction_id?: string | null;
  /** v68 "Repetir": cadência das parcelas — meses entre parcelas (1=mensal,
   *  2=bimestral, 3=trimestral, 6=semestral, 12=anual). */
  step_months?: number;
  /** v68 "Repetir": cadência em dias (7=semanal). NULL = usa step_months. */
  step_days?: number | null;
}

export interface InstallmentRow {
  id: string;
  plan_id: string;
  sequence_number: number;
  amount_cents: number;
  due_date: string;
  invoice_id: string | null;
  status: 'PENDING' | 'PAID' | 'CANCELED';
}

export class TransactionRepo {
  constructor(private db: DbDriver) {}

  getById(id: string): Promise<TransactionRow | null> {
    return this.db.getFirstAsync<TransactionRow>('SELECT * FROM transactions WHERE id = ?', [id]);
  }

  /** Idempotência ARQ-003: checa (source_system, external_ref_id) antes de inserir. */
  findByExternalRef(source: string, externalRef: string): Promise<TransactionRow | null> {
    return this.db.getFirstAsync<TransactionRow>(
      'SELECT * FROM transactions WHERE source_system = ? AND external_ref_id = ? LIMIT 1',
      [source, externalRef]
    );
  }

  insert(row: TransactionRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO transactions
        (id, kind, type, amount_cents, occurred_on, occurred_at, description, category_id,
         account_id, transfer_account_id, card_id, source_system, external_ref_id, recurrence_rule_id, status, parent_transaction_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.kind, row.type, row.amount_cents, row.occurred_on, row.occurred_at,
        row.description, row.category_id, row.account_id, row.transfer_account_id,
        row.card_id, row.source_system, row.external_ref_id, row.recurrence_rule_id, row.status,
        row.parent_transaction_id ?? null,
      ]
    );
  }

  setStatus(id: string, status: TransactionRow['status']): Promise<unknown> {
    return this.db.runAsync('UPDATE transactions SET status = ? WHERE id = ?', [status, id]);
  }

  /** v10: exclusão FÍSICA — o registro sai definitivamente do banco (sem marca "Cancelado"). */
  delete(id: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM transactions WHERE id = ?', [id]);
  }

  setCategory(id: string, categoryId: string | null): Promise<unknown> {
    return this.db.runAsync('UPDATE transactions SET category_id = ? WHERE id = ?', [categoryId, id]);
  }

  /** Recalcula o total do lançamento consolidado (edição de parcelas — v7.0.5). */
  updateAmount(id: string, amountCents: number): Promise<unknown> {
    return this.db.runAsync('UPDATE transactions SET amount_cents = ? WHERE id = ?', [amountCents, id]);
  }

  /**
   * Lista mensal consolidada (evento + metadados para a tela Fluxo).
   * Extras para marcadores visuais:
   *  - recurrence_rule_id / source_system: bolinha preta "✓" (conta fixa).
   *  - plan_total_installments + plan_paid_count: pill preta "atual/total" (parcelado).
   * v7.1: child_count/group_debits/group_credits identificam GRUPOS consolidados
   *  (cabeçalho com seta expandir/recolher); filhos saem da lista raiz.
   */
  listMonth(month: string, kindFilter?: 'INCOME' | 'EXPENSE'): Promise<(TransactionRow & {
    category_name: string | null;
    account_name: string | null;
    card_name: string | null;
    transfer_account_name: string | null;
    plan_id: string | null;
    plan_total_installments: number | null;
    plan_paid_count: number | null;
    child_count: number;
    group_debits_cents: number;
    group_credits_cents: number;
  })[]> {
    const where: string[] = ["substr(t.occurred_on, 1, 7) = ?", 't.parent_transaction_id IS NULL'];
    const params: unknown[] = [month];
    if (kindFilter === 'INCOME') where.push("t.type = 'INCOME'");
    if (kindFilter === 'EXPENSE') where.push("t.type IN ('EXPENSE','TRANSFER')");
    return this.db.getAllAsync(
      `SELECT t.*, c.name AS category_name, a.name AS account_name,
              cd.name AS card_name, ta.name AS transfer_account_name,
              ip.id AS plan_id,
              ip.total_installments AS plan_total_installments,
              (SELECT COUNT(*) FROM installments i
                WHERE i.plan_id = ip.id AND i.status = 'PAID') AS plan_paid_count,
              (SELECT COUNT(*) FROM transactions ch
                WHERE ch.parent_transaction_id = t.id AND ch.status != 'VOIDED') AS child_count,
              (SELECT COALESCE(SUM(ch.amount_cents), 0) FROM transactions ch
                WHERE ch.parent_transaction_id = t.id AND ch.type = 'EXPENSE' AND ch.status != 'VOIDED') AS group_debits_cents,
              (SELECT COALESCE(SUM(ch.amount_cents), 0) FROM transactions ch
                WHERE ch.parent_transaction_id = t.id AND ch.type = 'INCOME' AND ch.status != 'VOIDED') AS group_credits_cents
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN cards cd ON cd.id = t.card_id
         LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
         LEFT JOIN installment_plans ip ON ip.original_transaction_id = t.id
        WHERE ${where.join(' AND ')}
        ORDER BY t.occurred_on DESC, t.occurred_at DESC`,
      params as never
    );
  }

  /** v7.1: lançamentos-filhos de um grupo consolidado (expansão na tela Fluxo). */
  listChildren(parentId: string): Promise<(TransactionRow & {
    category_name: string | null;
    account_name: string | null;
    card_name: string | null;
    transfer_account_name: string | null;
    plan_id: string | null;
    plan_total_installments: number | null;
    plan_paid_count: number | null;
    child_count: number;
    group_debits_cents: number;
    group_credits_cents: number;
  })[]> {
    return this.db.getAllAsync(
      `SELECT t.*, c.name AS category_name, a.name AS account_name,
              cd.name AS card_name, ta.name AS transfer_account_name,
              NULL AS plan_id, NULL AS plan_total_installments, NULL AS plan_paid_count,
              0 AS child_count, 0 AS group_debits_cents, 0 AS group_credits_cents
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN cards cd ON cd.id = t.card_id
         LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
        WHERE t.parent_transaction_id = ?
        ORDER BY t.type DESC, t.amount_cents DESC`,
      [parentId]
    );
  }
}

export class FinancialMoveRepo {
  constructor(private db: DbDriver) {}

  insert(row: FinancialMoveRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO financial_moves
        (id, transaction_id, installment_id, invoice_payment_id, account_id, direction, amount_cents, effective_date, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.transaction_id, row.installment_id, row.invoice_payment_id,
        row.account_id, row.direction, row.amount_cents, row.effective_date, row.status,
      ]
    );
  }

  getByTransaction(transactionId: string): Promise<FinancialMoveRow[]> {
    return this.db.getAllAsync<FinancialMoveRow>(
      'SELECT * FROM financial_moves WHERE transaction_id = ?',
      [transactionId]
    );
  }

  /** v9: atualiza conta/valor/data de um movimento (edição do lançamento — Alterar). */
  updateMove(id: string, patch: { account_id?: string; amount_cents?: number; effective_date?: string }): Promise<unknown> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.account_id !== undefined) { sets.push('account_id = ?'); params.push(patch.account_id); }
    if (patch.amount_cents !== undefined) { sets.push('amount_cents = ?'); params.push(patch.amount_cents); }
    if (patch.effective_date !== undefined) { sets.push('effective_date = ?'); params.push(patch.effective_date); }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(id);
    return this.db.runAsync(`UPDATE financial_moves SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }

  getByInstallment(installmentId: string): Promise<FinancialMoveRow[]> {
    return this.db.getAllAsync<FinancialMoveRow>(
      'SELECT * FROM financial_moves WHERE installment_id = ?',
      [installmentId]
    );
  }

  voidByTransaction(transactionId: string): Promise<unknown> {
    return this.db.runAsync(
      "UPDATE financial_moves SET status = 'VOIDED' WHERE transaction_id = ? AND status = 'CONFIRMED'",
      [transactionId]
    );
  }

  /** v10: exclusão física — remove TODOS os movimentos da transação (qualquer status). */
  deleteByTransaction(transactionId: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM financial_moves WHERE transaction_id = ?', [transactionId]);
  }

  /** v10: exclusão física — remove TODOS os movimentos da parcela (qualquer status). */
  deleteByInstallment(installmentId: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM financial_moves WHERE installment_id = ?', [installmentId]);
  }

  voidByInstallment(installmentId: string): Promise<unknown> {
    return this.db.runAsync(
      "UPDATE financial_moves SET status = 'VOIDED' WHERE installment_id = ? AND status = 'CONFIRMED'",
      [installmentId]
    );
  }

  /** Reposiciona o débito future-dated da parcela em planos na CONTA (v7.0.5). */
  updateAmountByInstallment(installmentId: string, amountCents: number): Promise<unknown> {
    return this.db.runAsync('UPDATE financial_moves SET amount_cents = ? WHERE installment_id = ?', [amountCents, installmentId]);
  }

  /** v21 (bug 1): desloca o vencimento do movimento da parcela (edição da data
   *  da 1ª parcela em aberto — o previsto da conta acompanha). */
  updateDateByInstallment(installmentId: string, effectiveDate: string): Promise<unknown> {
    return this.db.runAsync('UPDATE financial_moves SET effective_date = ? WHERE installment_id = ?', [effectiveDate, installmentId]);
  }

  /** Reposiciona o move da competência atual de uma conta fixa (v7.0.5). */
  updateAmountByTransaction(transactionId: string, amountCents: number): Promise<unknown> {
    return this.db.runAsync('UPDATE financial_moves SET amount_cents = ? WHERE transaction_id = ?', [amountCents, transactionId]);
  }

  voidByInvoicePayment(invoicePaymentId: string): Promise<unknown> {
    return this.db.runAsync(
      "UPDATE financial_moves SET status = 'VOIDED' WHERE invoice_payment_id = ? AND status = 'CONFIRMED'",
      [invoicePaymentId]
    );
  }

  /** v10: estorno de pagamento de fatura — remove os movimentos do pagamento (exclusão física). */
  deleteByInvoicePayment(invoicePaymentId: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM financial_moves WHERE invoice_payment_id = ?', [invoicePaymentId]);
  }

  listMonth(month: string): Promise<(FinancialMoveRow & { account_name: string })[]> {
    return this.db.getAllAsync(
      `SELECT fm.*, a.name AS account_name
         FROM financial_moves fm
         JOIN accounts a ON a.id = fm.account_id
        WHERE substr(fm.effective_date, 1, 7) = ? AND fm.status = 'CONFIRMED'
        ORDER BY fm.effective_date`,
      [month]
    );
  }
}

export class InstallmentPlanRepo {
  constructor(private db: DbDriver) {}

  getById(id: string): Promise<InstallmentPlanRow | null> {
    return this.db.getFirstAsync<InstallmentPlanRow>('SELECT * FROM installment_plans WHERE id = ?', [id]);
  }

  insert(row: InstallmentPlanRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO installment_plans
        (id, original_transaction_id, total_installments, mode, total_cents, fixed_amount_cents, first_due_date, card_id, account_id, group_transaction_id, step_months, step_days)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.original_transaction_id, row.total_installments, row.mode,
        row.total_cents, row.fixed_amount_cents, row.first_due_date, row.card_id, row.account_id,
        row.group_transaction_id ?? null, row.step_months ?? 1, row.step_days ?? null,
      ]
    );
  }

  /** Reposiciona os valores do plano após edição da atual em diante (v7.0.5). */
  updateAmounts(id: string, totalCents: number | null, fixedAmountCents: number | null): Promise<unknown> {
    return this.db.runAsync('UPDATE installment_plans SET total_cents = ?, fixed_amount_cents = ? WHERE id = ?', [totalCents, fixedAmountCents, id]);
  }

  /** v17 (bug 3): troca o modo de cálculo na edição "da atual em diante"
   *  (Dividir total ⇄ Parcela fixa — mesma escolha do Novo Lançamento). */
  setMode(id: string, mode: InstallmentPlanRow['mode']): Promise<unknown> {
    return this.db.runAsync('UPDATE installment_plans SET mode = ? WHERE id = ?', [mode, id]);
  }

  /** v21 (bug 1): troca o DESTINO do plano (conta ⇄ cartão) — XOR do schema. */
  updateTarget(id: string, accountId: string | null, cardId: string | null): Promise<unknown> {
    return this.db.runAsync('UPDATE installment_plans SET account_id = ?, card_id = ? WHERE id = ?', [accountId, cardId, id]);
  }

  /** v10: apaga o plano (usado quando não sobra nenhuma parcela). */
  deletePlan(id: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM installment_plans WHERE id = ?', [id]);
  }

  /** v10: separa o plano da transação original excluída (mantém o histórico pago). */
  detachOriginal(id: string): Promise<unknown> {
    return this.db.runAsync('UPDATE installment_plans SET original_transaction_id = NULL WHERE id = ?', [id]);
  }

  listWithSummary(): Promise<(InstallmentPlanRow & {
    description: string;
    paid_count: number;
  })[]> {
    return this.db.getAllAsync(
      `SELECT p.*, t.description AS description,
              (SELECT COUNT(*) FROM installments i WHERE i.plan_id = p.id AND i.status = 'PAID') AS paid_count
         FROM installment_plans p
         LEFT JOIN transactions t ON t.id = p.original_transaction_id
        ORDER BY p.first_due_date`
    );
  }
}

export class InstallmentRepo {
  constructor(private db: DbDriver) {}

  getByPlan(planId: string): Promise<InstallmentRow[]> {
    return this.db.getAllAsync<InstallmentRow>(
      'SELECT * FROM installments WHERE plan_id = ? ORDER BY sequence_number',
      [planId]
    );
  }

  getById(id: string): Promise<InstallmentRow | null> {
    return this.db.getFirstAsync<InstallmentRow>('SELECT * FROM installments WHERE id = ?', [id]);
  }

  insert(row: InstallmentRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO installments (id, plan_id, sequence_number, amount_cents, due_date, invoice_id, status) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.plan_id, row.sequence_number, row.amount_cents, row.due_date, row.invoice_id, row.status]
    );
  }

  setStatus(id: string, status: InstallmentRow['status']): Promise<unknown> {
    return this.db.runAsync('UPDATE installments SET status = ? WHERE id = ?', [status, id]);
  }

  setInvoiceId(id: string, invoiceId: string | null): Promise<unknown> {
    return this.db.runAsync('UPDATE installments SET invoice_id = ? WHERE id = ?', [invoiceId, id]);
  }

  /** Reavalia o valor só das parcelas pendentes (edição da atual em diante — v7.0.5). */
  updateAmount(id: string, amountCents: number): Promise<unknown> {
    return this.db.runAsync('UPDATE installments SET amount_cents = ? WHERE id = ?', [amountCents, id]);
  }

  /** v21 (bug 1): desloca o vencimento da parcela (edição da data da 1ª em aberto). */
  updateDueDate(id: string, dueDate: string): Promise<unknown> {
    return this.db.runAsync('UPDATE installments SET due_date = ? WHERE id = ?', [dueDate, id]);
  }

  markPaidByInvoice(invoiceId: string): Promise<unknown> {
    return this.db.runAsync(
      "UPDATE installments SET status = 'PAID' WHERE invoice_id = ? AND status = 'PENDING'",
      [invoiceId]
    );
  }

  /** v10: estorno — a fatura deixou de estar quitada; parcelas voltam a PENDING. */
  unmarkPaidByInvoice(invoiceId: string): Promise<unknown> {
    return this.db.runAsync(
      "UPDATE installments SET status = 'PENDING' WHERE invoice_id = ? AND status = 'PAID'",
      [invoiceId]
    );
  }

  cancelByPlan(planId: string): Promise<unknown> {
    return this.db.runAsync(
      "UPDATE installments SET status = 'CANCELED' WHERE plan_id = ? AND status = 'PENDING'",
      [planId]
    );
  }

  /** v10: exclusão física da parcela (movimentos e itens derivados já removidos antes). */
  delete(id: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM installments WHERE id = ?', [id]);
  }

  /** v10: conta quantas parcelas o plano ainda tem. */
  countByPlan(planId: string): Promise<number> {
    return this.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM installments WHERE plan_id = ?',
      [planId]
    ).then((r) => r?.n ?? 0);
  }
}
