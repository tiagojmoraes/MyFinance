/** Repositórios de invoices, invoice_items e invoice_payments. */

import type { DbDriver } from '../db/types';

export interface InvoiceRow {
  id: string;
  card_id: string;
  reference_month: string; // YYYY-MM
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  total_cents: number;
  paid_cents: number;
  credit_from_prev_cents: number;
  status: 'OPEN' | 'CLOSED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';
}

export interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  transaction_id: string | null;
  installment_id: string | null;
  amount_cents: number;
}

export interface InvoicePaymentRow {
  id: string;
  invoice_id: string;
  from_account_id: string | null;
  amount_cents: number;
  paid_on: string | null;
  method: string | null;
  status: 'CONFIRMED' | 'VOIDED';
}

export class InvoiceRepo {
  constructor(private db: DbDriver) {}

  getById(id: string): Promise<InvoiceRow | null> {
    return this.db.getFirstAsync<InvoiceRow>('SELECT * FROM invoices WHERE id = ?', [id]);
  }

  getByCardAndMonth(cardId: string, referenceMonth: string): Promise<InvoiceRow | null> {
    return this.db.getFirstAsync<InvoiceRow>(
      'SELECT * FROM invoices WHERE card_id = ? AND reference_month = ?',
      [cardId, referenceMonth]
    );
  }

  listByCard(cardId: string): Promise<InvoiceRow[]> {
    return this.db.getAllAsync<InvoiceRow>(
      'SELECT * FROM invoices WHERE card_id = ? ORDER BY reference_month DESC',
      [cardId]
    );
  }

  /** Faturas em aberto (para alertas na tela Início). */
  listOpen(): Promise<(InvoiceRow & { card_name: string })[]> {
    return this.db.getAllAsync(
      `SELECT inv.*, c.name AS card_name
         FROM invoices inv JOIN cards c ON c.id = inv.card_id
        WHERE inv.status IN ('OPEN','PARTIALLY_PAID','OVERDUE')
        ORDER BY inv.due_date`
    );
  }

  insert(row: InvoiceRow): Promise<unknown> {
    return this.db.runAsync(
      `INSERT INTO invoices
        (id, card_id, reference_month, period_start, period_end, due_date, total_cents, paid_cents, credit_from_prev_cents, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.card_id, row.reference_month, row.period_start, row.period_end,
        row.due_date, row.total_cents, row.paid_cents, row.credit_from_prev_cents, row.status,
      ]
    );
  }

  updateTotals(id: string, patch: Partial<Pick<InvoiceRow, 'total_cents' | 'paid_cents' | 'credit_from_prev_cents' | 'status'>>): Promise<unknown> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.total_cents !== undefined) { sets.push('total_cents = ?'); params.push(patch.total_cents); }
    if (patch.paid_cents !== undefined) { sets.push('paid_cents = ?'); params.push(patch.paid_cents); }
    if (patch.credit_from_prev_cents !== undefined) { sets.push('credit_from_prev_cents = ?'); params.push(patch.credit_from_prev_cents); }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (!sets.length) return Promise.resolve({ changes: 0 });
    params.push(id);
    return this.db.runAsync(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`, params as never);
  }
}

export class InvoiceItemRepo {
  constructor(private db: DbDriver) {}

  /**
   * Itens da fatura com metadados para os marcadores visuais:
   *  - sequence_number / total_installments: pill preta "atual/total" (parcelados).
   *  - source_system: bolinha preta "✓" para itens vindos de conta fixa (RECURRENCE).
   * v21 (bugs 5 e 7): a descrição da PARCELA agora é a que o usuário digitou no
   *  Novo Lançamento — o SQL busca a descrição do PLANO (transação-âncora do
   *  parcelamento) quando o item é de parcela (transaction_id é null). A data
   *  também acompanha (vencimento da parcela quando não há compra). Era isto que
   *  fazia a fatura e o expansor do Fluxo mostrarem o texto genérico "Parcela".
   */
  getByInvoice(invoiceId: string): Promise<(InvoiceItemRow & {
    description: string | null;
    occurred_on: string | null;
    sequence_number: number | null;
    total_installments: number | null;
    source_system: string | null;
  })[]> {
    return this.db.getAllAsync(
      `SELECT ii.*,
              COALESCE(t.description, ta.description) AS description,
              COALESCE(t.occurred_on, ins.due_date) AS occurred_on,
              ins.sequence_number AS sequence_number,
              ip.total_installments AS total_installments,
              t.source_system AS source_system
         FROM invoice_items ii
         LEFT JOIN transactions t ON t.id = ii.transaction_id
         LEFT JOIN installments ins ON ins.id = ii.installment_id
         LEFT JOIN installment_plans ip ON ip.id = ins.plan_id
         LEFT JOIN transactions ta ON ta.id = ip.original_transaction_id
        WHERE ii.invoice_id = ?
        ORDER BY COALESCE(t.occurred_on, ins.due_date)`,
      [invoiceId]
    );
  }

  insert(row: InvoiceItemRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO invoice_items (id, invoice_id, transaction_id, installment_id, amount_cents) VALUES (?,?,?,?,?)',
      [row.id, row.invoice_id, row.transaction_id, row.installment_id, row.amount_cents]
    );
  }

  deleteById(id: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM invoice_items WHERE id = ?', [id]);
  }

  /** Reposiciona o item de fatura de uma parcela editada (v7.0.5). */
  updateAmountByInstallment(installmentId: string, amountCents: number): Promise<unknown> {
    return this.db.runAsync('UPDATE invoice_items SET amount_cents = ? WHERE installment_id = ?', [amountCents, installmentId]);
  }

  /** Item de fatura vinculado a uma parcela (para recalcular totais na edição — v7.0.5). */
  getByInstallment(installmentId: string): Promise<InvoiceItemRow | null> {
    return this.db.getFirstAsync<InvoiceItemRow>('SELECT * FROM invoice_items WHERE installment_id = ?', [installmentId]);
  }

  /** v9: item de fatura vinculado a uma transação (edição do lançamento). */
  getByTransaction(transactionId: string): Promise<InvoiceItemRow | null> {
    return this.db.getFirstAsync<InvoiceItemRow>('SELECT * FROM invoice_items WHERE transaction_id = ?', [transactionId]);
  }

  /** v9: reposiciona o item de fatura de uma compra editada. */
  updateAmountByTransaction(transactionId: string, amountCents: number): Promise<unknown> {
    return this.db.runAsync('UPDATE invoice_items SET amount_cents = ? WHERE transaction_id = ?', [amountCents, transactionId]);
  }

  deleteByTransaction(transactionId: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM invoice_items WHERE transaction_id = ?', [transactionId]);
  }

  deleteByInstallments(installmentIds: string[]): Promise<unknown> {
    if (!installmentIds.length) return Promise.resolve({ changes: 0 });
    const marks = installmentIds.map(() => '?').join(',');
    return this.db.runAsync(`DELETE FROM invoice_items WHERE installment_id IN (${marks})`, installmentIds as never);
  }

  sumByInvoice(invoiceId: string): Promise<number> {
    return this.db.getFirstAsync<{ total: number }>(
      'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoice_items WHERE invoice_id = ?',
      [invoiceId]
    ).then((r) => r?.total ?? 0);
  }
}

export class InvoicePaymentRepo {
  constructor(private db: DbDriver) {}

  getById(id: string): Promise<InvoicePaymentRow | null> {
    return this.db.getFirstAsync<InvoicePaymentRow>('SELECT * FROM invoice_payments WHERE id = ?', [id]);
  }

  getByInvoice(invoiceId: string): Promise<InvoicePaymentRow[]> {
    return this.db.getAllAsync<InvoicePaymentRow>(
      "SELECT * FROM invoice_payments WHERE invoice_id = ? AND status = 'CONFIRMED' ORDER BY paid_on",
      [invoiceId]
    );
  }

  /** Total pago (pagamentos CONFIRMED) da fatura — fonte do estorno (v10). */
  sumConfirmedByInvoice(invoiceId: string): Promise<number> {
    return this.db
      .getFirstAsync<{ total: number }>(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoice_payments WHERE invoice_id = ? AND status = 'CONFIRMED'",
        [invoiceId]
      )
      .then((r) => r?.total ?? 0);
  }

  insert(row: InvoicePaymentRow): Promise<unknown> {
    return this.db.runAsync(
      'INSERT INTO invoice_payments (id, invoice_id, from_account_id, amount_cents, paid_on, method, status) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.invoice_id, row.from_account_id, row.amount_cents, row.paid_on, row.method, row.status]
    );
  }

  /** v10: exclusão FÍSICA do pagamento (estorno do registro). */
  deleteById(id: string): Promise<unknown> {
    return this.db.runAsync('DELETE FROM invoice_payments WHERE id = ?', [id]);
  }
}
